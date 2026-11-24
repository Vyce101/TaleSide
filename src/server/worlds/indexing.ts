import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToServer } from "node:timers/promises";
import type { GraphProgress, GraphSettings } from "../../shared/types.js";
import { EMBEDDING_MODELS, encodeVector, tokenBody, type GeminiClient } from "../gemini.js";
import { MAX_GRAPH_ATTEMPTS } from "../graph/extraction.js";
import type { GraphIndexes } from "../graph/indexes.js";
import { GraphJobs, GraphRequestFailed } from "../graph/jobs.js";
import { selectedKeys } from "../key-selections.js";
import type { ProviderKeys } from "../keys.js";
import { all, get, run } from "../sqlite.js";
import { RequestError } from "../validation.js";
import { decode, normalizeLines, type StoredBook } from "./books.js";
import { requireWorld, worldColumns, type WorldRow } from "./storage.js";

type IndexJob = { worldId: string; passageBook: number | null; extractionBook: number | null; controller: AbortController };
type Passage = { id: string; book_number: number; number: number; start: number; tokens: number; name: string; text: string };

// These weights measure completed work. The last percentage point is earned when the index is published.
const worldProgressWeights = { passages: 20, extraction: 50, combination: 1, summaries: 20, graphEmbeddings: 8 };

function indexingProgress(world: WorldRow, total: number, embedded: number, extracted: number, records: GraphProgress | null) {
  if (world.status === "ready") return 100;
  if (!total) return 0;
  const passages = embedded / total;
  if (!world.graph_settings) return Math.min(99, 100 * passages);

  const weights = worldProgressWeights;
  const chunkProgress = weights.passages * passages + weights.extraction * (extracted / total);
  if (!records) return chunkProgress;

  const summaryFraction = records.combined ? records.summarized / records.combined : 1;
  const embeddingFraction = records.combined ? records.embedded / records.combined : 1;
  return chunkProgress + weights.combination + weights.summaries * summaryFraction + weights.graphEmbeddings * embeddingFraction;
}

export class WorldIndexing {
  private running: Promise<void> | undefined;
  private active: IndexJob | undefined;
  private closing = false;
  private indexCooldown = new Map<string, number>();
  private cooldownWorld?: string;

  private readonly graph: GraphJobs;

  constructor(private db: DatabaseSync, private keys: ProviderKeys, private provider: GeminiClient,
    private graphIndexes: GraphIndexes) {
    this.graph = new GraphJobs(db, keys, provider, graphIndexes);
  }

  progress(world: WorldRow, total: number, embedded: number, extracted: number) {
    const graph_progress = this.graph.recordCounts(world);
    const active = this.active?.worldId === world.id ? this.active : undefined;
    return {
      graph_progress,
      active_book: active?.passageBook ?? active?.extractionBook ?? null,
      progress: indexingProgress(world, total, embedded, extracted, graph_progress),
    };
  }

  abort(id: string) {
    if (this.active?.worldId === id) this.active.controller.abort();
  }

  pause(id: string) {
    if (requireWorld(this.db, id).status !== "creating") throw new RequestError("This World has already changed state.", 409);
    run(this.db, "UPDATE worlds SET status = ? WHERE id = ?", this.active?.worldId === id ? "pausing" : "paused", id);
  }

  resume(id: string) {
    const world = requireWorld(this.db, id);
    if (!["paused", "failed"].includes(world.status)) throw new RequestError("This World has already changed state.", 409);
    this.keys.validate(selectedKeys(this.db, "world_embedding_keys", id), true);
    if (world.graph_settings) this.keys.validate(selectedKeys(this.db, "world_extraction_keys", id), true);
    run(this.db, "UPDATE worlds SET status = 'creating', error = NULL WHERE id = ?", id);
    this.wake();
  }

  hasPendingPassages(world: WorldRow) { return !!this.missingChunk(world); }

