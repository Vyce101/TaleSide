import { deepEqual, equal, match, rejects } from "node:assert/strict";
import { test } from "node:test";
import { gemini } from "../server/gemini.js";

test("Gemini forwards HTTP and streaming provider errors with credentials removed", async t => {
  const key = "fixture-private-key";
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Quota exceeded for ${key}` },
  }), { status: 429 }));
  await rejects(gemini.count("fixture", key, {}, signal), {
    status: 429, message: "Gemini · 429 RESOURCE_EXHAUSTED: Quota exceeded for [redacted]",
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
    match(String(error), /503 UNAVAILABLE: Capacity exhausted/);
    return true;
  });
  deepEqual(parts, ["Partial"]);
});
