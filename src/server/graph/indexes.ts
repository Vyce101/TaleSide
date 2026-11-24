import { addAbortListener } from "node:events";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { all, get, run } from "../sqlite.js";
import { graphPaths, type GraphContext, type GraphQuery } from "./index-protocol.js";

export class GraphIndexes {
  private directory: string;
  private readers = new Map<number, Worker>();
  private leases = new Map<number, number>();
  private builds = new Map<number, { promise: Promise<void>; controller: AbortController }>();
  private latest?: number;

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
    return new Worker(new URL("./worker.js", import.meta.url),
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

  capture(id: number | null) {
    if (id === null) return;
    this.latest = id;
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    this.evict();
    let closed = false;
    return {
      search: async (query: GraphQuery, signal: AbortSignal) => {
        await this.build(id, signal);
        signal.throwIfAborted();
        let worker = this.readers.get(id);
        if (!worker) {
          worker = this.worker(id);
          this.readers.set(id, worker);
          worker.once("error", () => {});
          worker.once("exit", () => { if (this.readers.get(id) === worker) this.readers.delete(id); });
        }
        return this.request<GraphContext>(worker, { operation: "search", query }, signal);
      },
      close: () => {
        if (closed) return;
        closed = true;
        const count = this.leases.get(id)! - 1;
        if (count) this.leases.set(id, count);
        else this.leases.delete(id);
        this.collect();
      },
    };
  }

  private remove(id: number, temp = false) {
    for (const file of Object.values(graphPaths(this.directory, id))) {
      try { unlinkSync(temp ? file + ".tmp" : file); }
      catch { /* Windows may still be releasing a mapped file. Startup also removes orphaned files. */ }
    }
  }

  private evict() {
    for (const [id, worker] of this.readers) {
      if (this.leases.has(id)) continue;
      if (id === this.latest && get(this.db, "SELECT 1 FROM worlds WHERE graph_published = ?", id)) continue;
      this.readers.delete(id);
      void worker.terminate().then(() => {
        if (!this.leases.has(id) && !get(this.db, "SELECT 1 FROM graph_generations WHERE id = ?", id)) this.remove(id);
      }).catch(() => {});
    }
  }

  collect() {
    for (const { id } of all<{ id: number }>(this.db, `
      SELECT g.id FROM graph_generations g WHERE NOT EXISTS (
        SELECT 1 FROM worlds w WHERE w.id = g.world_id AND (w.graph_base = g.id OR w.graph_building = g.id OR w.graph_published = g.id)
      )
    `)) {
      if (this.leases.has(id) || this.builds.has(id)) continue;
      run(this.db, "DELETE FROM graph_generations WHERE id = ?", id);
      if (!this.readers.has(id)) this.remove(id);
    }
    this.evict();
  }

  discard(ids: number[]) {
    for (const id of ids) {
      const worker = this.readers.get(id);
      if (worker) {
        this.readers.delete(id);
        void worker.terminate().then(() => this.remove(id)).catch(() => {});
      } else {
        const build = this.builds.get(id);
        build?.controller.abort();
        void (build?.promise ?? Promise.resolve()).catch(() => {}).then(() => {
          this.remove(id);
          this.remove(id, true);
        });
      }
    }
  }

  async close() {
    for (const build of this.builds.values()) build.controller.abort();
    await Promise.allSettled([
      ...[...this.readers.values()].map(worker => worker.terminate()),
      ...[...this.builds.values()].map(build => build.promise),
    ]);
    this.readers.clear();
  }
}
