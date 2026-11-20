import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { ChatSettings, KeySettings, ProfileSettings, World } from "../shared/types.js";
import type { GeminiClient } from "../server/gemini.js";
import { createApplication, listen } from "../server/http.js";

const testRoot = fileURLToPath(new URL("../../data/", import.meta.url));

export const fakeProvider: GeminiClient = {
  async count() { return 4; },
  async embed(_model, dimensions) { return Array.from({ length: dimensions }, (_, index) => Number(index === 0)); },
  async *chat() { yield { text: "Thought", thought: true }; yield { text: "**Reply**", thoughtSignature: "signature" }; },
};

export function id() { return randomUUID().replaceAll("-", ""); }

const cleanupByTest = new WeakMap<TestContext, { directories: string[]; close: (() => Promise<void>)[] }>();

function cleanup(t: TestContext) {
  const existing = cleanupByTest.get(t);
  if (existing) return existing;
  const registered = { directories: [] as string[], close: [] as (() => Promise<void>)[] };
  cleanupByTest.set(t, registered);
  t.after(async () => {
    for (const close of registered.close) await close();
    for (const directory of registered.directories) {
      assert(resolve(directory).startsWith(resolve(testRoot) + sep));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return registered;
}

export async function databasePath(t: TestContext) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "node-test-"));
  cleanup(t).directories.push(directory);
  return join(directory, "worlds.sqlite3");
}

export async function fixture(t: TestContext, provider: GeminiClient = fakeProvider, path?: string) {
  const database = path ?? await databasePath(t);
  const app = await createApplication(database, { provider, protect: (_operation, input) => Buffer.from(input) });
  const { origin, server } = await listen(0);
  server.on("request", (request, response) => app.handle(request, response, origin));
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      await app.close();
      await stopped;
    })();
    return closing;
  }
  cleanup(t).close.push(close);

  function send(route: string, input?: object, headers?: HeadersInit) {
    if (input === undefined) return fetch(origin + route, { headers });
    const requestHeaders = new Headers(headers ?? { Origin: origin });
    if (!(input instanceof FormData)) requestHeaders.set("Content-Type", "application/json");
    return fetch(origin + route, { method: "POST", headers: requestHeaders,
      body: input instanceof FormData ? input : JSON.stringify(input) });
  }

  async function call<T>(route: string, input?: object): Promise<T> {
    const response = await send(route, input);
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  }
  const world = (worldId: string) => call<World>(`/api/worlds/${worldId}`);
  const keys = () => call<KeySettings>("/api/settings");
  const profiles = () => call<ProfileSettings>("/api/tale-settings");
  const addKey = (nickname: string, secret = `fixture-placeholder-${nickname.replaceAll(" ", "-")}`) => call<{ id: string }>(
    "/api/provider-keys", { nickname, secret }).then(key => key.id);

  async function newWorld(settings: object, books: [string, string][], worldId = id()) {
    return call<World>(`/api/worlds/${worldId}/create`, upload(settings, books));
  }

  async function generate(worldId: string, taleId: string, content: string, settings: ChatSettings, generationId = id()) {
    const response = await send(`/api/worlds/${worldId}/tales/${taleId}/generate`,
      { title: "A World Tale", generation_id: generationId, content, settings });
    assert(response.ok);
    return (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  }
  return { origin, database, close, send, call, world, keys, profiles, addKey, newWorld, generate };
}

export function upload(settings: object, books: [string, string][]) {
  const form = new FormData();
  form.append("settings", JSON.stringify({ ...settings, books: books.map(([filename]) => ({ filename, name: filename.slice(0, -4) })) }));
  for (const [filename, text] of books) form.append("book", new Blob([text], { type: "text/plain" }), filename);
  return form;
}

export async function until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean) {
  const deadline = Date.now() + 6000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await pause(15);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for TaleSide state.");
}
