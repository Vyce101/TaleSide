import type { ChatModel, EmbeddingModel } from "../shared/types.js";

export const EMBEDDING_MODEL = "gemini-embedding-2";
export const LEGACY_EMBEDDING = "gemini-embedding-001";
export const EMBEDDING_MODELS: EmbeddingModel[] = [
  { id: EMBEDDING_MODEL, dimensions: 3072, max_token_limit: 8192 },
  { id: LEGACY_EMBEDDING, dimensions: 3072, max_token_limit: 2040 },
];
export const CHAT_MODEL: ChatModel = {
  id: "gemini-4-hydrogen", context_limit: 1048576, max_output: 65536,
  thinking_levels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
};
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
    throw new Error(`Could not reach Gemini for ${method}.`);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message = String(detail?.error?.message ?? "");
    if (response.status === 413 || (response.status === 400 && /token|context|input|payload|request size/i.test(message))) {
      throw new InputTooLarge();
    }
    if ([401, 403].includes(response.status)) throw new Error("Gemini denied access. Check the selected API key.");
    throw new Error(`Gemini ${method} returned HTTP ${response.status}.`);
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
    if (!Number.isSafeInteger(json.totalTokens) || json.totalTokens < 1) throw new Error("Gemini returned an invalid token count.");
    return json.totalTokens;
  },
  async embed(model, dimensions, key, text, signal) {
    const content = { parts: [{ text }] };
    const body = model === LEGACY_EMBEDDING ? { content, outputDimensionality: dimensions }
      : { content, embedContentConfig: { outputDimensionality: dimensions, autoTruncate: false } };
    const response = await request(model, key, "embedContent", body, signal);
    const json = await response.json();
    const values = json.embedding?.values;
    encodeVector(values, dimensions);
    return values;
  },
  async *chat(model, key, body, signal) {
    const response = await request(model, key, "streamGenerateContent", body, signal, true);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          const packet = JSON.parse(payload);
          if (packet.error) throw new Error("Gemini could not finish the reply.");
          for (const part of packet.candidates?.[0]?.content?.parts ?? []) yield part;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  },
};
