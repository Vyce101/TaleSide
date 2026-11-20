import { existsSync } from "node:fs";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";

const booksSchema = `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY, world_id TEXT REFERENCES worlds ON DELETE CASCADE, number INTEGER NOT NULL,
  name TEXT NOT NULL, filename TEXT NOT NULL, original BLOB NOT NULL, working TEXT NOT NULL,
  encoding TEXT NOT NULL, bom_size INTEGER NOT NULL, UNIQUE (world_id, number)
);
CREATE TABLE IF NOT EXISTS chunks (
  book_id TEXT NOT NULL REFERENCES books ON DELETE CASCADE, index_number INTEGER NOT NULL,
  number INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  original_start INTEGER NOT NULL, original_end INTEGER NOT NULL, tokens INTEGER NOT NULL,
  embed_end INTEGER NOT NULL, vector BLOB, PRIMARY KEY (book_id, index_number, number)
);
`;

export const selections = {
  embedding_default_keys: ["embedding_defaults", "INTEGER", "key_id"],
  world_embedding_keys: ["worlds", "TEXT", "key_id"],
  world_retrieval_keys: ["worlds", "TEXT", "retrieval_key_id"],
  chat_profile_keys: ["chat_profiles", "TEXT", "chat_key_id"],
  tale_chat_keys: ["tale_settings", "INTEGER", "chat_key_id"],
} as const;
export type Selection = keyof typeof selections;

