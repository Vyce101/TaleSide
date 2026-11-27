import type { DatabaseSync } from "node:sqlite";
import type { World } from "../../shared/types.js";
import { get } from "../sqlite.js";
import { RequestError } from "../validation.js";

export type GraphWorldFields = { graph_settings: string | null; graph_published: number | null;
  graph_base: number | null; graph_building: number | null };

// Chunk readers bind the overlap limit to all three placeholders.
export const precedingChunkTextSql = `CASE WHEN previous.number IS NULL OR ? = 0 THEN '' ELSE
  substr(b.working, max(previous.start, c.start - ?) + 1, min(?, c.start - previous.start)) END`;

export type WorldRow = Pick<World, "id" | "name" | "status" | "model" | "dimensions" | "max_token_limit"
  | "max_chunk_size" | "book_revision" | "error"> & GraphWorldFields & { index_number: number; description: string | null; openings: string | null };

export const worldColumns = `id, name, status, model, dimensions, max_token_limit, max_chunk_size, book_revision, index_number,
  error, description, openings, graph_settings, graph_published, graph_base, graph_building`;

export function requireWorld(db: DatabaseSync, id: string) {
  const world = get<WorldRow>(db, `SELECT ${worldColumns} FROM worlds WHERE id = ? AND status <> 'draft'`, id);
  if (!world) throw new RequestError("This World could not be found.", 404);
  return world;
}
