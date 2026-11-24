import type { DatabaseSync } from "node:sqlite";
import { FIRST_MESSAGE, WORLD_DESCRIPTION } from "../../shared/story-defaults.js";
import type { Book, World, WorldSettings } from "../../shared/types.js";
import type { Artwork } from "../artwork.js";
import { EMBEDDING_MODEL, EMBEDDING_MODELS } from "../gemini.js";
import type { GraphIndexes } from "../graph/indexes.js";
import { readGraphSettings } from "../graph/jobs.js";
import { saveSelection, selectedKeys } from "../key-selections.js";
import type { ProviderKeys } from "../keys.js";
import { all, get, run, transaction } from "../sqlite.js";
import { identifier, makeId, RequestError, requiredText, whole } from "../validation.js";
import { DEFAULT_CHUNK_SIZE, prepareBooks, type BookInput, type PreparedBook, type StoredBook } from "./books.js";
import type { WorldIndexing } from "./indexing.js";
import { requireWorld, worldColumns, type WorldRow } from "./storage.js";

const activeStatuses = new Set(["creating", "pausing"]);
const TITLE_LIMIT = 100;

export class Worlds {
  constructor(private db: DatabaseSync, private keys: ProviderKeys, private graphIndexes: GraphIndexes,
    private indexing: WorldIndexing) {}

  require(id: string) { return requireWorld(this.db, id); }

  canPlay(world: WorldRow) {
    return EMBEDDING_MODELS.some(model => model.id === world.model) && !!get(this.db, `
      SELECT 1 FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL LIMIT 1
    `, world.id, world.index_number);
  }

