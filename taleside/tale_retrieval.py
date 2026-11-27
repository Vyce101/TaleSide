"""Rank and read relevant passages from the saved World."""

from math import sqrt
from struct import Struct
from typing import NamedTuple


FLOAT32_MAX = 3.4028234663852886e38
PASSAGE_SEPARATOR = "\n\n"
CHUNK_TEXT_LABEL = "Chunk text:\n"
SKIPPED_PASSAGE_LIMIT = 20


class PassageMatch(NamedTuple):
    similarity: float
    book_number: int
    chunk_number: int
    book_id: str
    book_name: str
    start_character: int
    end_character: int
    start_with_overlap: int


def _valid_vector(values, dimensions):
    return (
        isinstance(values, list)
        and len(values) == dimensions
        and all(
            type(value) in (int, float) and -FLOAT32_MAX <= value <= FLOAT32_MAX
            for value in values
        )
        and any(values)
    )


def _book_heading(number, name):
    return f"Book {number} — {name}"


def _chunk_heading(number):
    return f"Chunk {number}\n"


def _preceding_heading(number):
    return f"Preceding context (Chunk {number - 1}):\n"


def _overlap_cost(match):
    overlap_characters = match.start_character - match.start_with_overlap
    if not overlap_characters:
        return 0
    return len(_preceding_heading(match.chunk_number)) + overlap_characters + len("\n")


def passage_prompt_parts(selected_passages):
    """Format the selected passages in book order with reusable pieces for request capture."""
    parts = []
    current_book = None
    for passage in selected_passages:
        if parts:
            parts.append(PASSAGE_SEPARATOR)
        if passage["book"] != current_book:
            current_book = passage["book"]
            parts.extend((_book_heading(current_book, passage["name"]), PASSAGE_SEPARATOR))
        parts.append(_chunk_heading(passage["chunk"]))
        if passage.get("preceding"):
            parts.extend((_preceding_heading(passage["chunk"]), passage["preceding"], "\n"))
        parts.extend((CHUNK_TEXT_LABEL, passage["text"]))
    return parts


def passages(db, world, query, settings, cancelled):
    dimensions = world["dimensions"]
    if not _valid_vector(query, dimensions):
        raise ValueError("Gemini returned an invalid retrieval vector.")
    vector_format = Struct(f"<{dimensions}f")
    query_length = sqrt(sum(value * value for value in query))
    minimum_similarity = settings["minimum_similarity"]
    overlap_characters = settings["chunk_overlap"]
    chunks = db.execute("""
        SELECT b.number AS book_number, b.name AS book_name, c.book_id, c.number, c.start, c.end, c.vector,
            prior.start AS prior_start
        FROM chunks c JOIN books b ON b.id = c.book_id
        LEFT JOIN chunks prior ON prior.book_id = c.book_id AND prior.index_number = c.index_number AND prior.number = c.number - 1
        WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL
    """, (world["id"], world["index_number"]))

    below_minimum = 0

    def matches():
        nonlocal below_minimum
        for chunk in chunks:
            if cancelled.is_set():
                return
            vector = vector_format.unpack(chunk["vector"])
            vector_length = sqrt(sum(value * value for value in vector))
            if not vector_length:
                continue
            dot_product = sum(value * query_value for value, query_value in zip(vector, query))
            similarity = dot_product / (vector_length * query_length)
            meets_minimum_similarity = similarity >= minimum_similarity
            if not meets_minimum_similarity:
                below_minimum += 1
                continue

            start_character = chunk["start"]
            start_with_overlap = start_character
            if chunk["prior_start"] is not None:
                start_with_overlap = max(chunk["prior_start"], start_character - overlap_characters)
            yield PassageMatch(
                similarity, chunk["book_number"], chunk["number"], chunk["book_id"],
                chunk["book_name"], start_character, chunk["end"], start_with_overlap,
            )

    ranked = sorted(matches(), key=lambda match: (-match.similarity, match.book_number, match.chunk_number))
    selected = {}
    selected_books = set()
    skipped = []
    skipped_count = 0
    remaining_characters = settings["chunk_budget"]
    for match in ranked:
        previous_chunk_selected = (match.book_number, match.chunk_number - 1) in selected
        excerpt_start = match.start_character if previous_chunk_selected else match.start_with_overlap
        following_match = selected.get((match.book_number, match.chunk_number + 1))
        # The following chunk drops both its overlap and the associated label.
        reclaimed_overlap = _overlap_cost(following_match) if following_match else 0
        chunk_characters = match.end_character - match.start_character
        chunk_characters += len(_chunk_heading(match.chunk_number)) + len(CHUNK_TEXT_LABEL)
        if not previous_chunk_selected:
            chunk_characters += _overlap_cost(match)

        book_characters = 0
        if match.book_number not in selected_books:
            book_characters = len(_book_heading(match.book_number, match.book_name)) + len(PASSAGE_SEPARATOR)
        separator_characters = len(PASSAGE_SEPARATOR) if selected else 0
        added_characters = book_characters + chunk_characters - reclaimed_overlap + separator_characters
        if added_characters > remaining_characters:
            skipped_count += 1
            if len(skipped) < SKIPPED_PASSAGE_LIMIT:
                skipped.append((match, excerpt_start))
            continue
        selected[match.book_number, match.chunk_number] = match
        selected_books.add(match.book_number)
        remaining_characters -= added_characters

    def read_match(match, start, included):
        excerpt, = db.execute("""
            SELECT substr(working, ?, ?) FROM books WHERE id = ?
        """, (start + 1, match.end_character - start, match.book_id)).fetchone()
        overlap_characters = match.start_character - start
        return dict(
            book=match.book_number, chunk=match.chunk_number, name=match.book_name,
            similarity=match.similarity, text=excerpt[overlap_characters:],
            preceding=excerpt[:overlap_characters], included=included,
        )

    included = [
        read_match(match, match.start_character if (book, chunk - 1) in selected else match.start_with_overlap, True)
        for (book, chunk), match in sorted(selected.items())
    ]
    return included, [read_match(match, start, False) for match, start in skipped], below_minimum, skipped_count - len(skipped)
