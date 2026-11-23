import type { DatabaseSync } from "node:sqlite";
import { CHAT_MODELS } from "../shared/models.js";
import type { GraphSettings, World } from "../shared/types.js";
import { all, get, run, selectedKeys, transaction } from "./database.js";
import type { GeminiClient } from "./gemini.js";
import {
  extractionPrompt, graphRequest, MAX_GRAPH_ATTEMPTS,
  newRecords, parseExtraction, type Extraction,
} from "./graph-extraction.js";
import type { ProviderKeys } from "./keys.js";
import { fields, RequestError, whole } from "./validation.js";

export type GraphWorldFields = { graph_settings: string | null; graph_published: number | null;
  graph_base: number | null; graph_building: number | null };
type IndexedWorld = Pick<World, "id" | "model" | "dimensions" | "status"> & GraphWorldFields & { index_number: number };
type Chunk = { book_id: string; book: number; number: number; text: string; preceding: string };

export class GraphRequestFailed extends Error {}

export function readGraphSettings(value: unknown, chunkSize: number, required: boolean): GraphSettings {
  const input = value === undefined ? {} : fields(value);
  const model = CHAT_MODELS.find(model => model.id === input.model);
  if ((!model && (required || input.model)) || (input.model !== undefined && typeof input.model !== "string")) {
    throw new RequestError("Choose an extraction model in Indexing.");
  }
  const thinking = input.thinking_level ?? "";
  if (typeof thinking !== "string" || ((required || thinking) && !model?.thinking_levels.includes(thinking))) {
    throw new RequestError("Choose an extraction thinking level in Indexing.");
  }
  return {
    model: model?.id ?? "", thinking_level: thinking,
    preceding_context: whole(input.preceding_context ?? Math.round(chunkSize / 10), 0, "Enter a nonnegative preceding context length."),
    gleaning_passes: whole(input.gleaning_passes ?? 3, 0, "Enter a nonnegative number of gleaning passes."),
  };
}

export class GraphJobs {
  constructor(private db: DatabaseSync, private keys: ProviderKeys, private provider: GeminiClient) {}

  nextChunk(world: IndexedWorld, settings: GraphSettings, after: Pick<Chunk, "book" | "number">) {
    return get<Chunk>(this.db, `
      SELECT b.id AS book_id, b.number AS book, c.number,
        substr(b.working, c.start + 1, c.end - c.start) AS text,
        CASE WHEN previous.number IS NULL OR ? = 0 THEN '' ELSE
          substr(b.working, max(previous.start, c.start - ?) + 1, min(?, c.start - previous.start))
        END AS preceding
      FROM books b JOIN chunks c ON c.book_id = b.id
      LEFT JOIN chunks previous ON previous.book_id = c.book_id AND previous.index_number = c.index_number AND previous.number = c.number - 1
      LEFT JOIN graph_chunks g ON g.book_id = c.book_id AND g.index_number = c.index_number AND g.chunk_number = c.number
      WHERE b.world_id = ? AND c.index_number = ? AND coalesce(g.complete, 0) = 0
        AND (b.number, c.number) > (?, ?) ORDER BY b.number, c.number LIMIT 1
    `, settings.preceding_context, settings.preceding_context, settings.preceding_context,
    world.id, world.index_number, after.book, after.number);
  }

  private async request<T>(world: IndexedWorld, settings: GraphSettings, prompt: string, signal: AbortSignal,
    working: () => boolean, parse: (text: string) => T) {
    const keys = selectedKeys(this.db, "world_extraction_keys", world.id);
    const model = CHAT_MODELS.find(model => model.id === settings.model)!;
    const payload = graphRequest(settings, prompt, model.max_output);
    for (let attempt = 1; ; attempt++) {
      try {
        const { readKey } = this.keys.attempts("extraction", keys, signal).next().value!;
        let answer = "";
        for await (const part of this.provider.chat(model.id, readKey(), payload, signal)) {
          signal.throwIfAborted();
          if (!part.thought && typeof part.text === "string") answer += part.text;
        }
        signal.throwIfAborted();
        return parse(answer);
      } catch (error) {
        if (!working()) throw error;
        if (attempt === MAX_GRAPH_ATTEMPTS) {
          throw new GraphRequestFailed(error instanceof Error ? error.message : "The extraction model request failed.");
        }
      }
    }
  }

  async extract(world: IndexedWorld, settings: GraphSettings, chunk: Chunk, signal: AbortSignal, working: () => boolean) {
    const key = [chunk.book_id, world.index_number, chunk.number] as const;
    const passes = all<{ records: string }>(this.db, `
      SELECT records FROM graph_passes WHERE book_id = ? AND index_number = ? AND chunk_number = ? ORDER BY pass
    `, ...key);
    const previous = newRecords(passes.flatMap(pass => JSON.parse(pass.records) as Extraction[]), []);
    const pass = passes.length;
    const records = await this.request(world, settings, extractionPrompt(chunk.preceding, chunk.text, pass ? previous : undefined),
      signal, working, text => parseExtraction(text, previous));
    const complete = pass >= settings.gleaning_passes || (pass > 0 && !newRecords(records, previous).length);
    transaction(this.db, () => {
      run(this.db, `
        INSERT INTO graph_chunks (book_id, index_number, chunk_number, complete) VALUES (?, ?, ?, ?)
        ON CONFLICT (book_id, index_number, chunk_number) DO UPDATE SET complete = excluded.complete
      `, ...key, Number(complete));
      run(this.db, "INSERT INTO graph_passes VALUES (?, ?, ?, ?, ?)", ...key, pass, JSON.stringify(records));
    });
    return complete;
  }

}
