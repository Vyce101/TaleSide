import { addAbortListener } from "node:events";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { all, run } from "./database.js";

export function graphPaths(directory: string, id: number) {
  return {
    entities: join(directory, `${id}.entities.usearch`),
    edges: join(directory, `${id}.edges.usearch`),
    vectors: join(directory, `${id}.edges.f16`),
  };
}

export class GraphIndexes {
  private directory: string;
  private builds = new Map<number, { promise: Promise<void>; controller: AbortController }>();

  constructor(private db: DatabaseSync, private database: string) {
    this.directory = database + ".graph";
    this.collect();
    if (!existsSync(this.directory)) return;
    const live = new Set(all<{ id: number }>(db, "SELECT id FROM graph_generations").map(row => row.id));
    for (const filename of readdirSync(this.directory)) {
      const match = /^(\d+)\.(?:entities\.usearch|edges\.usearch|edges\.f16)(\.tmp)?$/.exec(filename);
      if (match && (match[2] || !live.has(Number(match[1])))) this.remove(Number(match[1]), !!match[2]);
    }
  }

  private worker(generation: number) {
    return new Worker(new URL("./graph-worker.js", import.meta.url),
      { workerData: { database: this.database, directory: this.directory, generation } });
  }

  private request<T>(worker: Worker, message: object, signal: AbortSignal) {
    signal.throwIfAborted();
    const { port1, port2 } = new MessageChannel();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => finish(signal.reason);
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("The World graph worker stopped."));
      const finish = (error?: unknown, value?: T) => {
        signal.removeEventListener("abort", onAbort);
        worker.off("error", onError);
        worker.off("exit", onExit);
        port1.close();
        if (error) reject(error);
        else resolve(value as T);
      };
      worker.once("error", onError);
      worker.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      port1.once("message", ({ value, error }: { value?: T; error?: string }) => finish(error && new Error(error), value));
      try { worker.postMessage({ ...message, port: port2 }, [port2]); }
      catch (error) { port2.close(); finish(error); }
    });
  }

  async build(id: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (Object.values(graphPaths(this.directory, id)).every(existsSync)) return;
    let build = this.builds.get(id);
    if (!build) {
      const worker = this.worker(id);
      const controller = new AbortController();
      const promise = this.request<void>(worker, { operation: "build" }, controller.signal).finally(async () => {
        await worker.terminate();
        this.builds.delete(id);
      });
      build = { promise, controller };
      this.builds.set(id, build);
    }
    let abort!: ReturnType<typeof addAbortListener>;
    const stopped = new Promise<never>((_resolve, reject) => { abort = addAbortListener(signal, () => reject(signal.reason)); });
    try { await Promise.race([build.promise, stopped]); }
    finally { abort[Symbol.dispose](); }
  }

  private remove(id: number, temp = false) {
    for (const file of Object.values(graphPaths(this.directory, id))) {
      try { unlinkSync(temp ? file + ".tmp" : file); }
      catch { /* Windows may still be releasing a mapped file. Startup also removes orphaned files. */ }
    }
  }

  collect() {
    for (const { id } of all<{ id: number }>(this.db, `
      SELECT g.id FROM graph_generations g WHERE NOT EXISTS (
        SELECT 1 FROM worlds w WHERE w.id = g.world_id AND (w.graph_base = g.id OR w.graph_building = g.id OR w.graph_published = g.id)
      )
    `)) {
      if (this.builds.has(id)) continue;
      run(this.db, "DELETE FROM graph_generations WHERE id = ?", id);
      this.remove(id);
    }
  }

  discard(ids: number[]) {
    for (const id of ids) {
      const build = this.builds.get(id);
      build?.controller.abort();
      void (build?.promise ?? Promise.resolve()).catch(() => {}).then(() => {
        this.remove(id);
        this.remove(id, true);
      });
    }
  }

  async close() {
    for (const build of this.builds.values()) build.controller.abort();
    await Promise.allSettled([...this.builds.values()].map(build => build.promise));
  }
}
