import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToServer } from "node:timers/promises";
import type { Book, World, WorldSettings } from "../shared/types.js";
import { DEFAULT_CHUNK_SIZE, decode, normalizeLines, prepareBooks, type BookInput, type PreparedBook } from "./books.js";
import { all, get, run, saveSelection, selectedKeys, transaction } from "./database.js";
import { EMBEDDING_MODEL, EMBEDDING_MODELS, encodeVector, tokenBody, type GeminiClient } from "./gemini.js";
import { ProviderKeys } from "./keys.js";
import { identifier, makeId, RequestError, requiredText, whole } from "./validation.js";

export type WorldRow = Pick<World, "id" | "name" | "status" | "model" | "dimensions" | "max_token_limit"
  | "max_chunk_size" | "book_revision" | "error"> & { index_number: number };
type StoredBook = BookInput & { id: string; number: number; working: string; encoding: string; bom_size: number };
export type Artwork = { content_type: string; image: Uint8Array };
type IndexJob = { worldId: string; bookNumber: number; controller: AbortController };

const worldColumns = "id, name, status, model, dimensions, max_token_limit, max_chunk_size, book_revision, index_number, error";
const activeStatuses = new Set(["creating", "pausing"]);
const TITLE_LIMIT = 100;

export class Worlds {
  private running: Promise<void> | undefined;
  private active: IndexJob | undefined;
  private closing = false;
  private indexCooldown = new Map<string, number>();
  private cooldownWorld?: string;

  constructor(readonly db: DatabaseSync, readonly keys: ProviderKeys, private provider: GeminiClient) {}

  require(id: string) {
    const world = get<WorldRow>(this.db, `SELECT ${worldColumns} FROM worlds WHERE id = ? AND status <> 'draft'`, id);
    if (!world) throw new RequestError("This World could not be found.", 404);
    return world;
  }

  canPlay(world: WorldRow) {
    return EMBEDDING_MODELS.some(model => model.id === world.model) && !!get(this.db, `
      SELECT 1 FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL LIMIT 1
    `, world.id, world.index_number);
  }

  private summary(row: WorldRow): World {
    const { index_number, ...world } = row;
    const books = all<Book>(this.db, `
      SELECT b.id, b.number, b.name, b.filename, count(c.number) AS total_chunks, count(c.vector) AS embedded_chunks
      FROM books b LEFT JOIN chunks c ON c.book_id = b.id AND c.index_number = ?
      WHERE b.world_id = ? GROUP BY b.id ORDER BY b.number
    `, index_number, row.id);
    const total_chunks = books.reduce((count, book) => count + book.total_chunks, 0);
    const embedded_chunks = books.reduce((count, book) => count + book.embedded_chunks, 0);
    const image = get<{ version: string }>(this.db, "SELECT version FROM world_artwork WHERE world_id = ?", row.id);
    return {
      ...world, books, total_chunks, embedded_chunks,
      artwork: image ? `/api/worlds/${row.id}/artwork?v=${image.version}` : null,
      active_book: this.active?.worldId === row.id ? this.active.bookNumber : null,
      can_play: this.canPlay(row),
      progress: row.status === "ready" ? 100 : Math.min(99.99, embedded_chunks * 100 / (total_chunks || 1)),
      embedding_key_ids: selectedKeys(this.db, "world_embedding_keys", row.id),
      retrieval_key_ids: selectedKeys(this.db, "world_retrieval_keys", row.id),
    };
  }

  list() {
    return all<WorldRow>(this.db, `
      SELECT ${worldColumns} FROM worlds WHERE status <> 'draft' ORDER BY last_tale_activity_at DESC, rowid DESC
    `).map(world => this.summary(world));
  }

  detail(id: string) { return this.summary(this.require(id)); }

