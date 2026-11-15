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
    EmbeddingError,
    embedding_input,
    valid_vector,
)
from .world_imports import CheckedBooks, check_books

VECTOR = Struct(f"<{DIMENSIONS}f")
IMPORT_TIMEOUT_SECONDS = 30 * 60
DEFAULT_WORLD_NAME = "TaleSide"
SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    max_chunk_size INTEGER NOT NULL,
    boundary_search_distance INTEGER NOT NULL,
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
    cancelled: Event = field(default_factory=Event)
    checked: CheckedBooks | None = None
    world_row: tuple = ()
    timer: Timer | None = None


class Worlds:
    def __init__(self, database, provider):
        self.database = database
        self.provider = provider
        self.wake = Event()
        self.stopping = Event()
        self.lock = Lock()
        self.imports = {}
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(SCHEMA)
            db.execute("UPDATE worlds SET status = 'paused' WHERE status = 'creating'")
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
                *, world_id=None):
        if not isinstance(name, str):
            raise ValueError("World names must be text.")
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
                if pending.checked is not None:
                    return pending.checked.report
                raise ValueError("These books are already being checked.")
            pending = PendingImport()
            self.imports[world_id] = pending

        try:
            checked = check_books(world_id, books, max_size, search_distance, self.provider.count, pending.cancelled)
            with self.lock:
                if pending.cancelled.is_set():
                    raise ValueError("The import was cancelled.")
                pending.world_row = (world_id, name.strip() or DEFAULT_WORLD_NAME, MODEL, DIMENSIONS,
                                     max_size, search_distance)
                pending.checked = checked
                pending.timer = Timer(IMPORT_TIMEOUT_SECONDS, self.decline, args=(world_id,))
                pending.timer.daemon = True
                pending.timer.start()
                return checked.report
        finally:
            if pending.timer is None:
                with self.lock:
                    if self.imports.get(world_id) is pending:
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
                db.execute("""
                    INSERT INTO worlds (id, name, model, dimensions, max_chunk_size, boundary_search_distance, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'creating')
                """, pending.world_row)
                db.executemany("""
                    INSERT INTO books (world_id, number, name, filename, original, working, encoding, bom_size)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, checked.book_rows)
                db.executemany("""
                    INSERT INTO chunks (world_id, book_number, number, start, end, original_start, original_end,
                                        tokens, embed_end)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, checked.chunk_rows)
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

    def list(self):
        with self.connect() as db:
            db.execute("BEGIN")
            worlds = [dict(row) for row in db.execute("""
                SELECT id, name, status, error FROM worlds WHERE status != 'draft' ORDER BY rowid
            """)]
            for world in worlds:
                world["books"] = [dict(row) for row in db.execute("""
                    SELECT b.number, b.name, count(*) AS total_chunks, count(c.vector) AS embedded_chunks
                    FROM books b JOIN chunks c ON c.world_id = b.world_id AND c.book_number = b.number
                    WHERE b.world_id = ? GROUP BY b.number ORDER BY b.number
                """, (world["id"],))]
                total = sum(book["total_chunks"] for book in world["books"])
                done = sum(book["embedded_chunks"] for book in world["books"])
                world.update(total_chunks=total, embedded_chunks=done,
                             progress=100 if world["status"] == "ready" else min(99, done * 100 // total))
        return worlds

    def pause(self, world_id):
        with self.connect() as db:
            return bool(db.execute("""
                UPDATE worlds SET status = 'paused' WHERE id = ? AND status = 'creating'
            """, (world_id,)).rowcount)

    def resume(self, world_id):
        with self.connect() as db:
            updated = db.execute("""
                UPDATE worlds SET status = 'creating', error = NULL
                WHERE id = ? AND status IN ('paused', 'failed')
            """, (world_id,)).rowcount
        if updated:
            self.wake.set()
        return bool(updated)

    def run(self):
        while not self.stopping.is_set():
            self.wake.clear()
            if self.stopping.is_set():
                return
            with self.connect() as db:
                world = db.execute("SELECT * FROM worlds WHERE status = 'creating' ORDER BY rowid LIMIT 1").fetchone()
            if world is None:
                self.wake.wait()
                continue
            try:
                self.process_next(world)
            except (EmbeddingError, ValueError, sqlite3.Error) as error:
                message = str(error) if isinstance(error, EmbeddingError) else "Could not verify the saved World."
                with self.connect() as db:
                    db.execute("""
                        UPDATE worlds SET status = 'failed', error = ? WHERE id = ? AND status = 'creating'
                    """, (message, world["id"]))

    def process_next(self, world):
        if (world["model"], world["dimensions"]) != (MODEL, DIMENSIONS):
            raise EmbeddingError("This World's saved embedding profile is unavailable.")
        with self.connect() as db:
            chunk = db.execute("""
                SELECT c.book_number, c.number, b.name, substr(b.working, c.start + 1, c.embed_end - c.start) AS text
                FROM chunks c JOIN books b ON b.world_id = c.world_id AND b.number = c.book_number
                WHERE c.world_id = ? AND c.vector IS NULL
                ORDER BY c.book_number, c.number LIMIT 1
            """, (world["id"],)).fetchone()
            status = db.execute("SELECT status FROM worlds WHERE id = ?", (world["id"],)).fetchone()[0]
            if status != "creating" or self.stopping.is_set():
                return
        if chunk is None:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT status FROM worlds WHERE id = ?", (world["id"],)).fetchone()[0] == "creating":
                    self.verify(db, world)
                    db.execute("UPDATE worlds SET status = 'ready' WHERE id = ?", (world["id"],))
            return

        values = self.provider.embed(embedding_input(chunk["name"], chunk["text"]))
        if not valid_vector(values):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        vector = VECTOR.pack(*values)
        if not valid_vector(list(VECTOR.unpack(vector))):
            raise EmbeddingError("Gemini returned an invalid embedding vector.")
        with self.connect() as db:
            db.execute("""
                UPDATE chunks SET vector = ? WHERE world_id = ? AND book_number = ? AND number = ?
            """, (vector, world["id"], chunk["book_number"], chunk["number"]))

    def verify(self, db, world):
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
                        or vector is None or len(vector) != VECTOR.size
                        or not valid_vector(list(VECTOR.unpack(vector)))):
                    raise ValueError("Invalid saved chunk.")
                start, source_start = end, source_end
            if start != len(book["working"]) or source_start != len(book["original"]):
                raise ValueError("Incomplete book.")
