import type { ChatSettings, PromptCounts } from "../shared/types.js";
import { InputTooLarge, LEGACY_EMBEDDING } from "./gemini.js";
import { pythonWorker } from "./python.js";
import type { WorldRow } from "./worlds.js";

export type HistoryEntry = { role: "user" | "assistant"; content: string; model?: string | null; signed_parts?: string | null };

export async function retrievalVector(world: WorldRow, history: HistoryEntry[],
  count: (text: string) => Promise<number>, embed: (text: string) => Promise<number[]>) {
  const text = (messages: HistoryEntry[]) => "task: search result | query: " + messages.map(message => message.content).join("\n\n");
  if (world.model !== LEGACY_EMBEDDING) return embed(text(history));
  for (let start = 0; start < history.length; start++) {
    const query = text(history.slice(start));
    if (await count(query) <= world.max_token_limit) return embed(query);
  }
  throw new InputTooLarge();
}

export async function openRetrieval(database: string, worldId: string, signal: AbortSignal) {
  const worker = pythonWorker("retrieve", signal);
  try {
    await worker.send({ database, worldId });
    const { world } = await worker.receive<{ world: WorldRow }>();
    return {
      world,
      async build(vector: number[], history: HistoryEntry[], settings: ChatSettings, context: { description: string; persona: { name: string; description: string } }) {
        await worker.send({ vector, history, settings, context });
        return worker.receive<{ payload: object; prompt_counts: PromptCounts }>();
      },
      close: worker.close,
    };
  } catch (error) { worker.close(); throw error; }
}
