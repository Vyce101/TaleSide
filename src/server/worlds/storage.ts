import type { DatabaseSync } from "node:sqlite";
import type { World } from "../../shared/types.js";
import type { GraphWorldFields } from "../graph/jobs.js";
import { get } from "../sqlite.js";
import { RequestError } from "../validation.js";

export type WorldRow = Pick<World, "id" | "name" | "status" | "model" | "dimensions" | "max_token_limit"
  | "max_chunk_size" | "book_revision" | "error"> & GraphWorldFields & { index_number: number; description: string | null; openings: string | null };

export const worldColumns = `id, name, status, model, dimensions, max_token_limit, max_chunk_size, book_revision, index_number,
  error, description, openings, graph_settings, graph_published, graph_base, graph_building`;

export function requireWorld(db: DatabaseSync, id: string) {
  const world = get<WorldRow>(db, `SELECT ${worldColumns} FROM worlds WHERE id = ? AND status <> 'draft'`, id);
  if (!world) throw new RequestError("This World could not be found.", 404);
  return world;
}
