import type { DatabaseSync } from "node:sqlite";

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
