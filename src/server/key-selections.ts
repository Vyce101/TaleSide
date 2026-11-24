import type { DatabaseSync } from "node:sqlite";
import { all, run } from "./sqlite.js";

export const selections = {
  embedding_default_keys: ["embedding_defaults", "INTEGER", "key_id"],
  world_embedding_keys: ["worlds", "TEXT", "key_id"],
  world_retrieval_keys: ["worlds", "TEXT", "retrieval_key_id"],
  chat_profile_keys: ["chat_profiles", "TEXT", "chat_key_id"],
  tale_chat_keys: ["tale_settings", "INTEGER", "chat_key_id"],
} as const;
type Selection = keyof typeof selections | "world_extraction_keys";

export function selectedKeys(db: DatabaseSync, table: Selection, owner: string | number) {
  return all<{ key_id: string }>(db, `SELECT key_id FROM ${table} WHERE owner_id = ? ORDER BY position`, owner)
    .map(row => row.key_id);
}

export function saveSelection(db: DatabaseSync, table: Selection, owner: string | number, keys: string[]) {
  run(db, `DELETE FROM ${table} WHERE owner_id = ?`, owner);
  const insert = db.prepare(`INSERT INTO ${table} (owner_id, key_id, position) VALUES (?, ?, ?)`);
  keys.forEach((key, position) => insert.run(owner, key, position));
}
