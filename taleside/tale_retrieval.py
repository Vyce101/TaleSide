"""Read the saved World vectors and assemble the Gemini conversation request."""

from heapq import nlargest
from math import sqrt
from struct import Struct

from .embeddings import MODELS, EmbeddingError, valid_vector


def retrieval_index(db, world):
    index_number = world["previous_index"] or world["index_number"]
    if not db.execute("""
        SELECT 1 FROM books b JOIN chunks c ON c.book_id = b.id
        WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL LIMIT 1
    """, (world["id"], index_number)).fetchone():
        return None
    index = dict(world)
    if world["previous_index"] is not None:
        index.update(index_number=index_number, model=world["previous_model"],
                     dimensions=world["previous_dimensions"], max_token_limit=world["previous_token_limit"],
                     max_chunk_size=world["previous_chunk_size"])
    return index if index["model"] in MODELS else None


def query_text(messages):
    return "task: search result | query: " + "\n\n".join(message["content"] for message in messages)


def passages(db, world, query, settings, cancelled):
    dimensions = world["dimensions"]
    if not valid_vector(query, dimensions):
        raise EmbeddingError("Gemini returned an invalid retrieval vector.")
    vector_format = Struct(f"<{dimensions}f")
    query_length = sqrt(sum(value * value for value in query))
    chunks = db.execute("""
        SELECT b.number AS book_number, c.book_id, c.number, c.start, c.end, c.vector
        FROM chunks c JOIN books b ON b.id = c.book_id
        WHERE b.world_id = ? AND c.index_number = ? AND c.vector IS NOT NULL ORDER BY b.number, c.number
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
                yield similarity, chunk

    selected = nlargest(settings["retrieved_chunks"], matches(), key=lambda match: match[0])
    ordered = sorted((chunk for _, chunk in selected), key=lambda chunk: (chunk["book_number"], chunk["start"]))
    excerpts = []
    covered_end = 0
    previous_book = None
    for chunk in ordered:
        book = chunk["book_number"]
        if book != previous_book:
            covered_end = 0
            previous_book = book
        start = chunk["start"]
        if settings["chunk_overlap"] and chunk["number"] > 1:
            prior = db.execute("""
                SELECT start FROM chunks WHERE book_id = ? AND index_number = ? AND number = ?
            """, (chunk["book_id"], world["index_number"], chunk["number"] - 1)).fetchone()
            if prior:
                start = max(prior["start"], start - settings["chunk_overlap"], covered_end)
        text, = db.execute("""
            SELECT substr(working, ?, ?) FROM books WHERE id = ?
        """, (start + 1, chunk["end"] - start, chunk["book_id"])).fetchone()
        excerpts.append(text)
        covered_end = chunk["end"]
    return excerpts


def wrapped(text, pair):
    return "\n".join(part for part in (pair[0], text, pair[1]) if part)


def chat_request(world, books, excerpts, messages, settings):
    wrappers = settings["wrappers"]
    info = [f"Name = {world['name']}", f"Chunk Size = {world['max_chunk_size']} Characters",
            f"Books = {len(books)}"]
    info.extend(f"Book {book['number']} - {book['name']}" for book in books)
    system = "\n\n".join((wrapped("\n".join(info), wrappers["world_info"]),
                          wrapped("\n\n".join(excerpts), wrappers["retrieved_passages"])))
    prefix, suffix = wrappers["chat_history"]
    contents = []
    for index, message in enumerate(messages):
        text = message["content"]
        if message["role"] == "user":
            text = wrapped(text, (prefix if index == 0 else "", suffix if index == len(messages) - 1 else ""))
            parts = [{"text": text}]
            role = "user"
        else:
            role = "model"
            parts = [{"text": text}]
            if settings["thought_signatures"] and message["model"] == settings["model"] and message["signed_parts"]:
                parts = message["signed_parts"]
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": settings["output_limit"],
            "thinkingConfig": {"thinkingLevel": settings["thinking_level"], "includeThoughts": True},
        },
    }
