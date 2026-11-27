import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { MessageContext } from "../shared/inspectors.js";
import type { ChatSettings, World } from "../shared/types.js";
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
function edge(source: string, sourceType: string, target: string, targetType: string, description: string, strength: number) {
  return ['"relationship"', source, sourceType, target, targetType, description, strength].join("<|>");
}

test("Tales use live passages and publish a graph from the whole queue, then reuse extraction after book edits", async t => {
  const extractionCalls: string[] = [];
  const graphEmbeddings: string[] = [];
  const consolidations: string[] = [];
  let payload: Request;
  let releaseBook!: () => void;
  const waitForBook = new Promise<void>(resolve => { releaseBook = resolve; });
  let waiting = false;
  let releaseQuery!: () => void;
  const waitForEdit = new Promise<void>(resolve => { releaseQuery = resolve; });
  let queryAccepted = false;
  t.after(() => { releaseBook(); releaseQuery(); });
  const provider = {
    ...fakeProvider,
    async embed(model: string, dimensions: number, key: string, text: string, signal: AbortSignal) {
      if (/\bB\d+:C\d+\b/.test(text)) graphEmbeddings.push(text);
      if (text.includes("Hold for the edit.")) {
        queryAccepted = true;
        await waitForEdit;
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
    async *chat(model: string, key: string, body: object, signal: AbortSignal) {
      const request = body as Request;
      const prompt = request.contents[0].parts[0].text;
      if (prompt.startsWith("#### Goal\nGiven a fiction excerpt")) {
        const [text, gleaning] = prompt.split("#### Excerpt\n")[1].split("\n\n#### Already Extracted\n");
        extractionCalls.push(text);
        if (text === "Third chapter.") {
          waiting = true;
          await waitForBook;
        }
        if (gleaning !== undefined) {
          if (text === "First chapter." && !gleaning.includes("GUILD SEAL")) {
            yield { text: complete(entity("GUILD SEAL", "ITEM", "A forged seal.")) };
          } else yield { text: "<|COMPLETE|>" };
        } else if (text === "First chapter.") {
          yield { text: complete(
            entity("CORVIN", "CHARACTER", "Corvin is a harbor clerk."),
            entity("THE WATCH", "FACTION/GROUP", "The Watch patrols the harbor."),
            edge("CORVIN", "CHARACTER", "THE WATCH", "FACTION/GROUP", "The Watch hired Corvin.", 5),
          ) };
        } else if (text === "Second chapter.") {
          yield { text: complete(
            entity("CORVIN", "CHARACTER", "Corvin knows about a forged seal."),
            entity("THE WATCH", "FACTION/GROUP", "The Watch knows Corvin."),
            entity("THE WATCH", "LOCATION", "A guardhouse at the docks."),
            edge("CORVIN", "CHARACTER", "THE WATCH", "FACTION/GROUP", "Corvin works against the Watch.", 9),
            edge("THE WATCH", "FACTION/GROUP", "CORVIN", "CHARACTER", "The Watch trusts Corvin.", 6),
            edge("CORVIN", "CHARACTER", "THE WATCH", "LOCATION", "Corvin sneaks into the guardhouse.", 8),
            edge("CORVIN", "CHARACTER", "CORVIN", "CHARACTER", "Corvin trains his own memory.", 3),
          ) };
        } else yield { text: complete(entity("CARTER", "CHARACTER", "Carter pilots the ferry.")) };
        return;
      }
      if (prompt.startsWith("#### Goal\nYou are consolidating")) {
        const notes = prompt.split("#### Input Descriptions\n")[1].split("\n\n#### Output Format")[0];
        consolidations.push(notes);
        yield { text: notes + "\n<|COMPLETE|>" };
        return;
      }
      payload = request;
      yield* fakeProvider.chat(model, key, body, signal);
    },
  };
  let app = await fixture(t, provider, undefined, { graphResponses: "provider" });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Harbor", key_ids: [key], extraction_key_ids: [key],
    graph: { model: FLASH_LITE, thinking_level: "MINIMAL" } },
  [["One.txt", "First chapter."], ["Two.txt", "Second chapter."]]);
  const base = `/api/worlds/${world.id}`;
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  const ask = async (text = "Ask the Watch and Corvin about Carter.") => {
    const events = await app.generate(world.id, id(), text, settings);
    equal(events.at(-1).message.status, "complete", JSON.stringify(events.at(-1).error));
    return payload.systemInstruction!.parts.map(part => part.text).join("\n");
  };

  const ready = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(ready.status, "ready", ready.error ?? "");
  equal(extractionCalls.filter(text => text === "First chapter.").length, 3);
  equal(extractionCalls.filter(text => text === "Second chapter.").length, 2);
  ok(consolidations.some(notes => notes.startsWith("B1:C1: Corvin is a harbor clerk.") && notes.includes("B2:C1: Corvin trains his own memory.")));
  ok(graphEmbeddings.some(text => text.startsWith("title: CORVIN → THE WATCH | text: B1:C1") && text.includes("Corvin works against the Watch.")));
  const before = await ask();
  match(before, /Entities = 4\nRelationships = 3/);
  match(before, /B1:C1 means Book 1, Chunk 1\.\n<retrieved_context>/);
  match(before, /THE WATCH \(FACTION\/GROUP\)/);
  match(before, /THE WATCH \(LOCATION\)/);
  match(before, /THE WATCH → CORVIN/);

  const added = await app.call<World>(base + "/add-books", upload({ book_revision: ready.book_revision }, [["Three.txt", "Third chapter."]]));
  equal(added.status, "paused");
  await app.call(base + "/resume", {});
  await until(() => waiting, value => value);
  await until(() => app.world(world.id), value => value.embedded_chunks === 3);
  const during = await ask();
  match(during, /Third chapter\./);
  match(during, /Entities = 4/);
  ok(!during.includes("Carter pilots the ferry."));
  releaseBook();
  const appended = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(appended.status, "ready", appended.error ?? "");
  match(await ask(), /B3:C1: Carter pilots the ferry\./);
  const extracted = [...extractionCalls];

  const oldTale = id();
  const oldReply = (await app.generate(world.id, oldTale, "Ask Corvin about the Watch.", { ...settings, chunk_budget: 1 })).at(-1).message;
  const oldXray = () => app.call<MessageContext>(`${base}/tales/${oldTale}/xray?message=${oldReply.id}&swipe=0`);
  const archive = await oldXray();
  ok(archive.trace.chunks.every(chunk => !chunk.included));
  equal(archive.trace.sources["B2:C1"], "Second chapter.");
  const inFlight = ask("Hold for the edit.");
  await until(() => queryAccepted, value => value);
  const removed = await app.call<World>(base + "/remove-book", { book_revision: appended.book_revision, book_id: appended.books[1].id });
  const reversed = await app.call<World>(base + "/book-order", { book_revision: removed.book_revision,
    book_ids: removed.books.map(book => book.id).reverse() });
  equal(reversed.status, "paused");
  releaseQuery();
  match(await inFlight, /A guardhouse at the docks\./);
  equal((await oldXray()).trace.sources["B2:C1"], "Second chapter.");
  const whilePaused = await ask();
  ok(!whilePaused.includes("Entities =") && !whilePaused.includes("Second chapter."));
  await app.call(base + "/resume", {});
  const edited = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(edited.status, "ready", edited.error ?? "");
  deepEqual(extractionCalls, extracted);
  const after = await ask();
  match(after, /Entities = 4\nRelationships = 1/);
  match(after, /B1:C1: Carter pilots the ferry\./);
  match(after, /B2:C1: Corvin is a harbor clerk\./);
  ok(!after.includes("Corvin trains his own memory."));

  const path = app.database;
  await app.close();
  const directory = path + ".graph";
  const [index] = (await readdir(directory)).filter(file => file.endsWith(".entities.usearch"));
  ok(index);
  await unlink(join(directory, index));
  const embedded = graphEmbeddings.length;
  app = await fixture(t, provider, path, { graphResponses: "provider" });
  match(await ask(), /Entities = 4/);
  equal(graphEmbeddings.length, embedded);
  equal((await oldXray()).trace.sources["B2:C1"], "Second chapter.");
});

