import { deepEqual, equal, match, ok } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { MessageContext } from "../shared/inspectors.js";
import type { Tale } from "../shared/types.js";
import { fakeProvider, fixture, id, until } from "./fixture.js";

test("Message Context reconstructs the provider body and follows saved swipes across edits, branches, restart and deletion", async t => {
  const sent: string[] = [];
  const provider = {
    ...fakeProvider,
    async *chat(...[model, key, body, signal]: Parameters<typeof fakeProvider.chat>) {
      sent.push(JSON.stringify(body));
      yield* fakeProvider.chat(model, key, body, signal);
    },
  };
  let app = await fixture(t, provider);
  const key = await app.addKey("Story");
  const world = await app.newWorld({ name: "Harbor", key_ids: [key], openings: ["An unsent opening."] },
    [["Short.txt", "Mínt."], ["Long.txt", "This is a longer passage."], ["Other.txt", "Another long passage."]]);
  await until(() => app.world(world.id), item => item.status === "ready");
  const taleId = id();
  const route = `/api/worlds/${world.id}/tales/${taleId}`;
  const chunkBudget = "Book 1 — Short\n\nChunk 1\nChunk text:\nMínt.".length;
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key], chunk_budget: chunkBudget, input_limit: 256 };
  await app.generate(world.id, taleId, "Look for 🌿.", settings);
  const { messages: [opening, user, original] } = await app.call<Tale>(route);
  const xray = (swipe: number, base = route, message = original.id) =>
    app.call<MessageContext>(`${base}/xray?message=${message}&swipe=${swipe}`);
  equal(opening.has_xray, false);
  equal(user.has_xray, false);
  equal(original.has_xray, true);
  const first = await xray(0);
  equal(first.raw, sent[0]);
  equal(first.input_tokens, 4);
  equal(first.characters, first.trace.sections.reduce((total, section) => total + section.characters, 0));
  deepEqual(first.trace.chunks.map(({ name, included }) => [name, included]), [["Short", true], ["Long", false], ["Other", false]]);
  equal(first.trace.history[1].text, "Look for 🌿.");
  equal(first.trace.history[1].turn, 2);
  equal((await app.send(`${route}/xray?message=${user.id}&swipe=0`)).status, 404);

  await app.call(route + "/edit-message", { message_id: user.id, swipe: 0, content: "Look for rosemary." });
  const recompute = await app.send(route + "/generate", {
    generation_id: id(), mode: "swipe", message_id: original.id, swipe: 0, settings,
  });
  equal(recompute.status, 200);
  const streamed = (await recompute.text()).trim().split("\n").map(line => JSON.parse(line));
  equal(streamed.at(-1).message.has_xray, true);
  const second = await xray(1);
  equal(second.raw, sent[1]);
  equal(second.trace.history[1].text, "Look for rosemary.");
  const previewDatabase = new DatabaseSync(app.database);
  try {
    const row = previewDatabase.prepare(`
      SELECT c.id, c.trace FROM xray_captures c JOIN tale_messages m ON m.xray_id = c.id WHERE m.id = ?
    `).get(original.id)!;
    const trace = JSON.parse(inflateRawSync(row.trace as Uint8Array).toString("utf8"));
    trace.graph_preview = { message_id: original.id, graph: [], endpoints: [], sources: {} };
    previewDatabase.prepare("UPDATE xray_captures SET trace = ? WHERE id = ?")
      .run(deflateRawSync(JSON.stringify(trace)), Number(row.id));
  } finally { previewDatabase.close(); }
  equal((await xray(1)).trace.graph_preview?.message_id, original.id);
  equal((await app.send(`${route}/xray?message=${original.id}&swipe=0`)).status, 404);
  const branch = await app.call<Tale>(route + "/branch", { message_id: original.id, swipe: 1 });
  const branchRoute = `/api/worlds/${world.id}/tales/${branch.id}`;
  const branchReply = branch.messages.at(-1)!;
  equal((await xray(1, branchRoute, branchReply.id)).trace.graph_preview, undefined);
  await app.call(route + "/select-swipe", { message_id: original.id, swipe: 1, position: 0 });
  equal((await xray(0)).raw, first.raw);
  await app.call(route + "/delete-message", { message_id: original.id, swipe: 0, mode: "swipe" });
  equal((await xray(0)).raw, second.raw);

  const replacement = await app.send(route + "/generate", {
    generation_id: id(), mode: "regenerate", message_id: original.id, swipe: 0, settings,
  });
  equal(replacement.status, 200);
  await replacement.text();
  equal((await xray(0)).trace.graph_preview, undefined);

  const database = app.database;
  await app.close();
  app = await fixture(t, provider, database);
  await app.call(route + "/delete", {});
  equal((await xray(1, branchRoute, branchReply.id)).raw, second.raw);
  let db = new DatabaseSync(database, { readOnly: true });
  try {
    ok(Number(db.prepare("SELECT count(*) AS total FROM xray_blobs").get()!.total) > 0);
    equal(db.prepare("SELECT count(*) AS total FROM xray_captures").get()!.total, 2);
  } finally { db.close(); }
  await app.call(branchRoute + "/delete", {});
  db = new DatabaseSync(database, { readOnly: true });
  try {
    equal(db.prepare("SELECT count(*) AS total FROM xray_captures").get()!.total, 0);
    equal(db.prepare("SELECT count(*) AS total FROM xray_blobs").get()!.total, 0);
  } finally { db.close(); }
});

test("a failed model request has its actual request capture and capture failure still saves the reply", async t => {
  let failing = true;
  let raw = "";
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(model, key, payload, signal, options) {
      raw = JSON.stringify(payload);
      if (failing) throw new Error("Provider rejected the request.");
      options?.onPromptTokens?.(812);
      yield* fakeProvider.chat(model, key, payload, signal);
    },
  });
  const key = await app.addKey("Story");
  const world = await app.newWorld({ name: "Harbor", key_ids: [key] }, [["Story.txt", "A cliff."]]);
  await until(() => app.world(world.id), item => item.status === "ready");
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  const failedId = id();
  const events = await app.generate(world.id, failedId, "A failed request.", settings);
  const failed = events.at(-1).message;
  equal(failed.status, "error");
  equal(failed.has_xray, true);
  const capture = await app.call<MessageContext>(`/api/worlds/${world.id}/tales/${failedId}/xray?swipe=0&message=${failed.id}`);
  equal(capture.raw, raw);
  equal(capture.input_tokens, null);

  failing = false;
  const successId = id();
  const success = (await app.generate(world.id, successId, "A working request.", settings)).at(-1).message;
  equal((await app.call<MessageContext>(`/api/worlds/${world.id}/tales/${successId}/xray?swipe=0&message=${success.id}`)).input_tokens, 812);
  const db = new DatabaseSync(app.database);
  try {
    db.exec(`CREATE TRIGGER test_fail_capture BEFORE INSERT ON xray_captures BEGIN
      SELECT RAISE(ABORT, 'fixture capture failure');
    END;`);
  } finally { db.close(); }
  const missingId = id();
  const saved = (await app.generate(world.id, missingId, "Save the reply anyway.", settings)).at(-1).message;
  equal(saved.status, "complete");
  equal(saved.has_xray, false);
  equal(saved.xray_error, true);
  match((await app.call<Tale>(`/api/worlds/${world.id}/tales/${missingId}`)).messages.at(-1)!.content, /Reply/);
});
