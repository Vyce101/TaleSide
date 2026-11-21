import { deepEqual, equal, match, ok } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { World } from "../shared/types.js";
import { fakeProvider, fixture, id, until, upload } from "./fixture.js";

test("a name-only World stays editable and removing its last book keeps the World", async t => {
  const app = await fixture(t);
  const empty = await app.newWorld({ name: "Empty" }, []);
  const base = `/api/worlds/${empty.id}`;
  equal(empty.status, "unindexed");
  equal(empty.max_chunk_size, 8000);
  deepEqual(empty.books, []);
  const key = await app.addKey("Index");
  const withBook = await app.call<World>(base + "/add-books", upload({ book_revision: empty.book_revision }, [["📕.txt", "The story"]]));
  equal(withBook.status, "unindexed");
  equal(withBook.books[0].name, "📕");
  equal(withBook.total_chunks, 0);
  const rejected = await app.send(base + "/start-index", { book_revision: withBook.book_revision, key_ids: [] });
  equal(rejected.status, 409);
  await app.call<World>(base + "/start-index", { book_revision: withBook.book_revision, key_ids: [key], max_chunk_size: 20 });
  const ready = await until(() => app.world(empty.id), world => world.status === "ready");
  const removed = await app.call<World>(base + "/remove-book", { book_revision: ready.book_revision, book_id: ready.books[0].id });
  equal(removed.status, "unindexed");
  equal(removed.name, "Empty");
  equal(removed.can_play, false);
  deepEqual(removed.books, []);
});

test("pausing finishes the active chunk and Resume processes only queued chunks after restart", async t => {
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const sent: string[] = [];
  const provider = {
    ...fakeProvider,
    async embed(model: string, dimensions: number, key: string, text: string, signal: AbortSignal) {
      sent.push(text);
      if (sent.length === 1) await blocked;
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  };
  const app = await fixture(t, provider);
  const key = await app.addKey("Index");
  const world = await app.newWorld({ name: "Long", key_ids: [key], max_chunk_size: 4 }, [["One.txt", "abcdefghijkl"]]);
  const base = `/api/worlds/${world.id}`;
  await until(() => sent.length, sent => sent === 1);
  const pausing = await app.call<World>(base + "/pause", {});
  equal(pausing.status, "pausing");
  equal((await app.send(base + "/clear-index", {})).status, 409);
  unblock();
  const paused = await until(() => app.world(world.id), current => current.status === "paused");
  equal(paused.embedded_chunks, 1);
  equal(paused.can_play, true);
  await app.close();
  const reopened = await fixture(t, provider, app.database);
  await reopened.call(base + "/resume", {});
  await until(() => reopened.world(world.id), current => current.status === "ready");
  deepEqual(sent, ["title: One | text: abcd", "title: One | text: efgh", "title: One | text: ijkl"]);
});

test("idle edits revise book order and names, and new books wait for Resume", async t => {
  const app = await fixture(t);
  const keys = [await app.addKey("First"), await app.addKey("Second")];
  const world = await app.newWorld({ name: "World", key_ids: keys }, [["A.txt", "One"], ["B.txt", "Two"]]);
  const base = `/api/worlds/${world.id}`;
  const ready = await until(() => app.world(world.id), current => current.status === "ready");
  const ordered = await app.call<World>(base + "/book-order", {
    book_revision: ready.book_revision, book_ids: [ready.books[1].id, ready.books[0].id],
  });
  const renamed = await app.call<World>(base + "/rename-book", {
    book_revision: ordered.book_revision, book_id: ordered.books[0].id, name: "New name",
  });
  deepEqual(renamed.books.map(book => book.name), ["New name", "A"]);
  equal((await app.send(base + "/remove-book", { book_revision: ready.book_revision, book_id: ordered.books[0].id })).status, 409);
  const added = await app.call<World>(base + "/add-books", upload({ book_revision: renamed.book_revision }, [["C.txt", "Three"]]));
  equal(added.status, "paused");
  equal(added.embedded_chunks, 2);
  equal(added.can_play, true);
  await app.call(base + "/resume", {});
  const finished = await until(() => app.world(world.id), current => current.status === "ready");
  equal(finished.embedded_chunks, 3);
  deepEqual(finished.embedding_key_ids, keys);
});

test("a provider failure keeps the existing progress and can Resume with a replacement key", async t => {
  let calls = 0;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (++calls === 2) throw new Error("Fixture provider failure");
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  });
  const key = await app.addKey("Key 1");
  const replacement = await app.addKey("Key 2");
  const world = await app.newWorld({ name: "Retry", key_ids: [key], max_chunk_size: 4 }, [["Book.txt", "abcdefgh"]]);
  const base = `/api/worlds/${world.id}`;
  const failed = await until(() => app.world(world.id), current => current.status === "failed");
  equal(failed.embedded_chunks, 1);
  await app.call(base + "/embedding-key", { key_ids: [replacement] });
  await app.call(base + "/resume", {});
  const finished = await until(() => app.world(world.id), current => current.status === "ready");
  equal(finished.embedded_chunks, 2);
  equal(calls, 3);
});

test("creation is idempotent and local API refuses cross-origin state changes", async t => {
  const app = await fixture(t);
  const worldId = id();
  const first = await app.newWorld({ name: "Durable" }, [], worldId);
  const repeated = await app.newWorld({ name: "Other name" }, [], worldId);
  equal(first.name, repeated.name);
  equal((await app.send(`/api/worlds/${worldId}/rename`, { name: "Remote" }, { Origin: "https://example.com" })).status, 403);
  const result = await app.send("/");
  equal(result.status, 200);
  match(await result.text(), /type="module" src="\/client\/app.js"/);
  equal((await app.send("/client/app.js")).status, 200);
  equal((await app.send("/server/main.js")).status, 404);
});


test("a large index reports progress after the first chunk even below one percent", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  const provider = {
    ...fakeProvider,
    async embed(model: string, dimensions: number, key: string, text: string, signal: AbortSignal) {
      if (++sent === 1) await gate;
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  };
  const app = await fixture(t, provider);
  const key = await app.addKey("Index");
  const world = await app.newWorld({ name: "Small chunks", key_ids: [key], max_chunk_size: 100 },
    [["Long.txt", "word ".repeat(4000)]]);
  try {
    await until(() => sent, value => value === 1);
    await app.call(`/api/worlds/${world.id}/pause`, {});
  } finally { release(); }
  const paused = await until(() => app.world(world.id), value => value.status === "paused");
  equal(paused.embedded_chunks, 1);
  ok(paused.total_chunks >= 200);
  ok(paused.progress > 0 && paused.progress < 1);
});

test("HTML books finish indexing against extracted text and retain the original upload", async t => {
  const app = await fixture(t);
  const key = await app.addKey("Embedding");
  const original = "<h1>Prologue</h1><p>The garden gate.</p><p hidden>Omitted</p>";
  const world = await app.newWorld({ name: "HTML World", key_ids: [key], max_chunk_size: 12 },
    [["Book.html", original]]);
  const ready = await until(() => app.world(world.id), world => world.status === "ready" || world.status === "failed");
  equal(ready.status, "ready");
  const db = new DatabaseSync(app.database, { readOnly: true });
  try {
    const book = db.prepare("SELECT original, working FROM books WHERE world_id = ?").get(world.id)!;
    equal(Buffer.from(book.original as Uint8Array).toString("utf8"), original);
    equal(book.working, "Prologue\n\nThe garden gate.");
  } finally { db.close(); }
});