const schema = `
CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, nickname TEXT NOT NULL,
  protected_secret BLOB NOT NULL, suffix TEXT
);
CREATE TABLE IF NOT EXISTS embedding_defaults (
  id INTEGER PRIMARY KEY CHECK (id = 1), model TEXT NOT NULL,
  key_id TEXT REFERENCES provider_keys ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
  dimensions INTEGER NOT NULL, max_token_limit INTEGER NOT NULL, max_chunk_size INTEGER NOT NULL,
  boundary_search_distance INTEGER NOT NULL, key_id TEXT REFERENCES provider_keys ON DELETE SET NULL,
  retrieval_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL, error TEXT,
  index_number INTEGER NOT NULL DEFAULT 1, book_revision INTEGER NOT NULL DEFAULT 0,
  last_tale_activity_at REAL
);
${booksSchema}
CREATE TABLE IF NOT EXISTS world_artwork (
  world_id TEXT PRIMARY KEY REFERENCES worlds ON DELETE CASCADE,
  content_type TEXT NOT NULL, image BLOB NOT NULL, version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, configuration TEXT NOT NULL,
  chat_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS tale_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), configuration TEXT NOT NULL,
  chat_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL,
  profile_id TEXT REFERENCES chat_profiles ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS tales (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds ON DELETE CASCADE,
  title TEXT NOT NULL, automatic_title INTEGER NOT NULL DEFAULT 1, pinned INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, last_activity_at REAL
);
CREATE INDEX IF NOT EXISTS tales_world ON tales (world_id);
CREATE TABLE IF NOT EXISTS tale_messages (
  id INTEGER PRIMARY KEY, tale_id TEXT NOT NULL REFERENCES tales ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', thinking TEXT NOT NULL DEFAULT '',
  model TEXT, status TEXT NOT NULL DEFAULT 'complete', signed_parts TEXT, elapsed_ms INTEGER, thinking_ms INTEGER
);
CREATE INDEX IF NOT EXISTS messages_tale ON tale_messages (tale_id, id);
${Object.entries(selections).map(([table, [owner, type]]) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    owner_id ${type} NOT NULL REFERENCES ${owner} ON DELETE CASCADE,
    key_id TEXT NOT NULL REFERENCES provider_keys ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (owner_id, position), UNIQUE (owner_id, key_id)
  );
`).join("")}
`;

export function get<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}

export function all<T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

export function run(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) {
  return db.prepare(sql).run(...args);
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function selectedKeys(db: DatabaseSync, table: Selection, owner: string | number) {
  return all<{ key_id: string }>(db, `SELECT key_id FROM ${table} WHERE owner_id = ? ORDER BY position`, owner)
    .map(row => row.key_id);
}

export function saveSelection(db: DatabaseSync, table: Selection, owner: string | number, keys: string[]) {
  run(db, `DELETE FROM ${table} WHERE owner_id = ?`, owner);
  const insert = db.prepare(`INSERT INTO ${table} (owner_id, key_id, position) VALUES (?, ?, ?)`);
  keys.forEach((key, position) => insert.run(owner, key, position));
}

function columns(db: DatabaseSync, table: string) {
  return new Set(all<{ name: string }>(db, `PRAGMA table_info(${table})`).map(column => column.name));
}

function migrate(db: DatabaseSync, version: number) {
  db.exec(schema);
  const world = columns(db, "worlds");
  const requiredWorldColumns = {
    max_token_limit: "INTEGER NOT NULL DEFAULT 8192",
    key_id: "TEXT REFERENCES provider_keys ON DELETE SET NULL",
    retrieval_key_id: "TEXT REFERENCES provider_keys ON DELETE SET NULL",
    last_tale_activity_at: "REAL",
    index_number: "INTEGER NOT NULL DEFAULT 1",
    book_revision: "INTEGER NOT NULL DEFAULT 0",
  };
  for (const [name, definition] of Object.entries(requiredWorldColumns)) {
    if (!world.has(name)) db.exec(`ALTER TABLE worlds ADD COLUMN ${name} ${definition}`);
  }
  if (!world.has("retrieval_key_id")) db.exec("UPDATE worlds SET retrieval_key_id = key_id");
  if (!columns(db, "provider_keys").has("suffix")) db.exec("ALTER TABLE provider_keys ADD COLUMN suffix TEXT");
  const messages = columns(db, "tale_messages");
  for (const field of ["elapsed_ms", "thinking_ms"]) {
    if (!messages.has(field)) db.exec(`ALTER TABLE tale_messages ADD COLUMN ${field} INTEGER`);
  }
  if (columns(db, "chunks").has("book_number")) {
    db.exec("ALTER TABLE books RENAME TO legacy_books; ALTER TABLE chunks RENAME TO legacy_chunks");
    db.exec(booksSchema);
    db.exec(`
      INSERT INTO books
        SELECT lower(hex(randomblob(16))), world_id, number, name, filename, original, working, encoding, bom_size
        FROM legacy_books;
      INSERT INTO chunks
        SELECT b.id, 1, c.number, c.start, c.end, c.original_start, c.original_end, c.tokens, c.embed_end, c.vector
        FROM legacy_chunks c JOIN books b ON b.world_id = c.world_id AND b.number = c.book_number;
      DROP TABLE legacy_chunks;
      DROP TABLE legacy_books;
    `);
  }
  if (version < 1) {
    for (const [table, [owner, , key]] of Object.entries(selections)) {
      db.exec(`
        INSERT OR IGNORE INTO ${table} (owner_id, key_id, position)
        SELECT o.id, o.${key}, 0 FROM ${owner} o JOIN provider_keys k ON k.id = o.${key}
      `);
    }
  }
  if (world.has("previous_index")) {
    db.exec(`
      DELETE FROM chunks WHERE EXISTS (
        SELECT 1 FROM books JOIN worlds ON worlds.id = books.world_id
        WHERE books.id = chunks.book_id AND chunks.index_number <> worlds.index_number
      );
      UPDATE worlds SET previous_index = NULL, previous_model = NULL, previous_dimensions = NULL,
        previous_token_limit = NULL, previous_chunk_size = NULL, reindexing = 0;
    `);
  }
  db.exec("PRAGMA user_version = 2");
}

export async function openDatabase(path: string) {
  const existing = path !== ":memory:" && existsSync(path);
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    const version = get<{ user_version: number }>(db, "PRAGMA user_version")!.user_version;
    if (version > 2) throw new Error("This database needs a newer version of TaleSide.");
    if (existing && version < 2) {
      const stamp = new Date().toISOString().replaceAll(":", "-");
      await backup(db, `${path}.before-node-${stamp}.bak`);
    }
    db.exec("PRAGMA journal_mode = WAL");
    transaction(db, () => {
      if (version < 2) migrate(db, version);
      db.exec(`
        UPDATE worlds SET status = 'paused' WHERE status IN ('creating', 'pausing');
        UPDATE tale_messages SET status = 'error' WHERE status = 'generating';
      `);
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