  private missingChunk(world: WorldRow) {
    return get<Passage>(this.db, `
      SELECT b.id, b.number AS book_number, c.number, c.start, c.tokens, b.name,
        substr(b.working, c.start + 1, c.embed_end - c.start) AS text
      FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NULL ORDER BY b.number, c.number LIMIT 1
    `, world.id, world.index_number);
  }

  wake() {
    if (this.running || this.closing) return;
    this.running = yieldToServer().then(() => this.process()).finally(() => { this.running = undefined; });
  }

  private async process() {
    while (!this.closing) {
      const world = get<WorldRow>(this.db, `SELECT ${worldColumns} FROM worlds WHERE status = 'creating' ORDER BY rowid LIMIT 1`);
      if (!world) { this.indexCooldown.clear(); return; }
      try {
        await this.indexWorld(world);
      } catch (error) {
        if (!this.closing) {
          const message = error instanceof Error ? error.message : "Could not index this World.";
          run(this.db, "UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'pausing'", world.id);
          run(this.db, "UPDATE worlds SET status = 'failed', error = ? WHERE id = ? AND status = 'creating'", message, world.id);
        }
      } finally {
        this.active = undefined;
      }
      await yieldToServer();
    }
  }

  private async indexWorld(world: WorldRow) {
    const spec = EMBEDDING_MODELS.find(model => model.id === world.model);
    if (!spec || world.dimensions < 128 || world.dimensions > spec.dimensions) throw new Error("The saved embedding model or dimensions are unavailable.");
    const job: IndexJob = { worldId: world.id, passageBook: null, extractionBook: null, controller: new AbortController() };
    this.active = job;
    const { signal } = job.controller;
    const settings: GraphSettings | null = world.graph_settings ? JSON.parse(world.graph_settings) : null;
    let failure: unknown;
    let failed = false;
    const working = () => !signal.aborted && !failed
      && get<{ status: string }>(this.db, "SELECT status FROM worlds WHERE id = ?", world.id)?.status === "creating";
    const captureFailure = (error: unknown) => {
      if (!failed) failure = error;
      failed = true;
    };

    const [, extractionFailure] = await Promise.all([
      this.embedPassages(world, job, working).catch(captureFailure),
      settings && world.graph_building === null ? this.extractChunks(world, settings, job, working).catch(captureFailure) : undefined,
    ]);
    if (failed) throw failure;
    if (working()) {
      if (extractionFailure) throw extractionFailure;
      this.verify(world);
      if (settings) await this.finishGraph(world, settings, signal, working);
      else run(this.db, "UPDATE worlds SET status = 'ready' WHERE id = ?", world.id);
    }
    run(this.db, "UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'pausing'", world.id);
  }

  private async embedPassages(world: WorldRow, job: IndexJob, working: () => boolean) {
    while (working()) {
      const chunk = this.missingChunk(world);
      if (!chunk) break;
      job.passageBook = chunk.book_number;
      await this.embedPassage(world, chunk, job.controller.signal, working);
      await yieldToServer();
    }
    job.passageBook = null;
  }

  private async extractChunks(world: WorldRow, settings: GraphSettings, job: IndexJob, working: () => boolean) {
    let after = { book: 0, number: 0 };
    let skipped = 0;
    let lastError = "";
    while (working()) {
      const chunk = this.graph.nextChunk(world, settings, after);
      if (!chunk) break;
      job.extractionBook = chunk.book;
      try {
        if (await this.graph.extract(world, settings, chunk, job.controller.signal, working)) after = chunk;
      } catch (error) {
        if (!(error instanceof GraphRequestFailed)) throw error;
        after = chunk;
        skipped++;
        lastError = `Book ${chunk.book}, chunk ${chunk.number}. ${error.message}`;
      }
      await yieldToServer();
    }
    job.extractionBook = null;
    if (skipped) {
      return new Error(`Could not extract ${skipped} ${skipped === 1 ? "chunk" : "chunks"} after ${MAX_GRAPH_ATTEMPTS} attempts each. Last failure in ${lastError}`);
    }
  }

