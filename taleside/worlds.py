"""Store Worlds and process accepted imports in a single background worker."""

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass, field
from struct import Struct
from threading import Event, Lock, Thread, Timer
from uuid import uuid4

from .books import (
    BOUNDARY_SEARCH_DISTANCE,
    MAX_CHUNK_SIZE,
    normalize_lines,
)
from .embeddings import (
    DIMENSIONS,
    MODEL,
    TOKEN_LIMIT,
    EmbeddingError,
    Gemini,
    embedding_input,
    fit_embedding,
    valid_vector,
)
from .provider_keys import (
    KEY_SCHEMA, SELECTION_SCHEMA, KeyConflict, ProviderKeys, migrate_key_selections,
    save_key_selection, selected_keys,
)
from .tales import TALE_SCHEMA, Tales
from .world_imports import PreparedBooks, prepare_books

IMPORT_TIMEOUT_SECONDS = 30 * 60
DEFAULT_WORLD_NAME = "TaleSide"
EMBEDDING_KEY_REQUIRED = "Choose a saved Google Gemini key in World Settings."
SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    max_token_limit INTEGER NOT NULL,
    max_chunk_size INTEGER NOT NULL,
    boundary_search_distance INTEGER NOT NULL,
    key_id TEXT REFERENCES provider_keys ON DELETE SET NULL,
    error TEXT,
    index_number INTEGER NOT NULL DEFAULT 1,
    previous_index INTEGER,
    previous_model TEXT,
    previous_dimensions INTEGER,
    previous_token_limit INTEGER,
    previous_chunk_size INTEGER,
    book_revision INTEGER NOT NULL DEFAULT 0,
    reindexing INTEGER NOT NULL DEFAULT 0
);
"""
BOOK_SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    world_id TEXT REFERENCES worlds ON DELETE CASCADE,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    original BLOB NOT NULL,
    working TEXT NOT NULL,
    encoding TEXT NOT NULL,
    bom_size INTEGER NOT NULL,
    UNIQUE (world_id, number)
);
CREATE TABLE IF NOT EXISTS chunks (
    book_id TEXT NOT NULL REFERENCES books ON DELETE CASCADE,
    index_number INTEGER NOT NULL,
    number INTEGER NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    original_start INTEGER NOT NULL,
    original_end INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    embed_end INTEGER NOT NULL,
    vector BLOB,
    PRIMARY KEY (book_id, index_number, number)
);
"""
SCHEMA += BOOK_SCHEMA


@dataclass
class PendingImport:
    key_ids: list[str]
    cancelled: Event = field(default_factory=Event)
    books: PreparedBooks | None = None
    world_row: tuple = ()
    timer: Timer | None = None


def migrate_books(db):
    if "book_number" not in {column["name"] for column in db.execute("PRAGMA table_info(chunks)")}:
        return
    db.execute("ALTER TABLE books RENAME TO legacy_books")
    db.execute("ALTER TABLE chunks RENAME TO legacy_chunks")
    for statement in BOOK_SCHEMA.strip().rstrip(";").split(";"):
        db.execute(statement)
    db.execute("""
        INSERT INTO books
        SELECT lower(hex(randomblob(16))), world_id, number, name, filename, original, working, encoding, bom_size
        FROM legacy_books
    """)
    db.execute("""
        INSERT INTO chunks
        SELECT b.id, 1, c.number, c.start, c.end, c.original_start, c.original_end, c.tokens, c.embed_end, c.vector
        FROM legacy_chunks c JOIN books b ON b.world_id = c.world_id AND b.number = c.book_number
    """)
    db.execute("DROP TABLE legacy_chunks")
    db.execute("DROP TABLE legacy_books")


