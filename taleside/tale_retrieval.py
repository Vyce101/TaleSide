"""Rank and read relevant passages from the saved World."""

from math import sqrt
from struct import Struct
from typing import NamedTuple


FLOAT32_MAX = 3.4028234663852886e38
PASSAGE_SEPARATOR_CHARACTERS = 2


class PassageMatch(NamedTuple):
    similarity: float
    book_number: int
    chunk_number: int
    book_id: str
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


def passages(db, world, query, settings, cancelled):
    dimensions = world["dimensions"]
    if not _valid_vector(query, dimensions):
        raise ValueError("Gemini returned an invalid retrieval vector.")
    vector_format = Struct(f"<{dimensions}f")
    query_length = sqrt(sum(value * value for value in query))
    minimum_similarity = settings["minimum_similarity"]
    overlap_characters = settings["chunk_overlap"]
    chunks = db.execute("""
        SELECT b.number AS book_number, c.book_id, c.number, c.start, c.end, c.vector,
            prior.start AS prior_start
        FROM chunks c JOIN books b ON b.id = c.book_id
        LEFT JOIN chunks prior ON prior.book_id = c.book_id AND prior.index_number = c.index_number AND prior.number = c.number - 1
        WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL
    """, (world["id"], world["index_number"]))

    def matches():
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
                continue

            start_character = chunk["start"]
            start_with_overlap = start_character
            if chunk["prior_start"] is not None:
                start_with_overlap = max(chunk["prior_start"], start_character - overlap_characters)
            yield PassageMatch(
                similarity, chunk["book_number"], chunk["number"], chunk["book_id"],
                start_character, chunk["end"], start_with_overlap,
            )

    ranked = sorted(matches(), key=lambda match: (-match.similarity, match.book_number, match.chunk_number))
    selected = {}
    remaining_characters = settings["chunk_budget"]
    for match in ranked:
        previous_chunk_selected = (match.book_number, match.chunk_number - 1) in selected
        excerpt_start = match.start_character if previous_chunk_selected else match.start_with_overlap
        following_match = selected.get((match.book_number, match.chunk_number + 1))
        # Adding this chunk removes the overlap already budgeted for its following chunk.
        reclaimed_overlap = match.end_character - following_match.start_with_overlap if following_match else 0
        separator_characters = PASSAGE_SEPARATOR_CHARACTERS if selected else 0
        excerpt_characters = match.end_character - excerpt_start
        added_characters = excerpt_characters - reclaimed_overlap + separator_characters
        if added_characters > remaining_characters:
            continue
        selected[match.book_number, match.chunk_number] = match
        remaining_characters -= added_characters

    excerpts = []
    for (book_number, chunk_number), match in sorted(selected.items()):
        previous_chunk_selected = (book_number, chunk_number - 1) in selected
        excerpt_start = match.start_character if previous_chunk_selected else match.start_with_overlap
        excerpt_characters = match.end_character - excerpt_start
        text, = db.execute("""
            SELECT substr(working, ?, ?) FROM books WHERE id = ?
        """, (excerpt_start + 1, excerpt_characters, match.book_id)).fetchone()
        excerpts.append(text)
    return excerpts
