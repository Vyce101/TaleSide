import { Index, MetricKind, ScalarKind } from "usearch";
import type { graphPaths } from "./graph-indexes.js";

export class VectorIndex {
  private entities: Index;
  private edges: Index;

  constructor(dimensions: number) {
    this.entities = new Index(dimensions, MetricKind.Cos, ScalarKind.F16);
    this.edges = new Index(dimensions, MetricKind.Cos, ScalarKind.F16);
  }

  add(id: number, entity: boolean, vector: Float32Array) {
    (entity ? this.entities : this.edges).add(BigInt(id), vector);
  }

  save(paths: ReturnType<typeof graphPaths>) {
    this.entities.save(paths.entities);
    this.edges.save(paths.edges);
  }

}
