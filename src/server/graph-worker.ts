import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { graphPaths } from "./graph-indexes.js";
import { VectorIndex } from "./graph-vector-index.js";

const { database, directory, generation } = workerData as { database: string; directory: string; generation: number };
const db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
const paths = graphPaths(directory, generation);
const { dimensions } = db.prepare("SELECT dimensions FROM graph_generations WHERE id = ?")
  .get(generation) as { dimensions: number };

function build() {
  mkdirSync(directory, { recursive: true });
  const index = new VectorIndex(dimensions);
  const unfinished = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, path + ".tmp"])) as typeof paths;
  const fd = openSync(unfinished.vectors, "w");
  try {
    const rows = db.prepare("SELECT id, type, vector FROM graph_records WHERE generation = ? ORDER BY id")
      .iterate(generation) as Iterable<{ id: number; type: string | null; vector: Uint8Array }>;
    for (const row of rows) {
      const vector = new Float32Array(Uint8Array.from(row.vector).buffer);
      index.add(row.id, row.type !== null, vector);
      if (row.type === null) {
        const buffer = new Uint8Array(Float16Array.from(vector).buffer);
        let written = 0;
        while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
      }
    }
    fsyncSync(fd);
    closeSync(fd);
    index.save(unfinished);
    for (const path of [unfinished.entities, unfinished.edges]) {
      const saved = openSync(path, "r+");
      try { fsyncSync(saved); } finally { closeSync(saved); }
    }
    for (const key of ["entities", "edges", "vectors"] as const) renameSync(unfinished[key], paths[key]);
  } catch (error) {
    try { closeSync(fd); } catch { /* Already closed. */ }
    for (const path of Object.values(unfinished)) {
      try { unlinkSync(path); } catch { /* The file might not have been created. */ }
    }
    throw error;
  }
}

parentPort!.on("message", ({ port }: { port: MessagePort }) => {
  try {
    build();
    port.postMessage({ value: undefined });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : "Could not read the World graph." });
  } finally { port.close(); }
});
