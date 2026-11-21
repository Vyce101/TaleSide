import { deepEqual, equal, match, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { GenerationEvent, Tale } from "../shared/types.js";
import { gemini } from "../server/gemini.js";
import { fakeProvider, fixture, id, until } from "./fixture.js";

test("chat tries each selected key once before output and persists partial or exhausted failures", async t => {
  let mode: "retry" | "partial" | "empty" = "retry";
  const attempts: string[] = [];
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(_model, key) {
      attempts.push(key);
      if (mode === "partial") yield { text: "Saved partial reply" };
      if (mode === "retry" && key === "fixture-good") { yield { text: "Recovered reply" }; return; }
      throw new Error(`Provider 429 for ${key}`);
    },
  });
  const first = await app.addKey("One", "fixture-bad");
  const second = await app.addKey("Two", "fixture-unavailable");
  const third = await app.addKey("Three", "fixture-good");
  const world = await app.newWorld({ name: "Books", key_ids: [first] }, [["Book.txt", "Founding history."]]);
  await until(() => app.world(world.id), world => world.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [first, second, third] };

  const send = async () => {
    const taleId = id();
    const events: GenerationEvent[] = await app.generate(world.id, taleId, "Tell me a story", settings);
    const tale = await app.call<Tale>(`/api/worlds/${world.id}/tales/${taleId}`);
    equal(events[0].type, "accepted");
    equal(events.at(-1)?.type, "done");
    return { message: tale.messages.at(-1)!, errors: events.flatMap(event => event.type === "done" && event.error ? [event.error] : []) };
  };
  const recovered = await send();
  equal(recovered.message.content, "Recovered reply");
  deepEqual(recovered.errors, []);
  deepEqual(attempts.splice(0), ["fixture-bad", "fixture-unavailable", "fixture-good"]);

  mode = "partial";
  const { message: partial } = await send();
  equal(partial.content, "Saved partial reply");
  equal(partial.error, "Provider 429 for fixture-bad");
  equal(partial.status, "error");
  deepEqual(attempts.splice(0), ["fixture-bad"]);

  mode = "empty";
  const { message: empty, errors } = await send();
  equal(empty.content, "");
  equal(empty.error, "Provider 429 for fixture-bad");
  deepEqual(errors, ["Provider 429 for fixture-bad"]);
  deepEqual(attempts, ["fixture-unavailable", "fixture-good", "fixture-bad"]);
});

test("Gemini forwards HTTP and streaming provider errors with credentials removed", async t => {
  const key = "fixture-private-key";
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Quota exceeded for ${key}` },
  }), { status: 429 }));
  await rejects(gemini.count("fixture", key, {}, signal), {
    status: 429, message: "Quota exceeded for [redacted]",
  });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n'
    + 'event: error\ndata: {"code":503,"status":"UNAVAILABLE","message":"Capacity exhausted"}',
  ));
  const parts: string[] = [];
  await rejects(async () => {
    for await (const part of gemini.chat("fixture", key, {}, signal)) parts.push(part.text!);
  }, error => {
    match(String(error), /Capacity exhausted/);
    return true;
  });
  deepEqual(parts, ["Partial"]);
});

test("indexing cools down a failed key after another key succeeds", async t => {
  let rejected = 0;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (key === "fixture-rejected") { rejected++; throw new Error("Quota exhausted."); }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  });
  const good = await app.addKey("Good", "fixture-working");
  const bad = await app.addKey("Bad", "fixture-rejected");
  const world = await app.newWorld({ name: "Many chunks", key_ids: [good, bad], max_chunk_size: 4 },
    [["Book.txt", "abcdefghijklmnopqrstuvwxyz"]]);
  const ready = await until(() => app.world(world.id), world => world.status === "ready");
  equal(ready.embedded_chunks, 7);
  equal(rejected, 1);
});

test("an exhausted retrieval embedding retry keeps a blank accepted reply and stops", async t => {
  const attempts: string[] = [];
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (text.startsWith("task: search result")) {
        attempts.push(key);
        throw new Error("Gemini · 400 INVALID_ARGUMENT: Input is too large.");
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
  });
  const one = await app.addKey("One", "fixture-one");
  const two = await app.addKey("Two", "fixture-two");
  const world = await app.newWorld({ name: "Retrieval", key_ids: [one, two] }, [["Book.txt", "A book about the land."]]);
  await until(() => app.world(world.id), world => world.status === "ready");
  const events: GenerationEvent[] = await app.generate(world.id, id(), "An opening line.",
    { ...(await app.profiles()).defaults, chat_key_ids: [one] });
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error("Expected the failed reply.");
  equal(done.message.error, "Gemini · 400 INVALID_ARGUMENT: Input is too large.");
  equal(done.message.content, "");
  deepEqual(attempts, ["fixture-one", "fixture-two"]);
});