test("Pause aborts both active requests and Resume reuses only the work saved before Pause", async t => {
  let releasePassage!: () => void;
  let releaseGleaning!: () => void;
  const passage = new Promise<void>(resolve => { releasePassage = resolve; });
  const gleaning = new Promise<void>(resolve => { releaseGleaning = resolve; });
  t.after(() => { releasePassage(); releaseGleaning(); });
  let passageSignal: AbortSignal | undefined;
  let gleaningSignal: AbortSignal | undefined;
  let firstPasses = 0;
  let gleaningAttempts = 0;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(model, dimensions, key, text, signal) {
      if (text === "title: Book | text: efgh" && !passageSignal) {
        passageSignal = signal;
        await passage;
      }
      return fakeProvider.embed(model, dimensions, key, text, signal);
    },
    async *chat(_model, _key, body, signal) {
      const prompt = (body as Request).contents[0].parts[0].text;
      if (prompt.endsWith("#### Excerpt\nabcd")) {
        firstPasses++;
        yield { text: complete(entity("CLERK", "CHARACTER", "A clerk at the harbor.")) };
        return;
      }
      if (prompt.includes("#### Excerpt\nabcd\n\n#### Already Extracted") && ++gleaningAttempts === 1) {
        gleaningSignal = signal;
        await gleaning;
        yield { text: complete(entity("LATE", "CHARACTER", "A late provider response.")) };
        return;
      }
      yield { text: "<|COMPLETE|>" };
    },
  }, undefined, { graphResponses: "provider" });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Parallel indexing", key_ids: [key], max_chunk_size: 4,
    graph: { model: FLASH_LITE, thinking_level: "MINIMAL", gleaning_passes: 1 } }, [["Book.txt", "abcdefgh"]]);
  await until(() => passageSignal && gleaningSignal, Boolean);
  const incomplete = await app.world(world.id);
  equal(incomplete.books[0].extracted_chunks, 0);
  equal(incomplete.books[0].embedded_chunks, 1);
  equal(incomplete.can_play, true);

  const base = `/api/worlds/${world.id}`;
  const paused = await app.call<World>(base + "/pause", {});
  equal(paused.status, "paused");
  equal(paused.active_book, null);
  equal(paused.progress, 10);
  equal(passageSignal?.aborted, true);
  equal(gleaningSignal?.aborted, true);
  await app.call(base + "/resume", {});
  releasePassage();
  releaseGleaning();
  const finished = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(finished.status, "ready", finished.error ?? "");
  equal(firstPasses, 1);
  equal(gleaningAttempts, 2);
  equal(finished.books[0].extracted_chunks, 2);
  equal(finished.progress, 100);
  deepEqual(finished.graph_progress, { combined: 1, summarized: 1, embedded: 1 });
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
  equal(failed.books[0].extracted_chunks, 2);
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
  deepEqual(failedSummary.graph_progress, { combined: 2, summarized: 1, embedded: 0 });
  match(failedSummary.error!, /Could not summarize 1 graph record after 3 attempts.*FIRST CHARACTER.*<\|COMPLETE\|>/);
  equal(failedSummary.progress, 81);
  equal(skippedSummaries, 3);
  equal(completedSummaries, 1);
  summaryReady = true;
  await resume();
  const done = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(done.status, "ready", done.error ?? "");
  equal(done.books[0].extracted_chunks, 3);
  deepEqual(done.graph_progress, { combined: 2, summarized: 2, embedded: 2 });
  deepEqual(attempts.map(attempt => attempt.step), ["first", "second", "second", "second", "third", "second"]);
  equal(skippedSummaries, 4);
  equal(completedSummaries, 1);
});

