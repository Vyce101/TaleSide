"""Prepare TXT books and their source offsets locally."""

from dataclasses import dataclass

from .books import prepare_txt


@dataclass
class PreparedBooks:
    book_rows: list
    chunk_rows: list


def prepare_books(world_id, books, max_size, search_distance, cancelled):
    book_rows = []
    chunk_rows = []
    for book_number, source in enumerate(books, 1):
        if cancelled.is_set():
            raise ValueError("The import was cancelled.")
        if source.name is not None and not isinstance(source.name, str):
            raise ValueError("Book names must be text.")
        working, encoding, bom_size, chunks = prepare_txt(source, max_size, search_distance)
        book_name = (source.name or "").strip() or source.filename[:-4]
        book_rows.append((world_id, book_number, book_name, source.filename,
                          source.original, working, encoding, bom_size))
        chunk_rows.extend((world_id, book_number, number, chunk.start, chunk.end, chunk.original_start, chunk.original_end,
                           0, chunk.end) for number, chunk in enumerate(chunks, 1))
    return PreparedBooks(book_rows, chunk_rows)
