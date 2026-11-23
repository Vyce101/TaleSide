export const graphSchema = `
  ALTER TABLE worlds ADD COLUMN graph_settings TEXT;
  ALTER TABLE worlds ADD COLUMN graph_published INTEGER;
  ALTER TABLE worlds ADD COLUMN graph_base INTEGER;
  ALTER TABLE worlds ADD COLUMN graph_building INTEGER;

  CREATE TABLE world_extraction_keys (
    owner_id TEXT NOT NULL REFERENCES worlds ON DELETE CASCADE,
    key_id TEXT NOT NULL REFERENCES provider_keys ON DELETE CASCADE,
    position INTEGER NOT NULL, PRIMARY KEY (owner_id, position), UNIQUE (owner_id, key_id)
  );
  CREATE TABLE graph_chunks (
    book_id TEXT NOT NULL, index_number INTEGER NOT NULL, chunk_number INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (book_id, index_number, chunk_number),
    FOREIGN KEY (book_id, index_number, chunk_number) REFERENCES chunks (book_id, index_number, number) ON DELETE CASCADE
  );
  CREATE TABLE graph_passes (
    book_id TEXT NOT NULL, index_number INTEGER NOT NULL, chunk_number INTEGER NOT NULL,
    pass INTEGER NOT NULL, records TEXT NOT NULL, PRIMARY KEY (book_id, index_number, chunk_number, pass),
    FOREIGN KEY (book_id, index_number, chunk_number) REFERENCES graph_chunks ON DELETE CASCADE
  );
  CREATE TABLE graph_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT NOT NULL REFERENCES worlds ON DELETE CASCADE,
    dimensions INTEGER NOT NULL
  );
  CREATE INDEX graph_generations_world ON graph_generations(world_id);
  CREATE TABLE graph_records (
    id INTEGER PRIMARY KEY, generation INTEGER NOT NULL REFERENCES graph_generations ON DELETE CASCADE,
    identity TEXT NOT NULL, name TEXT NOT NULL, type TEXT,
    source INTEGER REFERENCES graph_records ON DELETE CASCADE, target INTEGER REFERENCES graph_records ON DELETE CASCADE,
    strength INTEGER, fingerprint TEXT NOT NULL, input TEXT NOT NULL,
    description TEXT, characters INTEGER, vector BLOB,
    UNIQUE (generation, identity)
  );
  CREATE INDEX graph_unfinished_records ON graph_records (generation, (description IS NOT NULL), id) WHERE vector IS NULL;
  CREATE INDEX graph_records_source ON graph_records (source) WHERE source IS NOT NULL;
  CREATE INDEX graph_records_target ON graph_records (target) WHERE target IS NOT NULL;
`;