class Worlds:
    def __init__(self, database, provider=Gemini):
        self.database = database
        self.provider = provider
        self.wake = Event()
        self.stopping = Event()
        self.lock = Lock()
        self.keys = ProviderKeys(self.connect, self.lock)
        self.tales = Tales(self)
        self.imports = {}
        self.active_chunk = None
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(KEY_SCHEMA + SCHEMA + TALE_SCHEMA + SELECTION_SCHEMA)
            db.execute("BEGIN")
            columns = {column["name"] for column in db.execute("PRAGMA table_info(worlds)")}
            if "max_token_limit" not in columns:
                db.execute("ALTER TABLE worlds ADD COLUMN max_token_limit INTEGER NOT NULL DEFAULT 8192")
            if "key_id" not in columns:
                db.execute("ALTER TABLE worlds ADD COLUMN key_id TEXT REFERENCES provider_keys ON DELETE SET NULL")
            if "retrieval_key_id" not in columns:
                db.execute("ALTER TABLE worlds ADD COLUMN retrieval_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL")
                db.execute("UPDATE worlds SET retrieval_key_id = key_id")
            if "last_tale_activity_at" not in columns:
                db.execute("ALTER TABLE worlds ADD COLUMN last_tale_activity_at REAL")
            if "index_number" not in columns:
                db.execute("ALTER TABLE worlds ADD COLUMN index_number INTEGER NOT NULL DEFAULT 1")
                db.execute("ALTER TABLE worlds ADD COLUMN previous_index INTEGER")
                db.execute("ALTER TABLE worlds ADD COLUMN previous_model TEXT")
                db.execute("ALTER TABLE worlds ADD COLUMN previous_dimensions INTEGER")
                db.execute("ALTER TABLE worlds ADD COLUMN previous_token_limit INTEGER")
                db.execute("ALTER TABLE worlds ADD COLUMN previous_chunk_size INTEGER")
                db.execute("ALTER TABLE worlds ADD COLUMN book_revision INTEGER NOT NULL DEFAULT 0")
                db.execute("ALTER TABLE worlds ADD COLUMN reindexing INTEGER NOT NULL DEFAULT 0")
            migrate_books(db)
            migrate_key_selections(db)
            db.execute("UPDATE worlds SET status = 'paused' WHERE status IN ('creating', 'pausing')")
            db.execute("UPDATE tale_messages SET status = 'error' WHERE status = 'generating'")
        self.worker = Thread(target=self.run, name="World embeddings", daemon=True)
        self.worker.start()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys = ON")
            with db:
                yield db
        finally:
            db.close()

    def close(self):
        self.stopping.set()
        self.wake.set()
        self.worker.join()
        with self.lock:
            for generation in self.tales.active.values():
                generation.cancel()
            for world_id in tuple(self.imports):
                self._cancel_import_locked(world_id)

    def prepare(self, name, books, max_size=MAX_CHUNK_SIZE, search_distance=BOUNDARY_SEARCH_DISTANCE,
                *, model, key_ids, world_id=None):
        books = tuple(books)
        world_id = world_id or uuid4().hex
        with self.lock, self.connect() as db:
            if self.stopping.is_set():
                raise ValueError("TaleSide is closing.")
            if db.execute("SELECT 1 FROM worlds WHERE id = ?", (world_id,)).fetchone():
                raise ValueError("This import ID is already in use.")
            if not isinstance(name, str):
                raise ValueError("World names must be text.")
            if model != MODEL:
                raise ValueError("Choose a supported embedding model.")
            if not books:
                raise ValueError("Select at least one TXT book.")
            if type(max_size) is not int or max_size < 1:
                raise ValueError("Maximum Chunk Size must be a positive whole number.")
            if type(search_distance) is not int or search_distance < 0:
                raise ValueError("Boundary Search Distance must be a nonnegative whole number.")
            if max_size > 2**63 - 1 or search_distance > 2**63 - 1:
                raise ValueError("Chunk settings are too large to save.")
            self.keys.validate_selection(db, key_ids, EMBEDDING_KEY_REQUIRED, required=True)
            existing = self.imports.get(world_id)
            if existing is not None:
                if existing.books is not None and existing.key_ids == key_ids:
                    return {"id": world_id, "chunk_count": len(existing.books.chunk_rows)}
                raise ValueError("This import is already in progress.")
            pending = PendingImport(list(key_ids))
            self.imports[world_id] = pending

        try:
            ready = prepare_books(world_id, books, max_size, search_distance, pending.cancelled)
            with self.lock:
                if pending.cancelled.is_set():
                    raise ValueError("The import was cancelled.")
                pending.world_row = (model, DIMENSIONS, TOKEN_LIMIT, max_size, search_distance,
                                     name.strip() or DEFAULT_WORLD_NAME)
                pending.books = ready
                pending.timer = Timer(IMPORT_TIMEOUT_SECONDS, self.decline, args=(world_id,))
                pending.timer.daemon = True
                pending.timer.start()
                return {"id": world_id, "chunk_count": len(ready.chunk_rows)}
        finally:
            with self.lock:
                if pending.timer is None and self.imports.get(world_id) is pending:
                    self._cancel_import_locked(world_id)

    def accept(self, world_id):
        with self.lock:
            with self.connect() as db:
                if db.execute("SELECT 1 FROM worlds WHERE id = ? AND status != 'draft'", (world_id,)).fetchone():
                    return True
                pending = self.imports.get(world_id)
                if pending is None or pending.books is None:
                    return False
                self.keys.validate_selection(db, pending.key_ids, EMBEDDING_KEY_REQUIRED, required=True)
                db.execute("""
                    INSERT INTO worlds (model, dimensions, max_token_limit, max_chunk_size,
                                        boundary_search_distance, name, id, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'creating')
                """, (*pending.world_row, world_id))
                save_key_selection(db, "world_embedding_keys", world_id, pending.key_ids)
                save_key_selection(db, "world_retrieval_keys", world_id, pending.key_ids)
                self.keys.remember(db, MODEL, pending.key_ids)
                db.executemany("""
                    INSERT INTO books (id, world_id, number, name, filename, original, working, encoding, bom_size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, ((uuid4().hex, *book) for book in pending.books.book_rows))
                book_ids = dict(db.execute("SELECT number, id FROM books WHERE world_id = ?", (world_id,)))
                db.executemany("""
                    INSERT INTO chunks (book_id, index_number, number, start, end, original_start, original_end,
                                        tokens, embed_end)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, ((book_ids[number], 1, *chunk) for number, *chunk in pending.books.chunk_rows))
            self._cancel_import_locked(world_id)
        self.wake.set()
        return True

    def decline(self, world_id):
        with self.lock:
            return self._cancel_import_locked(world_id)

    def _cancel_import_locked(self, world_id):
        pending = self.imports.pop(world_id, None)
        if pending is None:
            return False
        pending.cancelled.set()
        if pending.timer is not None:
            pending.timer.cancel()
        return True

    def list(self, world_id=None):
        with self.lock, self.connect() as db:
            db.execute("BEGIN")
            query = "SELECT * FROM worlds WHERE status != 'draft'"
            filters = ()
            if world_id is not None:
                query += " AND id = ?"
                filters = (world_id,)
            worlds = [dict(row) for row in db.execute(query + " ORDER BY last_tale_activity_at DESC, rowid", filters)]
            for world in worlds:
                del world["key_id"], world["retrieval_key_id"]
                world["embedding_key_ids"] = selected_keys(db, "world_embedding_keys", world["id"])
                world["retrieval_key_ids"] = selected_keys(db, "world_retrieval_keys", world["id"])
                world["books"] = [dict(row) for row in db.execute("""
                    SELECT b.id, b.number, b.name, b.filename, count(*) AS total_chunks, count(c.vector) AS embedded_chunks
                    FROM books b JOIN chunks c ON c.book_id = b.id AND c.index_number = ?
                    WHERE b.world_id = ? GROUP BY b.id ORDER BY b.number
                """, (world["index_number"], world["id"]))]
                total = sum(book["total_chunks"] for book in world["books"])
                done = sum(book["embedded_chunks"] for book in world["books"])
                active_book = None
                if self.active_chunk is not None and self.active_chunk[0] == world["id"]:
                    active_book = self.active_chunk[1]
                world.update(total_chunks=total, embedded_chunks=done,
                             active_book=active_book,
                             progress=100 if world["status"] == "ready" else min(99, done * 100 // (total or 1)))
                for field in ("index_number", "previous_index", "previous_model", "previous_dimensions",
                              "previous_token_limit", "previous_chunk_size"):
                    del world[field]
                del world["reindexing"]
        return worlds

    def detail(self, world_id):
        worlds = self.list(world_id)
        return worlds[0] if worlds else None

    def rename(self, world_id, name):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Enter a World name.")
        with self.lock, self.connect() as db:
            return bool(db.execute("""
                UPDATE worlds SET name = ? WHERE id = ? AND status != 'draft'
            """, (name.strip(), world_id)).rowcount)

    def discard(self, world_id):
        with self.lock, self.connect() as db:
            for generation in self.tales.active.values():
                if generation.world_id == world_id:
                    generation.cancel()
            return bool(db.execute("DELETE FROM worlds WHERE id = ? AND status != 'draft'", (world_id,)).rowcount)

    def set_embedding_keys(self, world_id, key_ids):
        with self.lock, self.connect() as db:
            self.keys.validate_selection(db, key_ids, EMBEDDING_KEY_REQUIRED)
            world = db.execute("""
                SELECT 1 FROM worlds WHERE id = ? AND status IN ('paused', 'failed', 'ready')
            """, (world_id,)).fetchone()
            if world is None:
                return False
            save_key_selection(db, "world_embedding_keys", world_id, key_ids)
            return True

    def pause(self, world_id):
        with self.lock, self.connect() as db:
            active = self.active_chunk is not None and self.active_chunk[0] == world_id
            status = "pausing" if active else "paused"
            return bool(db.execute("""
                UPDATE worlds SET status = ? WHERE id = ? AND status = 'creating'
            """, (status, world_id)).rowcount)

    def resume(self, world_id):
        with self.lock, self.connect() as db:
            world = db.execute("SELECT 1 FROM worlds WHERE id = ? AND status IN ('paused', 'failed')",
                               (world_id,)).fetchone()
            if world is None:
                return False
            if not selected_keys(db, "world_embedding_keys", world_id):
                raise KeyConflict(EMBEDDING_KEY_REQUIRED)
            db.execute("UPDATE worlds SET status = 'creating', error = NULL WHERE id = ?", (world_id,))
        self.wake.set()
        return True

    def run(self):
        while not self.stopping.is_set():
            self.wake.clear()
            if self.stopping.is_set():
                return
            with self.connect() as db:
                world = db.execute("SELECT id FROM worlds WHERE status = 'creating' ORDER BY rowid LIMIT 1").fetchone()
            if world is None:
                self.wake.wait()
                continue
            try:
                self.process_next(world["id"])
            except (EmbeddingError, KeyConflict, ValueError, sqlite3.Error) as error:
                message = (str(error) if isinstance(error, (EmbeddingError, KeyConflict))
                           else "Could not verify the saved World.")
                with self.lock, self.connect() as db:
                    db.execute("""
                        UPDATE worlds SET status = 'failed', error = ? WHERE id = ? AND status IN ('creating', 'pausing')
                    """, (message, world["id"]))
                    self.active_chunk = None

    def process_next(self, world_id):
        with self.lock, self.connect() as db:
            world = db.execute("SELECT * FROM worlds WHERE id = ? AND status = 'creating'", (world_id,)).fetchone()
            if world is None or self.stopping.is_set():
                return
            if world["model"] != MODEL or not 128 <= world["dimensions"] <= DIMENSIONS:
                raise EmbeddingError("This World's saved embedding model or dimensions are unavailable.")
            dimensions = world["dimensions"]
            vector_format = Struct(f"<{dimensions}f")
            chunk = db.execute("""
                SELECT b.id, b.number AS book_number, c.number, c.start, c.tokens, b.name,
                       substr(b.working, c.start + 1, c.embed_end - c.start) AS text
                FROM chunks c JOIN books b ON b.id = c.book_id
                WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NULL
                ORDER BY b.number, c.number LIMIT 1
            """, (world_id, world["index_number"])).fetchone()
            if chunk is None:
                self.verify(db, world, vector_format)
                db.execute("UPDATE worlds SET status = 'ready' WHERE id = ?", (world_id,))
                return
            self.active_chunk = (world["id"], chunk["book_number"])
            key_ids = selected_keys(db, "world_embedding_keys", world_id)

        def next_provider():
            with self.lock, self.connect() as db:
                secret = self.keys.next_secret(db, "embedding", key_ids)
            return self.provider(secret, model=world["model"], dimensions=dimensions)

        text = chunk["text"]
        tokens, length = chunk["tokens"], len(text)
        if not tokens:
            tokens, length = fit_embedding(chunk["name"], text, world["max_token_limit"],
                                           lambda value: next_provider().count(value))
        values = next_provider().embed(embedding_input(chunk["name"], text[:length]))
        if not valid_vector(values, dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        vector = vector_format.pack(*values)
        if not valid_vector(list(vector_format.unpack(vector)), dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        with self.lock, self.connect() as db:
            db.execute("""
                UPDATE chunks SET vector = ?, tokens = ?, embed_end = ?
                WHERE book_id = ? AND index_number = ? AND number = ?
            """, (vector, tokens, chunk["start"] + length, chunk["id"], world["index_number"], chunk["number"]))
            db.execute("UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'pausing'", (world["id"],))
            self.active_chunk = None

    def verify(self, db, world, vector_format):
        books = db.execute("SELECT * FROM books WHERE world_id = ? ORDER BY number", (world["id"],))
        for book in books:
            chunks = db.execute("""
                SELECT * FROM chunks WHERE book_id = ? AND index_number = ? ORDER BY number
            """, (book["id"], world["index_number"]))
            start, source_start = 0, book["bom_size"]
            for number, chunk in enumerate(chunks, 1):
                end, source_end = chunk["end"], chunk["original_end"]
                working = book["working"][start:end]
                source = book["original"][source_start:source_end].decode(book["encoding"])
                vector = chunk["vector"]
                if (chunk["number"] != number or chunk["start"] != start or chunk["original_start"] != source_start
                        or not start < chunk["embed_end"] <= end
                        or end - start > world["max_chunk_size"] or normalize_lines(source) != working
                        or vector is None or len(vector) != vector_format.size
                        or not valid_vector(list(vector_format.unpack(vector)), world["dimensions"])):
                    raise ValueError("Invalid saved chunk.")
                start, source_start = end, source_end
            if start != len(book["working"]) or source_start != len(book["original"]):
                raise ValueError("Incomplete book.")
