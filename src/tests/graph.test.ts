import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { FLASH_LITE, GEMMA, HYDROGEN } from "../shared/models.js";
import { fakeProvider, fixture, id, until } from "./fixture.js";

type Request = { contents: { role: string; parts: { text: string; thought?: boolean; thoughtSignature?: string }[] }[];
  generationConfig: Record<string, unknown>; systemInstruction?: { parts: { text: string }[] } };

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
