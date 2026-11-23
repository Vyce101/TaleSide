import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToServer } from "node:timers/promises";
import { CHAT_MODELS } from "../shared/models.js";
import type { GraphSettings, World } from "../shared/types.js";
import { all, get, run, selectedKeys, transaction } from "./database.js";
import { encodeVector, type GeminiClient } from "./gemini.js";
import {
  consolidationPrompt, extractionPrompt, graphRequest, MAX_GRAPH_ATTEMPTS,
  newRecords, parseConsolidation, parseExtraction, type Extraction,
} from "./graph-extraction.js";
import { resolveGraph } from "./graph-resolution.js";
import type { GraphIndexes } from "./graph-indexes.js";
import type { ProviderKeys } from "./keys.js";
import { fields, RequestError, whole } from "./validation.js";

export type GraphWorldFields = { graph_settings: string | null; graph_published: number | null;
  graph_base: number | null; graph_building: number | null };
type IndexedWorld = Pick<World, "id" | "model" | "dimensions" | "status"> & GraphWorldFields & { index_number: number };
type Chunk = { book_id: string; book: number; number: number; text: string; preceding: string };
type Summary = { id: number; name: string; type: string | null; input: string };

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

export function graphRecordTitle(name: string, type: string | null) {
  return type ? `${name} (${type})` : name;
}

function renderedLength(record: Pick<Summary, "name" | "type">, description: string) {
  return Array.from(graphRecordTitle(record.name, record.type) + "\n" + description).length;
}

export class GraphJobs {
  private embeddingCooldown = new Map<string, number>();

  constructor(private db: DatabaseSync, private keys: ProviderKeys, private provider: GeminiClient,
    private indexes: GraphIndexes) {}

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

  prepare(world: IndexedWorld) {
    const rows = this.db.prepare(`
      SELECT b.number AS book, p.chunk_number AS chunk, p.records FROM graph_passes p
      JOIN books b ON b.id = p.book_id
      WHERE b.world_id = ? AND p.index_number = ? ORDER BY b.number, p.chunk_number, p.pass
    `).iterate(world.id, world.index_number) as Iterable<{ book: number; chunk: number; records: string }>;
    const graph = resolveGraph(rows);
    return transaction(this.db, () => {
      const generation = Number(run(this.db, "INSERT INTO graph_generations (world_id, dimensions) VALUES (?, ?)",
        world.id, world.dimensions).lastInsertRowid);
      const reused = this.db.prepare(`
        SELECT description, characters, vector FROM graph_records WHERE generation = ? AND identity = ? AND fingerprint = ?
      `);
      const insert = this.db.prepare(`
        INSERT INTO graph_records (generation, identity, name, type, source, target, strength, fingerprint, input,
          description, characters, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ids = new Map<string, number>();
      for (const record of graph) {
        const previous = world.graph_base === null ? undefined : reused.get(world.graph_base, record.identity, record.fingerprint);
        const description = previous?.description as string | undefined ?? (record.descriptions === 1 ? record.input : null);
        const type = record.type ?? null;
        const characters = description === null ? null : renderedLength({ name: record.name, type }, description);
        const { lastInsertRowid } = insert.run(generation, record.identity, record.name, type,
          record.source ? ids.get(record.source)! : null, record.target ? ids.get(record.target)! : null,
          record.strength ?? null, record.fingerprint, record.input, description, characters, previous?.vector ?? null);
        ids.set(record.identity, Number(lastInsertRowid));
      }
      run(this.db, "UPDATE worlds SET graph_building = ? WHERE id = ?", generation, world.id);
      return generation;
    });
  }

  async summarize(world: IndexedWorld, settings: GraphSettings, generation: number, signal: AbortSignal, working: () => boolean) {
    let after = 0;
    let skipped = 0;
    let lastError = "";
    while (working()) {
      const summary = get<Summary>(this.db, `
        SELECT id, name, type, input FROM graph_records
        WHERE generation = ? AND vector IS NULL AND description IS NULL AND id > ? ORDER BY id LIMIT 1
      `, generation, after);
      if (!summary) break;
      after = summary.id;
      const prompt = consolidationPrompt(summary.type ?? "relationship", summary.name, summary.input);
      try {
        const description = await this.request(world, settings, prompt, signal, working, text => parseConsolidation(text, summary.input));
        run(this.db, "UPDATE graph_records SET description = ?, characters = ? WHERE id = ?",
          description, renderedLength(summary, description), summary.id);
      } catch (error) {
        if (!(error instanceof GraphRequestFailed)) throw error;
        skipped++;
        lastError = `${summary.name}. ${error.message}`;
      }
      await yieldToServer();
    }
    if (skipped && working()) {
      throw new Error(`Could not summarize ${skipped} graph ${skipped === 1 ? "record" : "records"} after ${MAX_GRAPH_ATTEMPTS} attempts each. Last failure for ${lastError}`);
    }
  }

  async finishNext(world: IndexedWorld, generation: number, signal: AbortSignal, working: () => boolean) {
    const draft = get<{ id: number; name: string; description: string }>(this.db, `
      SELECT id, name, description FROM graph_records WHERE generation = ? AND vector IS NULL ORDER BY id LIMIT 1
    `, generation);
    if (!draft) {
      await this.indexes.build(generation, signal);
      return true;
    }
    const keys = selectedKeys(this.db, "world_embedding_keys", world.id);
    const vector = await this.keys.retry("embedding", keys, signal, async key => {
      const values = await this.provider.embed(world.model, world.dimensions, key, `title: ${draft.name} | text: ${draft.description}`, signal);
      return encodeVector(values, world.dimensions);
    }, { cooldown: this.embeddingCooldown, paused: () => !working() });
    run(this.db, "UPDATE graph_records SET vector = ? WHERE id = ?", vector, draft.id);
    return false;
  }
}
