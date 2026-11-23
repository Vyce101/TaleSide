import { deepEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { World } from "../shared/types.js";
import { FLASH_LITE, GEMMA, HYDROGEN } from "../shared/models.js";
import { fakeProvider, fixture, id, until, upload } from "./fixture.js";

type Request = { contents: { role: string; parts: { text: string; thought?: boolean; thoughtSignature?: string }[] }[];
  generationConfig: Record<string, unknown>; systemInstruction?: { parts: { text: string }[] } };

function complete(...records: string[]) {
  return [...records.map(record => `##\n(${record})`), "<|COMPLETE|>"].join("\n");
}
function entity(name: string, type: string, description: string) {
  return ['"entity"', name, type, description].join("<|>");
}
test("passage embedding and extraction advance independently and pausing finishes both active steps", async t => {
  let releasePassage!: () => void;
  let releaseGleaning!: () => void;
  const passage = new Promise<void>(resolve => { releasePassage = resolve; });
  const gleaning = new Promise<void>(resolve => { releaseGleaning = resolve; });
  t.after(() => { releasePassage(); releaseGleaning(); });
  let waitingForPassage = false;
  let waitingForGleaning = false;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (text === "title: Book | text: abcd") {
        waitingForPassage = true;
        await passage;
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
    async *chat(_model, _key, body) {
      const prompt = (body as Request).contents[0].parts[0].text;
      if (prompt.endsWith("#### Excerpt\nabcd")) {
        yield { text: complete(entity("CLERK", "CHARACTER", "A clerk at the harbor.")) };
      } else {
        if (prompt.includes("#### Excerpt\nabcd\n\n#### Already Extracted")) {
          waitingForGleaning = true;
          await gleaning;
        }
        yield { text: "<|COMPLETE|>" };
      }
    },
  }, undefined, { graphResponses: "provider" });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Parallel indexing", key_ids: [key], max_chunk_size: 4,
    graph: { model: FLASH_LITE, thinking_level: "MINIMAL", gleaning_passes: 1 } }, [["Book.txt", "abcdefgh"]]);
  await until(() => waitingForPassage && waitingForGleaning, ready => ready);
  const incomplete = await app.world(world.id);
  equal(incomplete.books[0].embedded_chunks, 0);
  releasePassage();
  const searchable = await until(() => app.world(world.id), value => value.embedded_chunks === 2);
  equal(searchable.can_play, true);

  const base = `/api/worlds/${world.id}`;
  equal((await app.call<World>(base + "/pause", {})).status, "pausing");
  releaseGleaning();
  const paused = await until(() => app.world(world.id), value => value.status === "paused");
  await app.call(base + "/resume", {});
  const finished = await until(() => app.world(world.id), value => value.status === "ready");
});

