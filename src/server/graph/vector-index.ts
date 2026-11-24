import { openSync, readSync } from "node:fs";
import { Index, MetricKind, ScalarKind } from "usearch";
import type { graphPaths } from "./index-protocol.js";

export class VectorIndex {
  private entities: Index;
  private edges: Index;
  private vectorFile?: number;
  private strengthVector: Float16Array;

  constructor(private dimensions: number) {
    this.entities = new Index(dimensions, MetricKind.Cos, ScalarKind.F16);
    this.edges = new Index(dimensions, MetricKind.Cos, ScalarKind.F16);
    this.strengthVector = new Float16Array(dimensions);
  }

  add(id: number, entity: boolean, vector: Float32Array) {
    (entity ? this.entities : this.edges).add(BigInt(id), vector);
  }

  save(paths: ReturnType<typeof graphPaths>) {
    this.entities.save(paths.entities);
    this.edges.save(paths.edges);
  }

  view(paths: ReturnType<typeof graphPaths>, entities: number, edges: number) {
    if (entities) this.entities.view(paths.entities);
    if (edges) {
      this.edges.view(paths.edges);
      this.vectorFile = openSync(paths.vectors, "r");
    }
  }

  search(vector: Float32Array, limit: number) {
    const hits: { id: number; similarity: number }[] = [];
    for (const index of [this.entities, this.edges]) {
      const count = Math.min(limit, index.size());
      if (!count) continue;
      const matches = index.search(vector, count, 1);
      for (const [position, id] of matches.keys.entries()) {
        hits.push({ id: Number(id), similarity: 1 - matches.distances[position] });
      }
    }
    return hits.sort((a, b) => b.similarity - a.similarity || a.id - b.id).slice(0, limit);
  }

  get_vector(position: number) {
    const view = new Uint8Array(this.strengthVector.buffer);
    if (this.vectorFile === undefined || readSync(this.vectorFile, view, 0, view.length, position * this.dimensions * 2) !== view.length) {
      throw new Error("Could not read the saved graph vectors.");
    }
    return this.strengthVector;
  }

}