  private async embedPassage(world: WorldRow, chunk: Passage, signal: AbortSignal, working: () => boolean) {
    const keys = selectedKeys(this.db, "world_embedding_keys", world.id);
    const prefix = `title: ${chunk.name} | text: `;
    const text = Array.from(chunk.text);
    if (this.cooldownWorld !== world.id) {
      this.indexCooldown.clear();
      this.cooldownWorld = world.id;
    }
    const indexing = { cooldown: this.indexCooldown, paused: () => !working() };
    const count = (part: string) => this.keys.retry("embedding", keys, signal,
      key => this.provider.count(world.model, key, tokenBody(prefix + part), signal), indexing);
    const tokens = chunk.tokens || await count(chunk.text);
    let length = text.length;
    if (!chunk.tokens && tokens > world.max_token_limit) {
      let minimum = 0;
      let maximum = length - 1;
      while (minimum < maximum) {
        const middle = Math.floor((minimum + maximum + 1) / 2);
        if (await count(text.slice(0, middle).join("")) <= world.max_token_limit) minimum = middle;
        else maximum = middle - 1;
      }
      if (!minimum) throw new Error("The book title leaves no room for text in the embedding.");
      length = minimum;
    }
    signal.throwIfAborted();
    const vector = await this.keys.retry("embedding", keys, signal, async key => {
      const values = await this.provider.embed(world.model, world.dimensions, key, prefix + text.slice(0, length).join(""), signal);
      return encodeVector(values, world.dimensions);
    }, indexing);
    signal.throwIfAborted();
    run(this.db, "UPDATE chunks SET vector = ?, tokens = ?, embed_end = ? WHERE book_id = ? AND index_number = ? AND number = ?",
      vector, tokens, chunk.start + length, chunk.id, world.index_number, chunk.number);
  }

  private async finishGraph(world: WorldRow, settings: GraphSettings, signal: AbortSignal, working: () => boolean) {
    const generation = world.graph_building ?? this.graph.prepare(world);
    await this.graph.summarize(world, settings, generation, signal, working);
    while (working()) {
      if (await this.graph.finishNext(world, generation, signal, working)) {
        signal.throwIfAborted();
        run(this.db, `
          UPDATE worlds SET graph_published = graph_building, graph_base = graph_building, graph_building = NULL,
            status = 'ready' WHERE id = ?
        `, world.id);
        this.graphIndexes.collect();
        return;
      }
      await yieldToServer();
    }
  }

  private verify(world: WorldRow) {
    const books = all<StoredBook>(this.db, "SELECT * FROM books WHERE world_id = ? ORDER BY number", world.id);
    if (!books.length) throw new Error("No books to index.");
    for (const book of books) {
      const text = Array.from(book.working);
      const chunks = all<{ number: number; start: number; end: number; embed_end: number; original_start: number; original_end: number; vector: Uint8Array }>(
        this.db, "SELECT * FROM chunks WHERE book_id = ? AND index_number = ? ORDER BY number", book.id, world.index_number);
      let start = 0;
      const exactSource = book.encoding !== "extracted";
      let sourceStart = book.bom_size;
      for (const [position, chunk] of chunks.entries()) {
        const original = book.original.subarray(sourceStart, chunk.original_end);
        const invalidSource = exactSource && (chunk.original_start !== sourceStart
          || normalizeLines(decode(original, book.encoding)) !== text.slice(start, chunk.end).join(""));
        if (chunk.number !== position + 1 || chunk.start !== start
          || chunk.embed_end <= start || chunk.embed_end > chunk.end || chunk.end - start > world.max_chunk_size
          || chunk.end > text.length || chunk.vector?.length !== world.dimensions * 4 || invalidSource) {
          throw new Error("Could not verify the saved World.");
        }
        start = chunk.end;
        sourceStart = chunk.original_end;
      }
      if (start !== text.length || (exactSource && sourceStart !== book.original.length)) throw new Error("Could not verify the saved World.");
    }
  }

  async close() {
    this.closing = true;
    this.active?.controller.abort();
    await this.running;
  }
}
