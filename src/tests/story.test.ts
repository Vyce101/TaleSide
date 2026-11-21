import { deepEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { GenerationEvent, Persona, Tale } from "../shared/types.js";
import { fakeProvider, fixture, id, until } from "./fixture.js";

test("opening alternatives and AI swipes follow the selected reply through editing, branching and deletion", async t => {
  const requests: object[] = [];
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(_model, _key, body) {
      requests.push(body);
      const number = requests.length;
      if (number === 4 || number === 6) throw new Error("Unavailable");
      yield { text: `Thought ${number}`, thought: true };
      yield { text: `Reply ${number}`, thoughtSignature: `signature-${number}` };
      if (number === 5) throw new Error("Interrupted");
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Story", openings: ["", "Opening A", "Opening B"], key_ids: [key] },
    [["Book.txt", "A passage"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const route = `/api/worlds/${world.id}/tales/${id()}`;
  const settings = { ...(await app.profiles()).defaults, chat_key_ids: [key] };
  const generate = async (input: object): Promise<GenerationEvent[]> => {
    const response = await app.send(route + "/generate", { generation_id: id(), settings, title: "Tale", ...input });
    ok(response.ok);
    return (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  };
  const getTale = () => app.call<Tale>(route);
  await generate({ content: "Continue", opening: 1 });
  let [opening, user, reply] = (await getTale()).messages;
  equal(opening.content, "Opening B");
  equal(opening.swipes?.length, 2);
  match(JSON.stringify(requests[0]), /"role":"model".*Opening B.*"role":"user".*Continue/);
  const change = (action: string, message: typeof reply, input: object = {}) =>
    app.call<Tale>(`${route}/${action}`, { message_id: message.id, swipe: message.swipe, ...input });
  await generate({ mode: "swipe", message_id: reply.id, swipe: 0 });
  reply = (await getTale()).messages[2];
  equal(reply.swipe, 1);
  deepEqual(reply.swipes?.map(swipe => [swipe.content, swipe.thinking, swipe.has_signature]),
    [["Reply 1", "Thought 1", true], ["Reply 2", "Thought 2", true]]);
  ok(!JSON.stringify(requests[1]).includes("signature-1"));
  await generate({ mode: "regenerate", message_id: reply.id, swipe: 1 });
  const failed = await generate({ mode: "regenerate", message_id: reply.id, swipe: 1 });
  equal(failed.at(-1)?.type, "done");
  equal((await getTale()).messages[2].content, "");
  equal((await getTale()).messages[2].swipes?.[0].content, "Reply 1");
  await generate({ mode: "swipe", message_id: reply.id, swipe: 1 });
  reply = (await getTale()).messages[2];
  equal(reply.content, "Reply 5");
  equal(reply.status, "error");
  equal(reply.swipes?.length, 3);
  reply = (await change("select-swipe", reply, { position: 0 })).messages[2];
  reply = (await change("edit-message", reply, { content: " Reply 1 " })).messages[2];
  equal(reply.has_signature, true);
  reply = (await change("edit-message", reply, { content: "Edited reply" })).messages[2];
  equal(reply.has_signature, false);
  equal(reply.thinking, "Thought 1");
  equal(reply.swipes?.[1].has_signature, false);
  equal(reply.swipes?.[2].has_signature, true);
  await generate({ mode: "swipe", message_id: reply.id, swipe: 0 });
  let selected = (await getTale()).messages[2];
  equal(selected.swipe, 3);
  equal(selected.content, "");
  equal(selected.swipes?.length, 4);
  selected = (await change("select-swipe", selected, { position: 0 })).messages[2];
  await change("edit-message", selected, { content: " Edited reply " });
  await generate({ content: "New message" });
  ok(JSON.stringify(requests.at(-1)).includes("Edited reply"));
  ok(!JSON.stringify(requests.at(-1)).includes("signature-1"));

  const branch = await change("branch", reply);
  deepEqual(branch.messages.map(message => message.content), ["Opening B", "Continue", "Edited reply"]);
  equal(branch.messages[0].swipes?.length, 1);
  equal(branch.messages[2].swipes?.length, 4);
  const atOpening = await change("branch", opening);
  equal(atOpening.messages[0].swipes?.length, 2);
  equal(atOpening.messages[0].swipe, 1);
  const rewind = await change("delete-message", user, { mode: "rewind" });
  deepEqual(rewind.messages.map(message => message.content), ["Opening B"]);
  const afterDelete = await change("delete-message", opening, { mode: "swipe" });
  equal(afterDelete.messages[0].content, "Opening A");
  const empty = await change("delete-message", afterDelete.messages[0], { mode: "message" });
  deepEqual(empty.messages, []);
});

test("prompt roles and built-in toggles affect Gemini input while Personas preserve older user identities", async t => {
  const requests: { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: { text?: string }[] }[] }[] = [];
  const app = await fixture(t, {
    ...fakeProvider,
    async *chat(model, key, body, signal) {
      requests.push(body as typeof requests[number]);
      yield* fakeProvider.chat(model, key, body, signal);
    },
  });
  const key = await app.addKey("Gemini");
  const world = await app.newWorld({ name: "Story", description: "", openings: [""], key_ids: [key] },
    [["Book.txt", "A passage"]]);
  await until(() => app.world(world.id), value => value.status === "ready");
  const created = await app.call<Persona>("/api/personas/create", {});
  for (const [field, value] of [["name", "Ari"], ["nickname", "Secret nickname"], ["description", "A cartographer"]]) {
    await app.call("/api/personas/save", { id: created.id, field, value });
  }
  await app.call("/api/personas/default", { id: created.id, enabled: true, world: world.id });
  const state = await app.profiles();
  const base = state.defaults.prompts!.filter(block => block.kind !== "custom").map(block => ({
    ...block, enabled: block.kind !== "retrieved_passages" && block.kind !== "chat_history",
  }));
  const settings = { ...state.defaults, chat_key_ids: [key], prompts: [...base,
    { id: "example", kind: "custom" as const, enabled: true, name: "Reply example", role: "model" as const, text: "Model example" },
    { id: "late", kind: "custom" as const, enabled: true, name: "Late system", role: "system" as const, text: "Late instruction" },
  ] };
  const story = id();
  const route = `/api/worlds/${world.id}/tales/${story}`;
  await app.generate(world.id, story, "First line", settings);
  const first = requests[0];
  const tally = (await app.call<Tale>(route)).prompt_counts!;
  equal(tally.blocks.chat_history, 10);
  equal(tally.blocks.example, 13);
  equal(tally.blocks.late, 16);
  equal(tally.blocks.retrieved_passages, 0);
  equal(tally.blocks.world_description, 0);
  equal(tally.total, Object.values(tally.blocks).reduce((sum, count) => sum + count, 0));
  equal("prompt_counts" in first, false);
  deepEqual(first.contents.map(item => item.role), ["user", "model", "system"]);
  deepEqual(first.contents[2].parts, [{ text: "Late instruction" }]);
  const system = first.systemInstruction!.parts.map(part => part.text).join("\n");
  match(system, /<persona>\nName = Ari\nDescription = A cartographer\n<\/persona>/);
  ok(!system.includes("Secret nickname") && !system.includes("world_description") && !system.includes("retrieved_passages"));
  await app.call("/api/personas/save", { id: created.id, field: "name", value: "Renamed" });
  await app.generate(world.id, story, "Second line", settings);
  ok(!JSON.stringify(requests[1]).includes("First line"));
  const reassigned = { ...settings, prompts: base.map(block => ({
    ...block, ...(block.kind === "chat_history" ? { enabled: true, role: "user" as const } : {}),
    ...(block.kind === "persona" ? { role: "model" as const } : {}),
  })) };
  await app.generate(world.id, story, "Third line", reassigned);
  deepEqual(requests[2].contents.map(item => item.role), ["model", "user"]);
  match(JSON.stringify(requests[2].contents[1]), /First line.*Reply.*Second line.*Reply.*Third line/);
  ok(!JSON.stringify(requests[2]).includes("thoughtSignature"));
  await app.call("/api/personas/delete", { id: created.id });
  const saved = await app.call<Tale>(route);
  equal(saved.persona_id, "user");
  deepEqual(saved.messages.filter(message => message.role === "user").map(message => message.player_name), ["Ari", "Renamed", "Renamed"]);
  const locked = await app.call<typeof state>("/api/chat-profiles/save", { id: state.selected, settings });
  equal(locked.profiles[0].settings.prompts?.length, 13);
  equal((await app.send("/api/chat-profiles/delete", { id: state.selected })).status, 400);
});