  private settings(input: Record<string, unknown>, requireKeys: boolean): WorldSettings {
    const model = input.model ?? EMBEDDING_MODEL;
    if (model !== EMBEDDING_MODEL) {
      throw new RequestError("Choose an available embedding model.");
    }
    return {
      name: requiredText(input.name, "Enter a World name up to 100 characters.", TITLE_LIMIT),
      model, key_ids: this.keys.validate(input.key_ids ?? [], requireKeys),
      max_chunk_size: whole(input.max_chunk_size ?? DEFAULT_CHUNK_SIZE, 1, "Enter a positive whole chunk size."),
    };
  }

  private storeChunks(bookId: string, index: number, prepared: PreparedBook) {
    const insert = this.db.prepare(`
      INSERT INTO chunks (book_id, index_number, number, start, end, original_start, original_end, tokens, embed_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    prepared.chunks.forEach((chunk, number) => insert.run(bookId, index, number + 1,
      chunk.start, chunk.end, chunk.originalStart, chunk.originalEnd, chunk.end));
  }

  private storeBooks(worldId: string, index: number, start: number, books: PreparedBook[], indexed: boolean) {
    books.forEach((book, number) => {
      const id = makeId();
      run(this.db, `
        INSERT INTO books (id, world_id, number, name, filename, original, working, encoding, bom_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, worldId, start + number, book.name, book.filename, book.original, book.working, book.encoding, book.bomSize);
      if (indexed) this.storeChunks(id, index, book);
    });
  }

  async create(id: string, input: Record<string, unknown>, books: BookInput[], artwork?: Artwork) {
    const existing = get(this.db, "SELECT 1 FROM worlds WHERE id = ? AND status <> 'draft'", id);
    if (existing) return this.detail(id);
    const settings = this.settings(input, !!books.length);
    const spec = EMBEDDING_MODELS.find(model => model.id === settings.model)!;
    const prepared = await prepareBooks(books, settings.max_chunk_size);
    if (get(this.db, "SELECT 1 FROM worlds WHERE id = ? AND status <> 'draft'", id)) return this.detail(id);
    this.keys.validate(settings.key_ids, !!books.length);
    transaction(this.db, () => {
      run(this.db, `
        INSERT INTO worlds (id, name, status, model, dimensions, max_token_limit, max_chunk_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, id, settings.name, books.length ? "creating" : "unindexed", settings.model, spec.dimensions,
      spec.max_token_limit, settings.max_chunk_size);
      saveSelection(this.db, "world_embedding_keys", id, settings.key_ids);
      saveSelection(this.db, "world_retrieval_keys", id, settings.key_ids);
      if (books.length) this.keys.remember(settings.model, settings.key_ids);
      this.storeBooks(id, 1, 1, prepared, true);
      if (artwork) this.storeArtwork(id, artwork);
    });
    this.wake();
    return this.detail(id);
  }

  private editable(id: string, revision?: unknown) {
    const world = this.require(id);
    if (activeStatuses.has(world.status)) throw new RequestError("Pause indexing and wait for the active request.", 409);
    if (revision !== undefined && revision !== world.book_revision) throw new RequestError("This World changed. Try again.", 409);
    return world;
  }

  private requireRevision(revision: unknown) {
    return whole(revision, 0, "A current book revision is required.");
  }

  async append(id: string, revision: unknown, books: BookInput[]) {
    if (!books.length) throw new RequestError("Select at least one book.");
    const world = this.editable(id, this.requireRevision(revision));
    const prepared = await prepareBooks(books, world.max_chunk_size);
    this.editable(id, revision);
    transaction(this.db, () => {
      const { next } = get<{ next: number }>(this.db, "SELECT coalesce(max(number), 0) + 1 AS next FROM books WHERE world_id = ?", id)!;
      this.storeBooks(id, world.index_number, next, prepared, world.status !== "unindexed");
      run(this.db, "UPDATE worlds SET book_revision = book_revision + 1, status = ?, error = NULL WHERE id = ?",
        world.status === "unindexed" ? "unindexed" : "paused", id);
    });
    return this.detail(id);
  }

  private renumber(id: string, ids: string[]) {
    run(this.db, "UPDATE books SET number = -number WHERE world_id = ?", id);
    const update = this.db.prepare("UPDATE books SET number = ? WHERE id = ?");
    ids.forEach((book, index) => update.run(index + 1, book));
  }

  editBooks(id: string, action: string, input: Record<string, unknown>) {
    const world = this.editable(id, this.requireRevision(input.book_revision));
    transaction(this.db, () => {
      const ids = all<{ id: string }>(this.db, "SELECT id FROM books WHERE world_id = ? ORDER BY number", id).map(book => book.id);
      if (action === "book-order") {
        const order: unknown = input.book_ids;
        if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || order.some(book => !ids.includes(book))) {
          throw new RequestError("Provide every saved book in the new order.");
        }
        this.renumber(id, order);
      } else {
        const book = identifier(input.book_id);
        if (!ids.includes(book)) throw new RequestError("Choose a book in this World.");
        if (action === "rename-book") {
          run(this.db, "UPDATE books SET name = ? WHERE id = ?", requiredText(input.name, "Enter a book name up to 100 characters.", TITLE_LIMIT), book);
        } else {
          run(this.db, "DELETE FROM books WHERE id = ?", book);
          this.renumber(id, ids.filter(candidate => candidate !== book));
          const state = ids.length === 1 ? "unindexed" : world.status !== "unindexed" && !this.missingChunk(world) ? "ready" : world.status;
          run(this.db, "UPDATE worlds SET status = ?, error = CASE WHEN ? IN ('ready', 'unindexed') THEN NULL ELSE error END WHERE id = ?", state, state, id);
        }
      }
      run(this.db, "UPDATE worlds SET book_revision = book_revision + 1 WHERE id = ?", id);
    });
    return this.detail(id);
  }

  rename(id: string, name: unknown) {
    this.require(id);
    run(this.db, "UPDATE worlds SET name = ? WHERE id = ?", requiredText(name, "Enter a World name up to 100 characters.", TITLE_LIMIT), id);
  }

  artwork(id: string) { return get<Artwork>(this.db, "SELECT content_type, image FROM world_artwork WHERE world_id = ?", id); }

  storeArtwork(id: string, artwork: Artwork) {
    this.require(id);
    run(this.db, `
      INSERT INTO world_artwork (world_id, content_type, image, version) VALUES (?, ?, ?, ?)
      ON CONFLICT(world_id) DO UPDATE SET content_type = excluded.content_type, image = excluded.image, version = excluded.version
    `, id, artwork.content_type, artwork.image, makeId());
  }

  setKeys(id: string, kind: "embedding" | "retrieval", selection: unknown) {
    if (kind === "embedding") this.editable(id);
    else this.require(id);
    const ids = this.keys.validate(selection);
    transaction(this.db, () => {
      saveSelection(this.db, kind === "embedding" ? "world_embedding_keys" : "world_retrieval_keys", id, ids);
    });
  }

  async saveSettings(id: string, input: Record<string, unknown>, start: boolean) {
    const world = this.editable(id, this.requireRevision(input.book_revision));
    if (world.status !== "unindexed") throw new RequestError("Delete indexing to change these settings.", 409);
    const settings = this.settings({ ...input, name: world.name }, start);
    const model = EMBEDDING_MODELS.find(item => item.id === settings.model)!;
    const books = start ? all<StoredBook>(this.db, "SELECT * FROM books WHERE world_id = ? ORDER BY number", id) : [];
    if (start && !books.length) throw new RequestError("Add a book before starting indexing.");
    const prepared = await prepareBooks(books, settings.max_chunk_size);
    this.editable(id, input.book_revision);
    this.keys.validate(settings.key_ids, start);
    transaction(this.db, () => {
      run(this.db, `
        UPDATE worlds SET model = ?, dimensions = ?, max_token_limit = ?, max_chunk_size = ?,
          status = ?, error = NULL, book_revision = book_revision + 1 WHERE id = ?
      `, model.id, model.dimensions, model.max_token_limit, settings.max_chunk_size,
      start ? "creating" : "unindexed", id);
      saveSelection(this.db, "world_embedding_keys", id, settings.key_ids);
      if (start) {
        books.forEach((book, number) => this.storeChunks(book.id, world.index_number, prepared[number]));
        this.keys.remember(model.id, settings.key_ids);
      }
    });
    this.wake();
    return this.detail(id);
  }

  clearIndex(id: string) {
    this.editable(id);
    transaction(this.db, () => {
      run(this.db, "DELETE FROM chunks WHERE book_id IN (SELECT id FROM books WHERE world_id = ?)", id);
      run(this.db, `
        UPDATE worlds SET status = 'unindexed', index_number = index_number + 1, error = NULL,
          book_revision = book_revision + 1 WHERE id = ?
      `, id);
    });
    return this.detail(id);
  }

  discard(id: string) {
    this.require(id);
    run(this.db, "DELETE FROM worlds WHERE id = ?", id);
    if (this.active?.worldId === id) this.active.controller.abort();
  }

  pause(id: string) {
    if (this.require(id).status !== "creating") throw new RequestError("This World has already changed state.", 409);
    run(this.db, "UPDATE worlds SET status = ? WHERE id = ?", this.active?.worldId === id ? "pausing" : "paused", id);
  }

  resume(id: string) {
    if (!["paused", "failed"].includes(this.require(id).status)) throw new RequestError("This World has already changed state.", 409);
    this.keys.validate(selectedKeys(this.db, "world_embedding_keys", id), true);
    run(this.db, "UPDATE worlds SET status = 'creating', error = NULL WHERE id = ?", id);
    this.wake();
  }

  private missingChunk(world: WorldRow) {
    return get<{ id: string; book_number: number; number: number; start: number; tokens: number; name: string; text: string }>(this.db, `
      SELECT b.id, b.number AS book_number, c.number, c.start, c.tokens, b.name,
        substr(b.working, c.start + 1, c.embed_end - c.start) AS text
      FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NULL ORDER BY b.number, c.number LIMIT 1
    `, world.id, world.index_number);
  }

  private wake() {
    if (this.running || this.closing) return;
    this.running = yieldToServer().then(() => this.process()).finally(() => { this.running = undefined; });
  }

  private async process() {
    while (!this.closing) {
      const world = get<WorldRow>(this.db, `SELECT ${worldColumns} FROM worlds WHERE status = 'creating' ORDER BY rowid LIMIT 1`);
      if (!world) { this.indexCooldown.clear(); return; }
      try {
        await this.embedNext(world);
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

  private async embedNext(world: WorldRow) {
    const spec = EMBEDDING_MODELS.find(model => model.id === world.model);
    if (!spec || world.dimensions < 128 || world.dimensions > spec.dimensions) throw new Error("The saved embedding model or dimensions are unavailable.");
    const chunk = this.missingChunk(world);
    if (!chunk) {
      this.verify(world);
      run(this.db, "UPDATE worlds SET status = 'ready' WHERE id = ?", world.id);
      return;
    }
    const controller = new AbortController();
    this.active = { worldId: world.id, bookNumber: chunk.book_number, controller };
    const keys = selectedKeys(this.db, "world_embedding_keys", world.id);
    const signal = controller.signal;
    const prefix = `title: ${chunk.name} | text: `;
    const text = Array.from(chunk.text);
    if (this.cooldownWorld !== world.id) {
      this.indexCooldown.clear();
      this.cooldownWorld = world.id;
    }
    const indexing = { cooldown: this.indexCooldown, paused: () => this.require(world.id).status === "pausing" };
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
    const values = await this.keys.retry("embedding", keys, signal, key => this.provider.embed(world.model, world.dimensions, key,
      prefix + text.slice(0, length).join(""), signal), indexing);
    signal.throwIfAborted();
    const vector = encodeVector(values, world.dimensions);
    transaction(this.db, () => {
      run(this.db, "UPDATE chunks SET vector = ?, tokens = ?, embed_end = ? WHERE book_id = ? AND index_number = ? AND number = ?",
        vector, tokens, chunk.start + length, chunk.id, world.index_number, chunk.number);
      run(this.db, "UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'pausing'", world.id);
    });
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