test("graph name matches are whole phrases and hop ranking favors relevant edges that fit", async t => {
  let payload: Request;
  const app = await fixture(t, {
    ...fakeProvider,
    async embed(_model, dimensions, _key, text) {
      const axis = text.startsWith("task: search result") || /^title: ROOT → (?:WEST|NORTH) \|/.test(text) ? 0 : 1;
      return Array.from({ length: dimensions }, (_, index) => Number(index === axis));
    },
    async *chat(model, key, body, signal) {
      const request = body as Request;
      if (request.contents[0].parts[0].text.startsWith("#### Goal\nGiven")) {
        yield { text: complete(
          entity("ROOT", "CHARACTER", "Root runs a shop."),
          entity("WEST", "LOCATION", "By the canal."),
          entity("NORTH", "LOCATION", "A distant harbor."),
          entity("EAST", "LOCATION", "Beside the road."),
          edge("ROOT", "CHARACTER", "NORTH", "LOCATION", "A very long note. ".repeat(20), 10),
          edge("ROOT", "CHARACTER", "WEST", "LOCATION", "Root ships goods to West.", 3),
          edge("ROOT", "CHARACTER", "EAST", "LOCATION", "A lifelong tie to East.", 10),
        ) };
      } else {
        payload = request;
        yield* fakeProvider.chat(model, key, body, signal);
      }
    },
  }, undefined, { graphResponses: "provider" });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Hop ranking", key_ids: [key] }, [["Book.txt", "A very short story."]]);
  const done = await until(() => app.world(world.id), value => value.status === "ready" || value.status === "failed");
  equal(done.status, "ready", done.error ?? "");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key], graph_matches: 1, graph_edges: 1, graph_budget: 140 };
  const ask = async (question: string, options: Partial<ChatSettings> = {}) => {
    const events = await app.generate(world.id, id(), question, { ...settings, ...options });
    equal(events.at(-1).message.status, "complete", JSON.stringify(events.at(-1).error));
    return payload.systemInstruction!.parts.map(part => part.text).join("\n");
  };
  const exact = await ask("Ask Root.");
  match(exact, /ROOT \(CHARACTER\)/);
  match(exact, /ROOT → WEST/);
  ok(!exact.includes("ROOT → EAST") && !exact.includes("ROOT → NORTH"));
  const substring = await ask("Uproot it.", { graph_hops: 0 });
  match(substring, /ROOT → WEST/);
  ok(!substring.includes("ROOT (CHARACTER)"));
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
