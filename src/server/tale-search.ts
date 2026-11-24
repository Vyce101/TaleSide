import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SearchSpan } from "../shared/types.js";
import { all } from "./sqlite.js";

export function installTaleSearch(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE tale_search_sources (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT NOT NULL, UNIQUE(kind, source_id)
    );
    CREATE VIRTUAL TABLE tale_search USING fts5(title, world, message, tokenize = 'unicode61 remove_diacritics 2');
  `);
  for (const [table, column, indexed] of [
    ["tales", "title", "title"], ["worlds", "name", "world"], ["tale_messages", "content", "message"],
  ]) {
    const lookup = (row: string) => `SELECT id FROM tale_search_sources WHERE kind = '${indexed}' AND source_id = ${row}.id`;
    db.exec(`
      INSERT INTO tale_search_sources (kind, source_id) SELECT '${indexed}', id FROM ${table};
      INSERT INTO tale_search (rowid, ${indexed})
        SELECT s.id, t.${column} FROM ${table} t JOIN tale_search_sources s ON s.kind = '${indexed}' AND s.source_id = t.id;
      CREATE TRIGGER search_${indexed}_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO tale_search_sources (kind, source_id) VALUES ('${indexed}', new.id);
        INSERT INTO tale_search (rowid, ${indexed}) VALUES ((${lookup("new")}), new.${column});
      END;
      CREATE TRIGGER search_${indexed}_update AFTER UPDATE OF ${column} ON ${table}
        WHEN old.${column} IS NOT new.${column} BEGIN
        UPDATE tale_search SET ${indexed} = new.${column} WHERE rowid = (${lookup("new")});
      END;
      CREATE TRIGGER search_${indexed}_delete AFTER DELETE ON ${table} BEGIN
        DELETE FROM tale_search WHERE rowid = (${lookup("old")});
        DELETE FROM tale_search_sources WHERE id = (${lookup("old")});
      END;
    `);
  }
}

export function searchTales<Row>(db: DatabaseSync, summarySql: string, query: string, worldId: string | null) {
  const words = query.normalize("NFC").match(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{M}\p{Co}]*/gu);
  if (!words) return [];
  const terms = words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" AND ");
  const marker = randomUUID();
  const rows = all<Row & { match_text: string | null }>(db, `
    WITH hits AS MATERIALIZED (
      SELECT s.kind, s.source_id, s.id,
        bm25(tale_search, 10.0, 3.0, 1.0) AS score
      FROM tale_search JOIN tale_search_sources s ON s.id = tale_search.rowid
      WHERE tale_search MATCH ? AND (? IS NULL OR s.kind <> 'world')
    ), candidates AS (
      SELECT t.id AS tale_id, h.id, 0 AS priority, score FROM hits h JOIN tales t ON t.id = h.source_id WHERE h.kind = 'title'
      UNION ALL
      SELECT t.id, h.id, 1, score FROM hits h JOIN tales t ON t.world_id = h.source_id WHERE h.kind = 'world'
      UNION ALL
      SELECT m.tale_id, h.id, 2, score FROM hits h JOIN tale_messages m ON m.id = CAST(h.source_id AS INTEGER)
        WHERE h.kind = 'message'
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY tale_id ORDER BY priority, score, id DESC) AS position FROM candidates
    )
    SELECT listed.*, CASE WHEN ranked.priority = 2 THEN (
      SELECT snippet(tale_search, 2, ?, ?, '…', 24) FROM tale_search
      WHERE tale_search MATCH ? AND rowid = ranked.id
    ) END AS match_text
    FROM (${summarySql}) listed JOIN ranked ON ranked.tale_id = listed.id AND ranked.position = 1
    WHERE (? IS NULL OR listed.world_id = ?)
    ORDER BY ranked.priority, ranked.score, coalesce(listed.last_activity_at, listed.created_at) DESC, listed.id
  `, terms, worldId, marker, marker, terms, worldId, worldId);
  return rows.map(({ match_text, ...row }) => {
    const match: SearchSpan[] | undefined = match_text?.split(marker).map((text, index) => ({ text, highlighted: index % 2 === 1 }));
    return { ...row as Row, match };
  });
}
