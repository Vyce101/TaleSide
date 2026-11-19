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
    valid_vector,
)
from .provider_keys import KEY_SCHEMA, KeyConflict, ProviderKeys
from .tales import TALE_SCHEMA, Tales
from .world_imports import CheckedBooks, check_books

IMPORT_TIMEOUT_SECONDS = 30 * 60
DEFAULT_WORLD_NAME = "TaleSide"
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
    error TEXT
);
CREATE TABLE IF NOT EXISTS books (
    world_id TEXT REFERENCES worlds ON DELETE CASCADE,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    original BLOB NOT NULL,
    working TEXT NOT NULL,
    encoding TEXT NOT NULL,
    bom_size INTEGER NOT NULL,
    PRIMARY KEY (world_id, number)
);
CREATE TABLE IF NOT EXISTS chunks (
    world_id TEXT NOT NULL,
    book_number INTEGER NOT NULL,
    number INTEGER NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    original_start INTEGER NOT NULL,
    original_end INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    embed_end INTEGER NOT NULL,
    vector BLOB,
    PRIMARY KEY (world_id, book_number, number),
    FOREIGN KEY (world_id, book_number) REFERENCES books ON DELETE CASCADE
);
"""


@dataclass
class PendingImport:
    key_id: str
    cancelled: Event = field(default_factory=Event)
    checked: CheckedBooks | None = None
    world_row: tuple = ()
    timer: Timer | None = None


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
            db.executescript(KEY_SCHEMA + SCHEMA + TALE_SCHEMA)
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
            for world_id in tuple(self.imports):
                self._cancel_import_locked(world_id)

    def prepare(self, name, books, max_size=MAX_CHUNK_SIZE, search_distance=BOUNDARY_SEARCH_DISTANCE,
                *, model, key_id, world_id=None):
        if not isinstance(name, str):
            raise ValueError("World names must be text.")
        if model != MODEL:
            raise ValueError("Choose a supported embedding model.")
        books = tuple(books)
        if not books:
            raise ValueError("Select at least one TXT book.")
        if type(max_size) is not int or max_size < 1:
            raise ValueError("Maximum Chunk Size must be a positive whole number.")
        if type(search_distance) is not int or search_distance < 0:
            raise ValueError("Boundary Search Distance must be a nonnegative whole number.")
        if max_size > 2**63 - 1 or search_distance > 2**63 - 1:
            raise ValueError("Chunk settings are too large to save.")

        world_id = world_id or uuid4().hex
        with self.lock, self.connect() as db:
            if self.stopping.is_set():
                raise ValueError("TaleSide is closing.")
            if db.execute("SELECT 1 FROM worlds WHERE id = ?", (world_id,)).fetchone():
                raise ValueError("This import ID is already in use.")
            pending = self.imports.get(world_id)
            if pending is not None:
                if pending.checked is not None and pending.key_id == key_id:
                    return pending.checked.report
                raise ValueError("These books are already being checked.")
            secret = self.keys.secret(db, key_id)
            pending = PendingImport(key_id)
            self.imports[world_id] = pending
            self.keys.checking[key_id] += 1

        try:
            provider = self.provider(secret, model=model, dimensions=DIMENSIONS)
            checked = check_books(world_id, books, max_size, search_distance, TOKEN_LIMIT,
                                  provider.count, pending.cancelled)
            with self.lock:
                if pending.cancelled.is_set():
                    raise ValueError("The import was cancelled.")
                pending.world_row = (world_id, name.strip() or DEFAULT_WORLD_NAME, model, DIMENSIONS,
                                     TOKEN_LIMIT, max_size, search_distance, key_id)
                pending.checked = checked
                pending.timer = Timer(IMPORT_TIMEOUT_SECONDS, self.decline, args=(world_id,))
                pending.timer.daemon = True
                pending.timer.start()
                return checked.report
        finally:
            with self.lock:
                self.keys.checking[key_id] -= 1
                if not self.keys.checking[key_id]:
                    del self.keys.checking[key_id]
                if pending.timer is None and self.imports.get(world_id) is pending:
                    self._cancel_import_locked(world_id)

    def accept(self, world_id, allow_oversized=False):
        with self.lock:
            with self.connect() as db:
                if db.execute("SELECT 1 FROM worlds WHERE id = ? AND status != 'draft'", (world_id,)).fetchone():
                    return True
                pending = self.imports.get(world_id)
                if pending is None or pending.checked is None:
                    return False
                checked = pending.checked
                if checked.report["oversized_chunks"] and not allow_oversized:
                    return False
                self.keys.require(db, pending.key_id)
                db.execute("""
                    INSERT INTO worlds (id, name, model, dimensions, max_token_limit, max_chunk_size,
                                        boundary_search_distance, key_id, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating')
                """, pending.world_row)
                db.execute("UPDATE worlds SET retrieval_key_id = key_id WHERE id = ?", (world_id,))
                db.executemany("""
                    INSERT INTO books (world_id, number, name, filename, original, working, encoding, bom_size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, checked.book_rows)
                db.executemany("""
                    INSERT INTO chunks (world_id, book_number, number, start, end, original_start, original_end,
                                        tokens, embed_end)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, checked.chunk_rows)
                self.keys.remember(db, MODEL, pending.key_id)
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
                world["books"] = [dict(row) for row in db.execute("""
                    SELECT b.number, b.name, b.filename, count(*) AS total_chunks, count(c.vector) AS embedded_chunks
                    FROM books b JOIN chunks c ON c.world_id = b.world_id AND c.book_number = b.number
                    WHERE b.world_id = ? GROUP BY b.number ORDER BY b.number
                """, (world["id"],))]
                total = sum(book["total_chunks"] for book in world["books"])
                done = sum(book["embedded_chunks"] for book in world["books"])
                active_book = None
                if self.active_chunk is not None and self.active_chunk[0] == world["id"]:
                    active_book = self.active_chunk[1]
                world.update(total_chunks=total, embedded_chunks=done,
                             active_book=active_book,
                             progress=100 if world["status"] == "ready" else min(99, done * 100 // (total or 1)))
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
            return bool(db.execute("DELETE FROM worlds WHERE id = ? AND status != 'draft'", (world_id,)).rowcount)

    def set_embedding_key(self, world_id, key_id):
        with self.lock, self.connect() as db:
            self.keys.require(db, key_id)
            return bool(db.execute("""
                UPDATE worlds SET key_id = ? WHERE id = ? AND status IN ('paused', 'failed', 'ready')
            """, (key_id, world_id)).rowcount)

    def pause(self, world_id):
        with self.lock, self.connect() as db:
            active = self.active_chunk is not None and self.active_chunk[0] == world_id
            status = "pausing" if active else "paused"
            return bool(db.execute("""
                UPDATE worlds SET status = ? WHERE id = ? AND status = 'creating'
            """, (status, world_id)).rowcount)

    def resume(self, world_id):
        with self.lock, self.connect() as db:
            world = db.execute("SELECT key_id FROM worlds WHERE id = ? AND status IN ('paused', 'failed')",
                               (world_id,)).fetchone()
            if world is None:
                return False
            self.keys.require(db, world["key_id"])
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
                SELECT c.book_number, c.number, b.name, substr(b.working, c.start + 1, c.embed_end - c.start) AS text
                FROM chunks c JOIN books b ON b.world_id = c.world_id AND b.number = c.book_number
                WHERE c.world_id = ? AND c.vector IS NULL
                ORDER BY c.book_number, c.number LIMIT 1
            """, (world["id"],)).fetchone()
            if chunk is None:
                self.verify(db, world, vector_format)
                db.execute("UPDATE worlds SET status = 'ready' WHERE id = ?", (world["id"],))
                return
            self.active_chunk = (world["id"], chunk["book_number"])
            secret = self.keys.secret(db, world["key_id"])

        provider = self.provider(secret, model=world["model"], dimensions=dimensions)
        values = provider.embed(embedding_input(chunk["name"], chunk["text"]))
        if not valid_vector(values, dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        vector = vector_format.pack(*values)
        if not valid_vector(list(vector_format.unpack(vector)), dimensions):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        with self.lock, self.connect() as db:
            db.execute("""
                UPDATE chunks SET vector = ? WHERE world_id = ? AND book_number = ? AND number = ?
            """, (vector, world["id"], chunk["book_number"], chunk["number"]))
            db.execute("UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'pausing'", (world["id"],))
            self.active_chunk = None

    def verify(self, db, world, vector_format):
        books = db.execute("SELECT * FROM books WHERE world_id = ? ORDER BY number", (world["id"],))
        for book in books:
            chunks = db.execute("""
                SELECT * FROM chunks WHERE world_id = ? AND book_number = ? ORDER BY number
            """, (world["id"], book["number"]))
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
