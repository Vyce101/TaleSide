import { deepEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { GenerationEvent, Tale, TaleSummary, World } from "../shared/types.js";
import { fakeProvider, fixture, id, until, upload } from "./fixture.js";

test("a Tale is saved on its first accepted send and uses live World metadata and Markdown reply parts", async t => {
  let payload: object | undefined;
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(model, key, body, signal) {
      payload = body;
      await wait(50);
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const created = await app.newWorld({ name: "Original name", openings: [""], key_ids: [key] }, [["First.txt", "A passage"], ["Second.txt", "Another passage"]]);
  const base = `/api/worlds/${created.id}`;
  const ready = await until(() => app.world(created.id), world => world.status === "ready");
  await app.call(base + "/rename", { name: "Current World" });
  const reordered = await app.call<World>(base + "/book-order",
    { book_revision: ready.book_revision, book_ids: [ready.books[1].id, ready.books[0].id] });
  await app.call(base + "/rename-book", { book_revision: reordered.book_revision, book_id: ready.books[1].id, name: "Current book" });
  const draft = id();
  const route = `${base}/tales/${draft}`;
  equal((await app.send(route)).status, 404);
  deepEqual(await app.call("/api/tales"), []);
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  const events: GenerationEvent[] = await app.generate(created.id, draft, "First message", settings);
  deepEqual(events.map(event => event.type), ["accepted", "thinking", "reply", "done"]);
  const tale = await app.call<Tale>(route);
  const thought = events.find(event => event.type === "thinking")!;
  ok(thought.thinking_ms >= 45);
  equal(tale.messages[1].thinking_ms, thought.thinking_ms);
  deepEqual(tale.messages.map(message => [message.content, message.thinking]), [["First message", ""], ["**Reply**", "Thought"]]);
  match(JSON.stringify(payload), /Name = Current World.*Book 1 - Current book.*Book 2 - First.*Another passage.*A passage/);
  const recent = await app.call<TaleSummary[]>("/api/tales");
  equal(recent.length, 1);
  equal(recent[0].message_count, 2);
  await app.call(route + "/pin", { pinned: true });
  await app.call(route + "/rename", { title: "Renamed Tale" });
  equal((await app.call<Tale>(route)).title, "Renamed Tale");
  equal((await app.call<Tale>(route)).pinned, true);
  await app.call(base + "/discard", {});
  equal((await app.send(route)).status, 404);
  deepEqual(await app.call("/api/tales"), []);
});

test("retrieval includes the full chunk even when indexing embedded only a prefix", async t => {
  let payload: object | undefined;
  const app = await fixture(t, {
    ...fakeProvider,
    async count(_model, _key, body) {
      return JSON.stringify(body).includes("| text: ghi") ? 8193 : 4;
    },
    async embed(_model, dimensions, _key, text) {
      const axis = text.endsWith("| text: gh") || text.startsWith("task: search result") ? 0 : 1;
      return Array.from({ length: dimensions }, (_, index) => Number(index === axis));
    },
    async *chat(model, key, body, signal) {
      payload = body;
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Passages", key_ids: [key], max_chunk_size: 6 },
    [["Book.txt", "abcdefghi"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key], chunk_budget: 5, chunk_overlap: 2 };
  await app.generate(world.id, id(), "Find the matching passage.", settings);
  match(JSON.stringify(payload), /<retrieved_context>\\nefghi\\n<\/retrieved_context>/);
});

test("the passage budget checks lower-ranked chunks after skipping a chunk that does not fit", async t => {
  let payload: object | undefined;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(_model, dimensions, _key, text) {
      const secondary = text.startsWith("title: Two") ? 0.3 : text.startsWith("title: Three") ? 0.5 : 0;
      return Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : index === 1 ? secondary : 0);
    },
    async *chat(model, key, body, signal) {
      payload = body;
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Budget", key_ids: [key] },
    [["One.txt", "Best note"], ["Two.txt", "An oversized passage."], ["Three.txt", "Short"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key], chunk_budget: 16 };
  await app.generate(world.id, id(), "Find the match.", settings);
  match(JSON.stringify(payload), /<retrieved_context>\\nBest note\\n\\nShort\\n<\/retrieved_context>/);
});

test("a higher-ranked passage gives back its overlap when the preceding passage also fits", async t => {
  let chatRequest: object | undefined;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(_model, dimensions, _key, text) {
      const vector = Array<number>(dimensions).fill(0);
      vector[0] = 1;
      if (text.endsWith(" | text: abcdef")) vector[1] = 1;
      return vector;
    },
    async *chat(model, key, body, signal) {
      chatRequest = body;
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Overlapping passages", key_ids: [key], max_chunk_size: 6 },
    [["Book.txt", "abcdefghi"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key], chunk_budget: 11, chunk_overlap: 2 };
  await app.generate(world.id, id(), "Find the matching passages.", settings);
  match(JSON.stringify(chatRequest), /<retrieved_context>\\nabcdef\\n\\nghi\\n<\/retrieved_context>/);
});

test("deleting indexing preserves Tales and uses the first new passage without the old index", async t => {
  let block = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (block && text.startsWith("title:") && ++started === 2) {
        await gate;
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Rebuild", openings: [""], key_ids: [key] }, [["Book.txt", "abcdefghij"]]);
  const base = `/api/worlds/${world.id}`;
  await until(() => app.world(world.id), value => value.status === "ready");
  const tale = id();
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  await app.generate(world.id, tale, "Before reset", settings);
  const cleared = await app.call<World>(base + "/clear-index", {});
  equal(cleared.can_play, false);
  equal(cleared.total_chunks, 0);
  equal(cleared.books.length, 1);
  equal((await app.call<Tale>(`${base}/tales/${tale}`)).messages.length, 2);
  const unavailable = await app.send(`${base}/tales/${tale}/generate`, { content: "No old index", generation_id: id(), settings });
  equal(unavailable.status, 409);
  block = true;
  try {
    await app.call(base + "/start-index", { book_revision: cleared.book_revision, key_ids: [key], max_chunk_size: 4 });
    const partial = await until(() => app.world(world.id), value => value.embedded_chunks === 1);
    equal(partial.can_play, true);
    equal(partial.status, "creating");
    await app.generate(world.id, tale, "After first passage", settings);
  } finally { release(); }
  await until(() => app.world(world.id), value => value.status === "ready");
  equal((await app.call<Tale>(`${base}/tales/${tale}`)).messages.filter(msg => msg.role === "user").length, 2);
});

test("a lower chat input limit counts the full request and leaves the complete history available", async t => {
  let counted: unknown;
  let chats = 0;
  const app = await fixture(t, {
    ...fakeProvider,
    async count(model, key, body, signal) {
      if ("generateContentRequest" in body) { counted = body.generateContentRequest; return 20000; }
      return fakeProvider.count(model, key, body, signal);
    },
    async *chat(model, key, body, signal) {
      chats++;
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Limits", key_ids: [key] }, [["Book.txt", "Book text"]]);
  const tale = id();
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  await until(() => app.world(world.id), value => value.status === "ready");
  await app.generate(world.id, tale, "Earlier line", settings);
  const events = await app.generate(world.id, tale, "Latest line", { ...settings, input_limit: 10000, output_limit: 3000 });
  match(JSON.stringify(counted), /Earlier line.*signature.*Latest line/);
  match(JSON.stringify(counted), /"maxOutputTokens":3000/);
  match(JSON.stringify(counted), /Book text/);
  equal(chats, 1);
  match(events.at(-1).error, /input token limit/);
  const saved = await app.call<Tale>(`/api/worlds/${world.id}/tales/${tale}`);
  deepEqual(saved.messages.filter(message => message.role === "user").map(message => message.content), ["Earlier line", "Latest line"]);
});

test("Stop and client disconnect both save the reply received so far", async t => {
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(_model, _key, _body, signal) {
      yield { text: "Partial reply" };
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Streaming", key_ids: [key] }, [["Book.txt", "Story"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  for (const userStopped of [true, false]) {
    const tale = id();
    const generation = id();
    const route = `/api/worlds/${world.id}/tales/${tale}`;
    const response = await app.send(route + "/generate", { content: "A line", title: "Test Tale", generation_id: generation, settings });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    while (!received.includes("Partial reply")) {
      const { done, value } = await reader.read();
      ok(!done);
      received += value;
    }
    if (userStopped) {
      equal((await app.send(route + "/generate", { content: "Overlap", generation_id: id(), settings })).status, 409);
      await app.call(route + "/stop", { generation_id: generation, user_stopped: true });
      while (!(await reader.read()).done) { /* Consume the terminal event. */ }
    } else await reader.cancel();
    const saved = await until(() => app.call<Tale>(route), detail => detail.messages.at(-1)?.status !== "generating");
    equal(saved.messages.at(-1)?.content, "Partial reply");
    equal(saved.messages.at(-1)?.status, userStopped ? "stopped" : "error");
  }
});

test("appending books uses completed passages while the new book waits, and deleting keys clears only their assignments", async t => {
  const app = await fixture(t);
  const first = await app.addKey("First");
  const second = await app.addKey("Second");
  const launched = await app.newWorld({ name: "Books", key_ids: [first, second] }, [["Book.txt", "Story"]]);
  const base = `/api/worlds/${launched.id}`;
  const world = await until(() => app.world(launched.id), value => value.status === "ready");
  await app.call(base + "/add-books", upload({ book_revision: world.book_revision }, [["Next.txt", "Next story"]]));
  const profiles = await app.profiles();
  const saved = { ...profiles.defaults, chat_key_ids: [first, second], chunk_budget: 17000 };
  await app.call("/api/chat-profiles/create", { name: "My preset", settings: saved });
  const keys = await app.keys();
  equal(keys.keys[0].worlds[0].name, world.name);
  equal("protected_secret" in keys.keys[0], false);
  const impact = await app.call(`/api/provider-keys/${first}/delete-impact`);
  await app.call(`/api/provider-keys/${first}/delete`, { impact });
  deepEqual((await app.world(world.id)).retrieval_key_ids, [second]);
  deepEqual((await app.world(world.id)).embedding_key_ids, [second]);
  deepEqual((await app.profiles()).profiles.find(profile => profile.name === "My preset")!.settings.chat_key_ids, [second]);
  equal((await app.profiles()).profiles.find(profile => profile.name === "My preset")!.settings.chunk_budget, 17000);
  const tale = id();
  await app.generate(world.id, tale, "Waiting on new books", { ...saved, chat_key_ids: [second] });
  await app.call(base + "/retrieval-key", { key_ids: [] });
  const missing = await app.send(`${base}/tales/${tale}/generate`, { content: "Next", generation_id: id(), settings: { ...saved, chat_key_ids: [second] } });
  equal(missing.status, 200);
  equal(JSON.parse((await missing.text()).trim()).type, "saved");
});


test("a reply keeps its Python snapshot when the World index changes after acceptance", async t => {
  let startRetrieval!: () => void;
  const retrieving = new Promise<void>(resolve => { startRetrieval = resolve; });
  let finishRetrieval!: () => void;
  const gate = new Promise<void>(resolve => { finishRetrieval = resolve; });
  let snapshotPayload: object | undefined;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (text.startsWith("task: search result")) {
        startRetrieval();
        await gate;
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
    async *chat(model, key, payload, signal) {
      snapshotPayload = payload;
      yield* fakeProvider.chat(model, key, payload, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Before", key_ids: [key] }, [["Book.txt", "The passage before the reset"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  const reply = app.generate(world.id, id(), "Question", settings);
  try {
    await retrieving;
    await app.call(`/api/worlds/${world.id}/clear-index`, {});
    await app.call(`/api/worlds/${world.id}/rename`, { name: "After" });
  } finally { finishRetrieval(); }
  const events = await reply;
  equal(events.at(-1).message.status, "complete");
  match(JSON.stringify(snapshotPayload), /Name = Before.*The passage before the reset/);
  equal((await app.world(world.id)).can_play, false);
});
