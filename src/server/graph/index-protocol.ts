import { join } from "node:path";
import type { ChatSettings } from "../../shared/types.js";

export type GraphContext = { entities: number; relationships: number; notes: string[] };
export type GraphQuery = Pick<ChatSettings, "graph_budget" | "graph_matches" | "graph_hops" | "graph_edges">
  & { vector: number[]; text: string };

export function graphPaths(directory: string, id: number) {
  return {
    entities: join(directory, `${id}.entities.usearch`),
    edges: join(directory, `${id}.edges.usearch`),
    vectors: join(directory, `${id}.edges.f16`),
  };
}
