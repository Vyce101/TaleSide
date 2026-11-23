import type { EmbeddingModel } from "../shared/types.js";
import { RequestError } from "./validation.js";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export const LEGACY_EMBEDDING = "gemini-embedding-001";
export const EMBEDDING_MODELS: EmbeddingModel[] = [
  { id: EMBEDDING_MODEL, dimensions: 3072, max_token_limit: 8192 },
  { id: LEGACY_EMBEDDING, dimensions: 3072, max_token_limit: 2040 },
];
export const INPUT_LIMIT_ERROR = "The full request exceeds the input token limit.";

export class InputTooLarge extends Error {
  constructor() { super(INPUT_LIMIT_ERROR); }
}

export type Part = { text?: string; thought?: boolean; thoughtSignature?: string };
export type GeminiClient = {
  count: (model: string, key: string, body: object, signal: AbortSignal) => Promise<number>;
  embed: (model: string, dimensions: number, key: string, text: string, signal: AbortSignal) => Promise<number[]>;
  chat: (model: string, key: string, body: object, signal: AbortSignal) => AsyncIterable<Part>;
};

class ProviderError extends RequestError {
  constructor(status: number, detail: unknown, key: string) {
    const error = detail && typeof detail === "object" ? detail as { code?: unknown; message?: unknown } : null;
    const safe = (value: string) => value.replaceAll(key, "[redacted]")
      .replace(/AIza[\w-]{20,}/g, "[redacted]");
    const original = typeof detail === "string" ? detail : typeof error?.message === "string" ? error.message : "";
    const message = /^\s*(?:<!doctype\s+html|<html\b)/i.test(original) ? "" : safe(original);
    const code = Number.isInteger(error?.code) ? error!.code as number : status;
    super(message || "The provider did not return a readable error message.",
      status >= 400 && status <= 599 ? status : code >= 400 && code <= 599 ? code : 502);
  }
}

async function readError(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        try { return JSON.parse(text); }
        catch { return response.headers.get("content-type")?.startsWith("text/plain") ? text : null; }
      }
      bytes += value.byteLength;
      if (bytes > 64 * 1024) return null;
      text += decoder.decode(value, { stream: true });
    }
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

async function request(model: string, key: string, method: string, body: object, signal: AbortSignal, stream = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}${stream ? "?alt=sse" : ""}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(stream ? 300000 : 30000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RequestError(`Could not reach Gemini for ${method}.`, 502);
  }
  if (!response.ok) {
    const detail = await readError(response);
    throw new ProviderError(response.status, detail?.error ?? detail, key);
  }
  return response;
}

export function encodeVector(values: unknown, dimensions: number) {
  if (!Array.isArray(values) || values.length !== dimensions) throw new Error("Gemini returned an invalid embedding vector.");
  const buffer = Buffer.alloc(dimensions * 4);
  let nonzero = false;
  values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(Math.fround(value))) throw new Error("Gemini returned an invalid embedding vector.");
    const rounded = Math.fround(value);
    buffer.writeFloatLE(rounded, index * 4);
    nonzero ||= rounded !== 0;
  });
  if (!nonzero) throw new Error("Gemini returned an invalid embedding vector.");
  return buffer;
}

export function tokenBody(text: string) {
  return { contents: [{ parts: [{ text }] }] };
}

export const gemini: GeminiClient = {
  async count(model, key, body, signal) {
    const response = await request(model, key, "countTokens", body, signal);
    const json = await response.json();
    if (json.error) throw new ProviderError(0, json.error, key);
    if (!Number.isSafeInteger(json.totalTokens) || json.totalTokens < 1) throw new Error("Gemini returned an invalid token count.");
    return json.totalTokens;
  },
  async embed(model, dimensions, key, text, signal) {
    const content = { parts: [{ text }] };
    const body = model === LEGACY_EMBEDDING ? { content, outputDimensionality: dimensions }
      : { content, embedContentConfig: { outputDimensionality: dimensions, autoTruncate: false } };
    const response = await request(model, key, "embedContent", body, signal);
    const json = await response.json();
    if (json.error) throw new ProviderError(0, json.error, key);
    const values = json.embedding?.values;
    encodeVector(values, dimensions);
    return values;
  },
  async *chat(model, key, body, signal) {
    const response = await request(model, key, "streamGenerateContent", body, signal, true);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let errorEvent = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? "\n" : value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) { errorEvent = false; continue; }
          if (line.trim() === "event: error") { errorEvent = true; continue; }
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const packet = JSON.parse(payload);
          if (errorEvent || packet.error) throw new ProviderError(0, packet.error ?? packet, key);
          for (const part of packet.candidates?.[0]?.content?.parts ?? []) yield part;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  },
};
