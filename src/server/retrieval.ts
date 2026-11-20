import type { ChatSettings } from "../shared/types.js";
import { InputTooLarge, LEGACY_EMBEDDING, tokenBody, type GeminiClient } from "./gemini.js";
import { pythonWorker } from "./python.js";
import type { WorldRow } from "./worlds.js";

export type HistoryEntry = { role: "user" | "assistant"; content: string; model?: string | null; signed_parts?: string | null };

export async function retrievalVector(provider: GeminiClient, world: WorldRow, nextKey: () => string,
  history: HistoryEntry[], signal: AbortSignal) {
  const text = (messages: HistoryEntry[]) => "task: search result | query: " + messages.map(message => message.content).join("\n\n");
  const count = (messages: HistoryEntry[]) => provider.count(world.model, nextKey(), tokenBody(text(messages)), signal);
  const embed = (messages: HistoryEntry[]) => provider.embed(world.model, world.dimensions, nextKey(), text(messages), signal);
  let messages = history;
  if (world.model === LEGACY_EMBEDDING) {
    while (messages.length) {
      if (await count(messages) <= world.max_token_limit) return embed(messages);
      messages = messages.slice(1);
    }
    throw new InputTooLarge();
  }

  for (;;) {
    try { return await embed(messages); }
    catch (error) {
      if (!(error instanceof InputTooLarge) || messages.length <= 1) throw error;
      messages = messages.slice(1);
    }
    while (messages.length > 1) {
      try { if (await count(messages) <= world.max_token_limit) break; }
      catch (error) { if (!(error instanceof InputTooLarge)) throw error; }
      messages = messages.slice(1);
    }
  }
}

export async function openRetrieval(database: string, worldId: string, signal: AbortSignal) {
  const worker = pythonWorker("retrieve", signal);
  try {
    await worker.send({ database, worldId });
    const { world } = await worker.receive<{ world: WorldRow }>();
    return {
      world,
      async build(vector: number[], history: HistoryEntry[], settings: ChatSettings) {
        await worker.send({ vector, history, settings });
        const { payload } = await worker.receive<{ payload: object }>();
        return payload;
      },
      close: worker.close,
    };
  } catch (error) { worker.close(); throw error; }
}
