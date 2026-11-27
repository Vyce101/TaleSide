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
import { IndexActivity, type IndexActivityRecorder } from "./index-activity.js";
import { requireWorld, worldColumns, type WorldRow } from "./storage.js";

const MIN_EMBEDDING_DIMENSIONS = 128;

type IndexJob = { worldId: string; passageBook: number | null; extractionBook: number | null; controller: AbortController };
type PendingPassage = { id: string; book_number: number; number: number; start: number; tokens: number; name: string; text: string };

// These weights measure completed work. The last percentage point is earned when the index is published.
const worldProgressPoints = { passages: 20, extraction: 50, combination: 1, summaries: 20, graphEmbeddings: 8 };

function indexingProgress(world: WorldRow, totalChunks: number, embeddedChunks: number, extractedChunks: number, records: GraphProgress | null) {
  if (world.status === "ready") return 100;
  if (!totalChunks) return 0;
  const embeddedFraction = embeddedChunks / totalChunks;
  if (!world.graph_settings) return Math.min(99, 100 * embeddedFraction);

  const extractedFraction = extractedChunks / totalChunks;
  const points = worldProgressPoints;
  const chunkProgress = points.passages * embeddedFraction + points.extraction * extractedFraction;
  if (!records) return chunkProgress;

  const summaryFraction = records.combined ? records.summarized / records.combined : 1;
  const embeddingFraction = records.combined ? records.embedded / records.combined : 1;
  return chunkProgress + points.combination + points.summaries * summaryFraction + points.graphEmbeddings * embeddingFraction;
}

export class WorldIndexing {
  private running: Promise<void> | undefined;
  private active: IndexJob | undefined;
  private closing = false;
  private indexCooldown = new Map<string, number>();
  private cooldownWorld?: string;

  readonly activity = new IndexActivity();
  private readonly graph: GraphJobs;

  constructor(private db: DatabaseSync, private keys: ProviderKeys, private provider: GeminiClient,
    private graphIndexes: GraphIndexes) {
    this.graph = new GraphJobs(db, keys, provider, graphIndexes, this.activity);
  }

  progress(world: WorldRow, totalChunks: number, embeddedChunks: number, extractedChunks: number) {
    const graph_progress = this.graph.recordCounts(world);
    const active = this.active?.worldId === world.id && !this.active.controller.signal.aborted ? this.active : undefined;
    return {
      graph_progress,
      active_book: active?.passageBook ?? active?.extractionBook ?? null,
      progress: indexingProgress(world, totalChunks, embeddedChunks, extractedChunks, graph_progress),
    };
  }

  abort(id: string) {
    if (this.active?.worldId === id) this.active.controller.abort();
  }

  pause(id: string) {
    if (requireWorld(this.db, id).status !== "creating") throw new RequestError("This World has already changed state.", 409);
    run(this.db, "UPDATE worlds SET status = 'paused' WHERE id = ?", id);
    this.abort(id);
  }

  resume(id: string) {
    const world = requireWorld(this.db, id);
    if (!["paused", "failed"].includes(world.status)) throw new RequestError("This World has already changed state.", 409);
    this.keys.validate(selectedKeys(this.db, "world_embedding_keys", id), true);
    if (world.graph_settings) this.keys.validate(selectedKeys(this.db, "world_extraction_keys", id), true);
    run(this.db, "UPDATE worlds SET status = 'creating', error = NULL WHERE id = ?", id);
    this.wake();
  }

  hasPendingPassages(world: WorldRow) { return !!this.nextUnembeddedChunk(world); }

  private nextUnembeddedChunk(world: WorldRow) {
    return get<PendingPassage>(this.db, `
      SELECT b.id, b.number AS book_number, c.number, c.start, c.tokens, b.name,
        substr(b.working, c.start + 1, c.embed_end - c.start) AS text
      FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NULL ORDER BY b.number, c.number LIMIT 1
    `, world.id, world.index_number);
  }

  wake() {
    if (this.running || this.closing) return;
    this.running = yieldToServer().then(() => this.processQueue()).finally(() => { this.running = undefined; });
  }

  private async processQueue() {
    while (!this.closing) {
      const world = get<WorldRow>(this.db, `SELECT ${worldColumns} FROM worlds WHERE status = 'creating' ORDER BY rowid LIMIT 1`);
      if (!world) { this.indexCooldown.clear(); return; }
      try {
        await this.indexWorld(world);
      } catch (error) {
        if (!this.closing && !this.active?.controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Could not index this World.";
          run(this.db, "UPDATE worlds SET status = 'failed', error = ? WHERE id = ? AND status = 'creating'", message, world.id);
        }
      } finally {
        this.active = undefined;
      }
      await yieldToServer();
    }
  }

