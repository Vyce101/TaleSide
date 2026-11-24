"""Rank and read relevant passages from the saved World."""

from math import sqrt
from struct import Struct

def valid_vector(values, dimensions):
    return (
        isinstance(values, list)
        and len(values) == dimensions
        and all(
            type(value) in (int, float) and -3.4028234663852886e38 <= value <= 3.4028234663852886e38
            for value in values
        )
        and any(values)
    )


def passages(db, world, query, settings, cancelled):
    dimensions = world["dimensions"]
    if not valid_vector(query, dimensions):
        raise ValueError("Gemini returned an invalid retrieval vector.")
    vector_format = Struct(f"<{dimensions}f")
    query_length = sqrt(sum(value * value for value in query))
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
            length = sqrt(sum(value * value for value in vector))
            if not length:
                continue
            similarity = sum(left * right for left, right in zip(vector, query)) / (length * query_length)
            if similarity >= settings["minimum_similarity"]:
                start = chunk["start"]
                overlap_start = start
                if chunk["prior_start"] is not None:
                    overlap_start = max(chunk["prior_start"], start - settings["chunk_overlap"])
                yield similarity, (chunk["book_number"], chunk["number"], chunk["book_id"], start, chunk["end"], overlap_start)

    ranked = sorted(matches(), key=lambda match: (-match[0], match[1][0], match[1][1]))
    selected = {}
    remaining = settings["chunk_budget"]
    for _, (book, number, book_id, start, end, overlap_start) in ranked:
        excerpt_start = start if (book, number - 1) in selected else overlap_start
        next_chunk = selected.get((book, number + 1))
        saved_overlap = end - next_chunk[2] if next_chunk else 0
        cost = end - excerpt_start - saved_overlap + (2 if selected else 0)
        if cost > remaining:
            continue
        selected[(book, number)] = (book_id, start, overlap_start, end)
        remaining -= cost

    excerpts = []
    for (book, number), (book_id, start, overlap_start, end) in sorted(selected.items()):
        excerpt_start = start if (book, number - 1) in selected else overlap_start
        text, = db.execute("""
            SELECT substr(working, ?, ?) FROM books WHERE id = ?
        """, (excerpt_start + 1, end - excerpt_start, book_id)).fetchone()
        excerpts.append(text)
    return excerpts
