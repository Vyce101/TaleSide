import { deepEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { Persona, Tale } from "../shared/types.js";
import { fakeProvider, fixture, id, until } from "./fixture.js";

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