test("failed chunks and summaries each use three attempts, then let the remaining work finish before Resume", async t => {
  let corrected = false;
  let summaryReady = false;
  let skippedSummaries = 0;
  let completedSummaries = 0;
  const attempts: { step: string; key: string }[] = [];
  const requests: Request[] = [];
  const provider = {
    ...fakeProvider,
    async *chat(_model: string, key: string, body: object) {
      const request = body as Request;
      requests.push(request);
      const text = request.contents[0].parts[0].text;
      if (text.startsWith("#### Goal\nYou are consolidating")) {
        if (text.includes('("SECOND CHARACTER")')) {
          completedSummaries++;
          yield { text: "In B1:C1 and B1:C3 the Watch captain investigates the docks.\n<|COMPLETE|>" };
        } else {
          skippedSummaries++;
          yield { text: summaryReady ? "At B1:C1 the clerk is patient. In B1:C2 the clerk helps Corvin.\n<|COMPLETE|>" : "Incomplete summary." };
        }
      } else if (text.endsWith("abcdefghij")) {
        attempts.push({ step: "first", key });
        yield { text: complete(entity("FIRST CHARACTER", "CHARACTER", "A patient clerk."),
          entity("SECOND CHARACTER", "CHARACTER", "The Watch captain visits the docks.")) };
      } else if (text.endsWith("KLMNOPQRST")) {
        attempts.push({ step: "second", key });
        if (!corrected && key === "fixture-two") throw new Error("The model is experiencing high demand. Please try again later.");
        yield { text: corrected ? complete(entity("FIRST CHARACTER", "CHARACTER", "The clerk helps Corvin.")) : "##\n(" };
      } else {
        attempts.push({ step: "third", key });
        yield { text: complete(entity("SECOND CHARACTER", "CHARACTER", "The Watch captain finds footprints.")) };
      }
    },
  };
  let app = await fixture(t, provider, undefined, { graphResponses: "provider" });
  const key = await app.addKey("Gemini");
  const missing = await app.send(`/api/worlds/${id()}/create`, upload({ name: "Missing defaults", key_ids: [key] }, [["Book.txt", "Text"]]));
  equal(missing.status, 400);
  match((await missing.json()).error, /extraction model/);
  const extractionKeys = await Promise.all(["one", "two", "three", "four"].map(name => app.addKey(name, `fixture-${name}`)));
  const world = await app.newWorld({ name: "Story", key_ids: [key], extraction_key_ids: extractionKeys, max_chunk_size: 10,
    graph: { model: GEMMA, thinking_level: "HIGH", preceding_context: 3, gleaning_passes: 0 } },
  [["Book.txt", "abcdefghijKLMNOPQRSTuvwxyz1234"]]);
  const failed = await until(() => app.world(world.id), value => value.status === "failed");
  equal(failed.can_play, true);
  equal(failed.books[0].embedded_chunks, 3);
  match(failed.error!, /Could not extract 1 chunk after 3 attempts.*Book 1, chunk 2.*<\|COMPLETE\|>/);
  deepEqual(attempts, [
    { step: "first", key: "fixture-one" },
    { step: "second", key: "fixture-two" },
    { step: "second", key: "fixture-three" },
    { step: "second", key: "fixture-four" },
    { step: "third", key: "fixture-one" },
  ]);
  match(requests[1].contents[0].parts[0].text, /hij\n\n#### Excerpt\nKLMNOPQRST$/);
  deepEqual(requests[0].generationConfig, { maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false },
    temperature: 1, topP: 0.95, topK: 64 });
  const path = app.database;
  await app.close();
  corrected = true;
  app = await fixture(t, provider, path, { graphResponses: "provider" });
  const resume = () => app.call(`/api/worlds/${world.id}/resume`, {});
  await resume();
  const failedSummary = await until(() => app.world(world.id), value => value.status === "failed");
  match(failedSummary.error!, /Could not summarize 1 graph record after 3 attempts.*FIRST CHARACTER.*<\|COMPLETE\|>/);
  equal(skippedSummaries, 3);
  equal(completedSummaries, 1);
  summaryReady = true;
  await resume();
  const done = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(done.status, "ready", done.error ?? "");
  deepEqual(attempts.map(attempt => attempt.step), ["first", "second", "second", "second", "third", "second"]);
  equal(skippedSummaries, 4);
  equal(completedSummaries, 1);
});

test("Gemma replays only opted-in Gemma thoughts and switching back restores same-model signatures", async t => {
  const requests: Request[] = [];
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(model, _key, body) {
      requests.push(body as Request);
      yield { text: `Reasoning from ${model}`, thought: true };
      yield { text: `Answer by ${model}`, thoughtSignature: `Signature from ${model}` };
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Chat model", key_ids: [key] }, [["Book.txt", "The shore."]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const profiles = await app.profiles();
  const lite = profiles.models.find(model => model.id === FLASH_LITE)!;
  deepEqual(lite.thinking_levels, ["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
  equal(lite.default_thinking, "MINIMAL");
  const gemma = profiles.models.find(model => model.id === GEMMA)!;
  equal(gemma.replay_thinking, false);
  const defaultSettings = { ...profiles.defaults, chat_key_ids: [key] };
  const gemmaSettings = { ...defaultSettings, model: GEMMA, thinking_level: "HIGH", thought_signatures: false,
    input_limit: gemma.context_limit, output_limit: gemma.max_output };
  const tale = id();
  await app.generate(world.id, tale, "First", defaultSettings);
  await app.generate(world.id, tale, "Second", gemmaSettings);
  await app.generate(world.id, tale, "Third", { ...gemmaSettings, thought_signatures: true });
  await app.generate(world.id, tale, "Fourth", defaultSettings);
  equal(requests.length, 4);
  const parts = (index: number) => requests[index].contents.flatMap(content => content.parts);
  ok(parts(1).every(part => !part.thoughtSignature && !part.thought));
  ok(parts(2).some(part => part.thought && part.text === `Reasoning from ${GEMMA}`));
  ok(parts(2).every(part => !part.thoughtSignature));
  ok(parts(3).some(part => part.thoughtSignature === `Signature from ${HYDROGEN}`));
  ok(parts(3).every(part => !part.thought && part.thoughtSignature !== `Signature from ${GEMMA}`));
  equal(requests[1].generationConfig.maxOutputTokens, 32768);
});
