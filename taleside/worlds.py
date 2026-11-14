"""Store Worlds and process accepted imports in a single background worker."""

import sqlite3
from contextlib import contextmanager
from uuid import uuid4

from .books import (
    BOUNDARY_SEARCH_DISTANCE,
    MAX_CHUNK_SIZE,
    prepare_txt,
)
from .embeddings import (
    DIMENSIONS,
    MODEL,
    TOKEN_LIMIT,
    embedding_input,
)

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
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(SCHEMA)

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