  private async indexWorld(world: WorldRow) {
    const embeddingModel = EMBEDDING_MODELS.find(model => model.id === world.model);
    if (!embeddingModel || world.dimensions < MIN_EMBEDDING_DIMENSIONS || world.dimensions > embeddingModel.dimensions) {
      throw new Error("The saved embedding model or dimensions are unavailable.");
    }

    const job: IndexJob = { worldId: world.id, passageBook: null, extractionBook: null, controller: new AbortController() };
    this.active = job;
    const { signal } = job.controller;
    const graphSettings: GraphSettings | null = world.graph_settings ? JSON.parse(world.graph_settings) : null;
    let fatalFailure: { error: unknown } | undefined;

    const canStartStep = () => {
      if (signal.aborted || fatalFailure) return false;
      const current = get<{ status: string }>(this.db, "SELECT status FROM worlds WHERE id = ?", world.id);
      return current?.status === "creating";
    };
    const stopAfterFailure = (error: unknown) => { fatalFailure ??= { error }; };

    // Let both tasks unwind before starting another World or resuming this one.
    const passageTask = this.embedPassages(world, job, canStartStep).catch(stopAfterFailure);
    const extractionTask = graphSettings && world.graph_building === null
      ? this.extractChunks(world, graphSettings, job, canStartStep).catch(stopAfterFailure)
      : undefined;
    const [, skippedChunksFailure] = await Promise.all([passageTask, extractionTask]);
    if (fatalFailure) throw fatalFailure.error;

    if (canStartStep()) {
      // Let the other chunks finish before reporting skipped chunks for Resume.
      if (skippedChunksFailure) throw skippedChunksFailure;
      this.verifyPassages(world);
      if (graphSettings) await this.finishGraph(world, graphSettings, signal, canStartStep);
      else run(this.db, "UPDATE worlds SET status = 'ready' WHERE id = ?", world.id);
    }
  }

  private async embedPassages(world: WorldRow, job: IndexJob, canStartStep: () => boolean) {
    while (canStartStep()) {
      const chunk = this.nextUnembeddedChunk(world);
      if (!chunk) break;
      job.passageBook = chunk.book_number;
      await this.activity.track({
        worldId: world.id, bookRevision: world.book_revision, kind: "embedding", name: "Chunk embedding",
        location: { book: chunk.book_number, chunk: chunk.number },
      }, job.controller.signal, activity => this.embedPassage(world, chunk, job.controller.signal, canStartStep, activity));
      await yieldToServer();
    }
    job.passageBook = null;
  }

  private async extractChunks(world: WorldRow, settings: GraphSettings, job: IndexJob, canStartStep: () => boolean): Promise<Error | undefined> {
    let cursor = { book: 0, number: 0 };
    let skippedChunks = 0;
    let lastChunkFailure = "";
    while (canStartStep()) {
      const chunk = this.graph.nextChunk(world, settings, cursor);
      if (!chunk) break;
      job.extractionBook = chunk.book;
      try {
        if (await this.graph.extract(world, settings, chunk, job.controller.signal, canStartStep)) cursor = chunk;
      } catch (error) {
        if (!(error instanceof GraphRequestFailed)) throw error;
        cursor = chunk;
        skippedChunks++;
        lastChunkFailure = `Book ${chunk.book}, chunk ${chunk.number}. ${error.message}`;
      }
      await yieldToServer();
    }
    job.extractionBook = null;
    if (!skippedChunks) return;
    const units = skippedChunks === 1 ? "chunk" : "chunks";
    return new Error(`Could not extract ${skippedChunks} ${units} after ${MAX_GRAPH_ATTEMPTS} attempts each. Last failure in ${lastChunkFailure}`);
  }