  private summary(row: WorldRow): World {
    const { index_number, description, openings, graph_settings, graph_published, graph_base, graph_building, ...world } = row;
    const books = all<Book>(this.db, `
      SELECT b.id, b.number, b.name, b.filename, count(c.number) AS total_chunks, count(c.vector) AS embedded_chunks,
        count(*) FILTER (WHERE g.complete = 1) AS extracted_chunks
      FROM books b LEFT JOIN chunks c ON c.book_id = b.id AND c.index_number = ?
      LEFT JOIN graph_chunks g ON g.book_id = c.book_id AND g.index_number = c.index_number AND g.chunk_number = c.number
      WHERE b.world_id = ? GROUP BY b.id ORDER BY b.number
    `, index_number, row.id);
    const total_chunks = books.reduce((count, book) => count + book.total_chunks, 0);
    const embedded_chunks = books.reduce((count, book) => count + book.embedded_chunks, 0);
    const extractedChunks = books.reduce((count, book) => count + book.extracted_chunks, 0);
    const image = get<{ version: string }>(this.db, "SELECT version FROM world_artwork WHERE world_id = ?", row.id);
    return {
      ...world, books, total_chunks, embedded_chunks,
      graph: graph_settings === null ? null : JSON.parse(graph_settings),
      ...this.indexing.progress(row, total_chunks, embedded_chunks, extractedChunks),
      extraction_key_ids: selectedKeys(this.db, "world_extraction_keys", row.id),
      description: description ?? WORLD_DESCRIPTION, openings: openings ? JSON.parse(openings) : [FIRST_MESSAGE],
      artwork: image ? `/api/worlds/${row.id}/artwork?v=${image.version}` : null,
      can_play: this.canPlay(row),
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
    const max_chunk_size = whole(input.max_chunk_size ?? DEFAULT_CHUNK_SIZE, 1, "Enter a positive whole chunk size.");
    const key_ids = this.keys.validate(input.key_ids ?? [], requireKeys);
    const graph = readGraphSettings(input.graph, max_chunk_size, requireKeys);
    return {
      name: requiredText(input.name, "Enter a World name up to 100 characters.", TITLE_LIMIT),
      model, key_ids, max_chunk_size, graph,
      extraction_key_ids: this.keys.validate(input.extraction_key_ids ?? [], requireKeys),
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
    const story = this.story(input.description ?? WORLD_DESCRIPTION, input.openings ?? [FIRST_MESSAGE]);
    const spec = EMBEDDING_MODELS.find(model => model.id === settings.model)!;
    const prepared = await prepareBooks(books, settings.max_chunk_size);
    if (get(this.db, "SELECT 1 FROM worlds WHERE id = ? AND status <> 'draft'", id)) return this.detail(id);
    this.keys.validate(settings.key_ids, !!books.length);
    this.keys.validate(settings.extraction_key_ids, !!books.length);
    transaction(this.db, () => {
      run(this.db, `
        INSERT INTO worlds (id, name, status, model, dimensions, max_token_limit, max_chunk_size, description, openings, graph_settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, settings.name, books.length ? "creating" : "unindexed", settings.model, spec.dimensions,
      spec.max_token_limit, settings.max_chunk_size, story.description, story.openings, JSON.stringify(settings.graph));
      saveSelection(this.db, "world_extraction_keys", id, settings.extraction_key_ids);
      saveSelection(this.db, "world_embedding_keys", id, settings.key_ids);
      saveSelection(this.db, "world_retrieval_keys", id, settings.key_ids);
      if (books.length) this.keys.remember(settings.model, settings.key_ids);
      this.storeBooks(id, 1, 1, prepared, true);
      if (artwork) this.storeArtwork(id, artwork);
    });
    this.indexing.wake();
    return this.detail(id);
  }

  private story(description: unknown, openings: unknown) {
    if (typeof description !== "string" || !Array.isArray(openings) || !openings.length
      || openings.some(opening => typeof opening !== "string")) {
      throw new RequestError("Enter a World description and at least one First Message slot.");
    }
    return { description, openings: JSON.stringify(openings) };
  }

  saveStory(id: string, input: Record<string, unknown>) {
    this.require(id);
    const { description, openings } = this.story(input.description, input.openings);
    run(this.db, "UPDATE worlds SET description = ?, openings = ? WHERE id = ?", description, openings, id);
    return this.detail(id);
  }

  private editable(id: string, revision?: unknown) {
    const world = this.require(id);
    if (activeStatuses.has(world.status)) throw new RequestError("Pause indexing before editing this World.", 409);
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
      run(this.db, "UPDATE worlds SET book_revision = book_revision + 1, graph_building = NULL, status = ?, error = NULL WHERE id = ?",
        world.status === "unindexed" ? "unindexed" : "paused", id);
    });
    this.graphIndexes.collect();
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
      const savedBookIds = all<{ id: string }>(this.db, "SELECT id FROM books WHERE world_id = ? ORDER BY number", id).map(book => book.id);
      if (action === "book-order") {
        const requestedOrder: unknown = input.book_ids;
        if (!Array.isArray(requestedOrder) || requestedOrder.length !== savedBookIds.length) {
          throw new RequestError("Provide every saved book in the new order.");
        }
        const uniqueBookIds = new Set(requestedOrder);
        const hasEverySavedBook = uniqueBookIds.size === savedBookIds.length && savedBookIds.every(bookId => uniqueBookIds.has(bookId));
        if (!hasEverySavedBook) throw new RequestError("Provide every saved book in the new order.");
        if (requestedOrder.every((bookId, index) => bookId === savedBookIds[index])) return;
        this.renumber(id, requestedOrder);
      } else {
        const bookId = identifier(input.book_id);
        if (!savedBookIds.includes(bookId)) throw new RequestError("Choose a book in this World.");
        if (action === "rename-book") {
          run(this.db, "UPDATE books SET name = ? WHERE id = ?", requiredText(input.name, "Enter a book name up to 100 characters.", TITLE_LIMIT), bookId);
        } else {
          run(this.db, "DELETE FROM books WHERE id = ?", bookId);
          const remainingBookIds = savedBookIds.filter(candidate => candidate !== bookId);
          this.renumber(id, remainingBookIds);
          let nextStatus = world.status;
          if (!remainingBookIds.length) nextStatus = "unindexed";
          else if (world.status !== "unindexed" && !this.indexing.hasPendingPassages(world)) nextStatus = "ready";
          run(this.db, "UPDATE worlds SET status = ?, error = CASE WHEN ? IN ('ready', 'unindexed') THEN NULL ELSE error END WHERE id = ?",
            nextStatus, nextStatus, id);
        }
      }
      if (world.graph_settings && action !== "rename-book") {
        run(this.db, `
          UPDATE worlds SET graph_published = NULL, graph_building = NULL, error = NULL,
            status = CASE WHEN status = 'unindexed' THEN status ELSE 'paused' END,
            graph_base = CASE WHEN status = 'unindexed' THEN NULL ELSE graph_base END WHERE id = ?
        `, id);
      }
      run(this.db, "UPDATE worlds SET book_revision = book_revision + 1 WHERE id = ?", id);
    });
    this.graphIndexes.collect();
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

  setKeys(id: string, kind: "embedding" | "extraction" | "retrieval", selection: unknown) {
    const world = kind === "retrieval" ? this.require(id) : this.editable(id);
    if (kind === "extraction" && !world.graph_settings) throw new RequestError("Set up Graph RAG first.", 409);
    const ids = this.keys.validate(selection);
    transaction(this.db, () => {
      const table = kind === "embedding" ? "world_embedding_keys" : kind === "retrieval" ? "world_retrieval_keys" : "world_extraction_keys";
      saveSelection(this.db, table, id, ids);
    });
  }

  async saveSettings(id: string, input: Record<string, unknown>, start: boolean) {
    const world = this.editable(id, this.requireRevision(input.book_revision));
    if (world.status !== "unindexed") {
      if (!start || world.graph_settings) throw new RequestError("Delete indexing to change these settings.", 409);
      const graph = readGraphSettings(input.graph, world.max_chunk_size, true);
      const keys = this.keys.validate(input.extraction_key_ids, true);
      transaction(this.db, () => {
        run(this.db, "UPDATE worlds SET graph_settings = ?, status = 'creating', error = NULL, book_revision = book_revision + 1 WHERE id = ?",
          JSON.stringify(graph), id);
        saveSelection(this.db, "world_extraction_keys", id, keys);
      });
      this.indexing.wake();
      return this.detail(id);
    }
    const graph = world.graph_settings === null ? undefined : JSON.parse(world.graph_settings);
    const settings = this.settings({ graph, extraction_key_ids: selectedKeys(this.db, "world_extraction_keys", id), ...input, name: world.name }, start);
    const model = EMBEDDING_MODELS.find(item => item.id === settings.model)!;
    const books = start ? all<StoredBook>(this.db, "SELECT * FROM books WHERE world_id = ? ORDER BY number", id) : [];
    if (start && !books.length) throw new RequestError("Add a book before starting indexing.");
    const prepared = await prepareBooks(books, settings.max_chunk_size);
    this.editable(id, input.book_revision);
    this.keys.validate(settings.key_ids, start);
    this.keys.validate(settings.extraction_key_ids, start);
    transaction(this.db, () => {
      run(this.db, `
        UPDATE worlds SET model = ?, dimensions = ?, max_token_limit = ?, max_chunk_size = ?,
          status = ?, error = NULL, graph_settings = ?, book_revision = book_revision + 1 WHERE id = ?
      `, model.id, model.dimensions, model.max_token_limit, settings.max_chunk_size,
      start ? "creating" : "unindexed", JSON.stringify(settings.graph), id);
      saveSelection(this.db, "world_embedding_keys", id, settings.key_ids);
      saveSelection(this.db, "world_extraction_keys", id, settings.extraction_key_ids);
      if (start) {
        books.forEach((book, number) => this.storeChunks(book.id, world.index_number, prepared[number]));
        this.keys.remember(model.id, settings.key_ids);
      }
    });
    this.indexing.wake();
    return this.detail(id);
  }

  clearIndex(id: string) {
    this.editable(id);
    transaction(this.db, () => {
      run(this.db, "DELETE FROM chunks WHERE book_id IN (SELECT id FROM books WHERE world_id = ?)", id);
      run(this.db, `
        UPDATE worlds SET status = 'unindexed', index_number = index_number + 1, error = NULL,
          graph_published = NULL, graph_base = NULL, graph_building = NULL, book_revision = book_revision + 1 WHERE id = ?
      `, id);
    });
    this.graphIndexes.collect();
    return this.detail(id);
  }

  discard(id: string) {
    this.require(id);
    const generations = all<{ id: number }>(this.db, "SELECT id FROM graph_generations WHERE world_id = ?", id);
    transaction(this.db, () => {
      run(this.db, "DELETE FROM persona_defaults WHERE scope = ?", id);
      run(this.db, "DELETE FROM worlds WHERE id = ?", id);
    });
    this.indexing.abort(id);
    this.graphIndexes.discard(generations.map(generation => generation.id));
  }
}
