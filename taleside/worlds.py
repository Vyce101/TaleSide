"""Store Worlds and process accepted imports in a single background worker."""

import sqlite3
from contextlib import contextmanager
from struct import Struct
from threading import Event, Thread
from uuid import uuid4

from .books import (
    BOUNDARY_SEARCH_DISTANCE,
    MAX_CHUNK_SIZE,
    normalize_lines,
    prepare_txt,
)
from .embeddings import (
    DIMENSIONS,
    MODEL,
    TOKEN_LIMIT,
    EmbeddingError,
    embedding_input,
    valid_vector,
)

VECTOR = Struct(f"<{DIMENSIONS}f")
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


def prefix_length(provider, name, text):
    # Count the complete formatted request at every tested prefix.
    minimum, maximum = 0, len(text)
    while minimum < maximum:
        middle = (minimum + maximum + 1) // 2
        if provider.count(embedding_input(name, text[:middle])) <= TOKEN_LIMIT:
            minimum = middle
        else:
            maximum = middle - 1
    if minimum == 0:
        raise ValueError("The book name leaves no room for text in the embedding. Choose a shorter name.")
    return minimum


class Worlds:
    def __init__(self, database, provider):
        self.database = database
        self.provider = provider
        self.wake = Event()
        self.stopping = Event()
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

    def prepare(self, name, books, max_size=MAX_CHUNK_SIZE, search_distance=BOUNDARY_SEARCH_DISTANCE):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Enter a World name.")
        books = tuple(books)
        if not books:
            raise ValueError("Select at least one TXT book.")
        if type(max_size) is not int or max_size < 1:
            raise ValueError("Maximum Chunk Size must be a positive whole number.")
        if type(search_distance) is not int or search_distance < 0:
            raise ValueError("Boundary Search Distance must be a nonnegative whole number.")
        if max_size > 2**63 - 1 or search_distance > 2**63 - 1:
            raise ValueError("Chunk settings are too large to save.")

        world_id = uuid4().hex
        book_rows, chunk_rows, oversized = [], [], []
        for book_number, source in enumerate(books, 1):
            if source.name is not None and not isinstance(source.name, str):
                raise ValueError("Book names must be text.")
            working, encoding, bom_size, chunks = prepare_txt(source, max_size, search_distance)
            book_name = (source.name or "").strip() or source.filename[:-4]
            book_rows.append((world_id, book_number, book_name, source.filename,
                              source.original, working, encoding, bom_size))
            chunk_rows.extend((book_number, number, book_name, chunk, working)
                              for number, chunk in enumerate(chunks, 1))

        checked = []
        for book_number, number, book_name, chunk, working in chunk_rows:
            text = working[chunk.start:chunk.end]
            tokens = self.provider.count(embedding_input(book_name, text))
            embed_end = chunk.end
            if tokens > TOKEN_LIMIT:
                embed_end = chunk.start + prefix_length(self.provider, book_name, text)
                oversized.append({
                    "book_number": book_number, "chunk_number": number, "tokens": tokens,
                    "characters": len(text), "embedded_characters": embed_end - chunk.start,
                })
            checked.append((world_id, book_number, number, chunk.start, chunk.end,
                            chunk.original_start, chunk.original_end, tokens, embed_end))

        with self.connect() as db:
            db.execute("INSERT INTO worlds VALUES (?, ?, 'draft', ?, ?, ?, ?, NULL)",
                       (world_id, name.strip(), MODEL, DIMENSIONS, max_size, search_distance))
            db.executemany("INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?)", book_rows)
            db.executemany("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)", checked)
        return {"id": world_id, "chunk_count": len(checked), "token_limit": TOKEN_LIMIT,
                "oversized_chunks": oversized}

    def accept(self, world_id, allow_oversized=False):
        with self.connect() as db:
            updated = db.execute("""
                UPDATE worlds SET status = 'creating' WHERE id = ? AND status = 'draft'
                AND (? OR NOT EXISTS (SELECT 1 FROM chunks WHERE world_id = ? AND tokens > ?))
            """, (world_id, allow_oversized, world_id, TOKEN_LIMIT)).rowcount
        if updated:
            self.wake.set()
        return bool(updated)

    def decline(self, world_id):
        with self.connect() as db:
            return bool(db.execute("DELETE FROM worlds WHERE id = ? AND status = 'draft'", (world_id,)).rowcount)

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