  private async embedPassage(world: WorldRow, chunk: PendingPassage, signal: AbortSignal, canStartStep: () => boolean,
    activity: IndexActivityRecorder) {
    const keys = selectedKeys(this.db, "world_embedding_keys", world.id);
    const prefix = `title: ${chunk.name} | text: `;
    const passageCharacters = Array.from(chunk.text);
    if (this.cooldownWorld !== world.id) {
      this.indexCooldown.clear();
      this.cooldownWorld = world.id;
    }
    const indexing = { cooldown: this.indexCooldown, paused: () => !canStartStep(), onRetry: activity.retry };
    const countTokens = (passageText: string) => this.keys.retry("embedding", keys, signal,
      key => this.provider.count(world.model, key, tokenBody(prefix + passageText), signal), {
        ...indexing, onAttempt: key => activity.request("Token count request started", key),
      });
    if (!chunk.tokens) {
      activity.input(prefix + chunk.text);
      activity.step("Counting input tokens");
    }
    const fullTokenCount = chunk.tokens || await countTokens(chunk.text);
    let embeddingCharacters = passageCharacters.length;
    if (!chunk.tokens && fullTokenCount > world.max_token_limit) {
      // Keep the full passage for retrieval. Only the embedding input has a token limit.
      let longestKnownFit = 0;
      let longestCandidate = embeddingCharacters - 1;
      while (longestKnownFit < longestCandidate) {
        const candidateLength = Math.floor((longestKnownFit + longestCandidate + 1) / 2);
        const candidateText = passageCharacters.slice(0, candidateLength).join("");
        const candidateTokens = await countTokens(candidateText);
        if (candidateTokens <= world.max_token_limit) longestKnownFit = candidateLength;
        else longestCandidate = candidateLength - 1;
      }
      if (!longestKnownFit) throw new Error("The book title leaves no room for text in the embedding.");
      embeddingCharacters = longestKnownFit;
    }
    signal.throwIfAborted();
    const vector = await this.keys.retry("embedding", keys, signal, async key => {
      const input = prefix + passageCharacters.slice(0, embeddingCharacters).join("");
      activity.input(input);
      const values = await this.provider.embed(world.model, world.dimensions, key, input, signal);
      activity.step("Embedding received");
      activity.output(JSON.stringify(values));
      return encodeVector(values, world.dimensions);
    }, { ...indexing, onAttempt: key => activity.request("Embedding request started", key) });
    signal.throwIfAborted();
    run(this.db, "UPDATE chunks SET vector = ?, tokens = ?, embed_end = ? WHERE book_id = ? AND index_number = ? AND number = ?",
      vector, fullTokenCount, chunk.start + embeddingCharacters, chunk.id, world.index_number, chunk.number);
  }

  private async finishGraph(world: WorldRow, settings: GraphSettings, signal: AbortSignal, canStartStep: () => boolean) {
    const generation = world.graph_building ?? this.graph.prepare(world);
    await this.graph.summarize(world, settings, generation, signal, canStartStep);
    while (canStartStep()) {
      if (await this.graph.finishNext(world, generation, signal, canStartStep)) {
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

  private verifyPassages(world: WorldRow) {
    const books = all<StoredBook>(this.db, "SELECT * FROM books WHERE world_id = ? ORDER BY number", world.id);
    if (!books.length) throw new Error("No books to index.");
    const expectedVectorBytes = world.dimensions * Float32Array.BYTES_PER_ELEMENT;
    for (const book of books) {
      const bookCharacters = Array.from(book.working);
      const chunks = all<{ number: number; start: number; end: number; embed_end: number; original_start: number; original_end: number; vector: Uint8Array | null }>(
        this.db, "SELECT * FROM chunks WHERE book_id = ? AND index_number = ? ORDER BY number", book.id, world.index_number);
      const hasOriginalOffsets = book.encoding !== "extracted";
      let nextCharacter = 0;
      let nextOriginalByte = book.bom_size;
      for (const [position, chunk] of chunks.entries()) {
        const originalBytes = book.original.subarray(nextOriginalByte, chunk.original_end);
        const invalidSource = hasOriginalOffsets && (chunk.original_start !== nextOriginalByte
          || normalizeLines(decode(originalBytes, book.encoding)) !== bookCharacters.slice(nextCharacter, chunk.end).join(""));
        const invalidPassageRange = chunk.start !== nextCharacter || chunk.end > bookCharacters.length
          || chunk.end - nextCharacter > world.max_chunk_size;
        const invalidEmbeddingRange = chunk.embed_end <= nextCharacter || chunk.embed_end > chunk.end;
        if (chunk.number !== position + 1 || invalidPassageRange || invalidEmbeddingRange || invalidSource
          || chunk.vector?.length !== expectedVectorBytes) {
          throw new Error("Could not verify the saved World.");
        }
        nextCharacter = chunk.end;
        nextOriginalByte = chunk.original_end;
      }
      const allOriginalBytesCovered = !hasOriginalOffsets || nextOriginalByte === book.original.length;
      if (nextCharacter !== bookCharacters.length || !allOriginalBytesCovered) throw new Error("Could not verify the saved World.");
    }
  }

  async close() {
    this.closing = true;
    this.active?.controller.abort();
    await this.running;
  }
}
