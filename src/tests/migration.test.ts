import { deepEqual, equal, ok } from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { get, openDatabase } from "../server/database.js";
import { dpapi, ProviderKeys } from "../server/keys.js";
import { databasePath, fixture, id, until } from "./fixture.js";

test("legacy local data is backed up, migrates its selected key and resumes at saved dimensions", async t => {
  const path = await databasePath(t);
  const legacy = new DatabaseSync(path);
  const keyId = id();
  const worldId = id();
  const firstVector = Buffer.alloc(768 * 4);
  firstVector.writeFloatLE(1, 0);
  legacy.exec(`
    CREATE TABLE provider_keys (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, nickname TEXT NOT NULL, protected_secret BLOB NOT NULL
    );
    CREATE TABLE worlds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, max_chunk_size INTEGER NOT NULL, boundary_search_distance INTEGER NOT NULL,
      key_id TEXT REFERENCES provider_keys ON DELETE SET NULL, error TEXT
    );
    CREATE TABLE books (
      world_id TEXT REFERENCES worlds ON DELETE CASCADE, number INTEGER NOT NULL, name TEXT NOT NULL,
      filename TEXT NOT NULL, original BLOB NOT NULL, working TEXT NOT NULL, encoding TEXT NOT NULL,
      bom_size INTEGER NOT NULL, PRIMARY KEY (world_id, number)
    );
    CREATE TABLE chunks (
      world_id TEXT NOT NULL, book_number INTEGER NOT NULL, number INTEGER NOT NULL, start INTEGER NOT NULL,
      end INTEGER NOT NULL, original_start INTEGER NOT NULL, original_end INTEGER NOT NULL, tokens INTEGER NOT NULL,
      embed_end INTEGER NOT NULL, vector BLOB, PRIMARY KEY (world_id, book_number, number)
    );
  `);
  legacy.prepare("INSERT INTO provider_keys VALUES (?, 'gemini', 'Legacy', ?)").run(keyId, Buffer.from("fixture-key"));
  legacy.prepare("INSERT INTO worlds VALUES (?, 'Legacy World', 'creating', 'gemini-embedding-001', 768, 4, 0, ?, NULL)").run(worldId, keyId);
  legacy.prepare("INSERT INTO books VALUES (?, 1, 'Book', 'Book.txt', ?, 'abcdefgh', 'utf-8', 0)").run(worldId, Buffer.from("abcdefgh"));
  legacy.prepare("INSERT INTO chunks VALUES (?, 1, 1, 0, 4, 0, 4, 2, 4, ?)").run(worldId, firstVector);
  legacy.prepare("INSERT INTO chunks VALUES (?, 1, 2, 4, 8, 4, 8, 0, 8, NULL)").run(worldId);
  legacy.close();

  const app = await fixture(t, undefined, path);
  const paused = await app.world(worldId);
  equal(paused.status, "paused");
  equal(paused.dimensions, 768);
  deepEqual((await app.keys()).models.map(model => model.id), ["gemini-embedding-2"]);
  equal(paused.embedded_chunks, 1);
  deepEqual(paused.embedding_key_ids, [keyId]);
  deepEqual(paused.retrieval_key_ids, [keyId]);
  ok((await readdir(dirname(path))).some(file => file.includes(".before-node-") && file.endsWith(".bak")));
  await app.call(`/api/worlds/${worldId}/resume`, {});
  equal((await until(() => app.world(worldId), world => world.status === "ready")).embedded_chunks, 2);
});

test("Windows DPAPI-protected key blobs reopen for the current user without plaintext in SQLite", { skip: process.platform !== "win32" }, async t => {
  const db = await openDatabase(await databasePath(t));
  try {
    const sample = `fixture-${id()}`;
    const encrypted = dpapi("Protect", Buffer.from(sample));
    ok(!encrypted.includes(Buffer.from(sample)));
    const legacyId = id();
    db.prepare("INSERT INTO provider_keys (id, provider, nickname, protected_secret) VALUES (?, 'gemini', 'Imported', ?)").run(legacyId, encrypted);
    const keys = new ProviderKeys(db);
    equal(await keys.retry("chat", [legacyId], new AbortController().signal, async key => key), sample);
    equal(keys.settings().keys[0].suffix, sample.slice(-4));
    equal(get<{ suffix: string }>(db, "SELECT suffix FROM provider_keys WHERE id = ?", legacyId)?.suffix, sample.slice(-4));
  } finally { db.close(); }
});

test("a version 2 database keeps existing Tales and builds their search index", async t => {
  const path = await databasePath(t);
  const db = await openDatabase(path);
  const world = id();
  const tale = id();
  try {
    db.exec(`
      DROP TRIGGER search_title_insert; DROP TRIGGER search_title_update; DROP TRIGGER search_title_delete;
      DROP TRIGGER search_world_insert; DROP TRIGGER search_world_update; DROP TRIGGER search_world_delete;
      DROP TRIGGER search_message_insert; DROP TRIGGER search_message_update; DROP TRIGGER search_message_delete;
      DROP TABLE tale_search;
      DROP TABLE tale_search_sources;
      ALTER TABLE worlds ADD COLUMN boundary_search_distance INTEGER NOT NULL DEFAULT 1000;
      ALTER TABLE tale_messages DROP COLUMN error;
      PRAGMA user_version = 2;
    `);
    db.prepare(`INSERT INTO worlds (id, name, status, model, dimensions, max_token_limit, max_chunk_size)
      VALUES (?, 'Saved World', 'paused', 'gemini-embedding-2', 3072, 8192, 8000)`).run(world);
    db.prepare("INSERT INTO tales (id, world_id, title, created_at) VALUES (?, ?, 'Saved Tale', 1)").run(tale, world);
    db.prepare("INSERT INTO tale_messages (tale_id, role, content) VALUES (?, 'user', 'Quiet glen')").run(tale);
  } finally { db.close(); }

  const app = await fixture(t, undefined, path);
  equal((await app.world(world)).status, "paused");
  const found = await app.call<{ id: string; title: string }[]>("/api/tales/search?q=glen");
  equal(found.length, 1);
  equal(found[0].id, tale);
  equal(found[0].title, "Saved Tale");
});
