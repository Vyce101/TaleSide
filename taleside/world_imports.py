"""Prepare TXT books and check what fits in each embedding before saving a World."""

from dataclasses import dataclass

from .books import prepare_txt
from .embeddings import TOKEN_LIMIT, embedding_input


@dataclass
class CheckedBooks:
    book_rows: list
    chunk_rows: list
    report: dict


def _prefix_length(count, text):
    minimum, maximum = 0, len(text)
    while minimum < maximum:
        middle = (minimum + maximum + 1) // 2
        if count(text[:middle]) <= TOKEN_LIMIT:
            minimum = middle
        else:
            maximum = middle - 1
    if minimum == 0:
        raise ValueError("The book name leaves no room for text in the embedding. Choose a shorter name.")
    return minimum


def check_books(world_id, books, max_size, search_distance, count_tokens, cancelled):
    book_rows = []
    chunks_to_check = []
    for book_number, source in enumerate(books, 1):
        if cancelled.is_set():
            raise ValueError("The import was cancelled.")
        if source.name is not None and not isinstance(source.name, str):
            raise ValueError("Book names must be text.")
        working, encoding, bom_size, chunks = prepare_txt(source, max_size, search_distance)
        book_name = (source.name or "").strip() or source.filename[:-4]
        book_rows.append((world_id, book_number, book_name, source.filename,
                          source.original, working, encoding, bom_size))
        chunks_to_check.extend((book_number, number, book_name, chunk, working)
                               for number, chunk in enumerate(chunks, 1))

    chunk_rows = []
    oversized = []
    for book_number, number, book_name, chunk, working in chunks_to_check:
        def count(text):
            if cancelled.is_set():
                raise ValueError("The import was cancelled.")
            # The title and separators count against the same limit as the text.
            return count_tokens(embedding_input(book_name, text))

        text = working[chunk.start:chunk.end]
        tokens = count(text)
        embed_end = chunk.end
        if tokens > TOKEN_LIMIT:
            embed_end = chunk.start + _prefix_length(count, text)
            oversized.append({
                "book_number": book_number,
                "chunk_number": number,
                "tokens": tokens,
                "characters": len(text),
                "embedded_characters": embed_end - chunk.start,
            })
        chunk_rows.append((world_id, book_number, number, chunk.start, chunk.end,
                           chunk.original_start, chunk.original_end, tokens, embed_end))
    report = {
        "id": world_id,
        "chunk_count": len(chunk_rows),
        "token_limit": TOKEN_LIMIT,
        "oversized_chunks": oversized,
    }
    return CheckedBooks(book_rows, chunk_rows, report)
