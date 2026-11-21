import { deepEqual, equal, ok } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TaleSearchResult } from "../shared/types.js";
import { fixture, id } from "./fixture.js";

test("Tale search ranks titles, finds old visible messages, and tracks renames and deletes", async t => {
  const app = await fixture(t);
  const first = await app.newWorld({ name: "Mélromarc" }, []);
  const second = await app.newWorld({ name: "Elsewhere" }, []);
  const title = id();
  const message = id();
  const db = new DatabaseSync(app.database);
  try {
    const tale = db.prepare("INSERT INTO tales (id, world_id, title, created_at) VALUES (?, ?, ?, ?)");
    tale.run(title, first.id, "Tavérn", 1);
    tale.run(message, second.id, "Silver gates", 2);
    for (let number = 0; number < 11; number++) tale.run(id(), first.id, `Recent Tale ${number}`, 3 + number);
    const addMessage = db.prepare("INSERT INTO tale_messages (tale_id, role, content, thinking) VALUES (?, 'assistant', ?, ?)");
    addMessage.run(message, "A key by the <tavern> door.", "secretthought");
    addMessage.run(message, "The most recent message has unrelated text.", "");
  } finally { db.close(); }

  const search = (query: string, world?: string) => app.call<TaleSearchResult[]>(`/api/tales/search?${new URLSearchParams({
    q: query, ...(world ? { world } : {}),
  })}`);
  const results = await search("tav");
  deepEqual(results.map(tale => tale.id), [title, message]);
  deepEqual(results[1].match, [
    { text: "A key by the <", highlighted: false }, { text: "tavern", highlighted: true }, { text: "> door.", highlighted: false },
  ]);
  deepEqual(await search("secretthought"), []);
  deepEqual(await search("silver key"), []);
  deepEqual((await search("tav", second.id)).map(tale => tale.id), [message]);
  deepEqual(await search("melro", first.id), []);
  equal((await search("melro")).length, 12);
  deepEqual(await search('") OR *'), []);

  await app.call(`/api/worlds/${first.id}/tales/${title}/rename`, { title: "The Shield" });
  await app.call(`/api/worlds/${first.id}/rename`, { name: "New Town" });
  deepEqual((await search("tav")).map(tale => tale.id), [message]);
  deepEqual(await search("melro"), []);
  ok((await search("new town")).some(tale => tale.id === title));

  await app.call(`/api/worlds/${second.id}/tales/${message}/delete`, {});
  deepEqual(await search("tav"), []);
  await app.call(`/api/worlds/${first.id}/discard`, {});
  deepEqual(await search("new town"), []);
});
