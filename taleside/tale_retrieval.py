"""Read the saved World vectors and assemble the Gemini conversation request."""

from heapq import nlargest
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


def chat_request(world, books, excerpts, messages, settings, context):
    wrappers = settings["wrappers"]
    info = [f"Name = {world['name']}", f"Chunk Size = {world['max_chunk_size']} Characters",
            f"Books = {len(books)}"]
    info.extend(f"Book {book['number']} - {book['name']}" for book in books)
    persona = context["persona"]
    blocks = {
        "world_description": context["description"] if context["description"].strip() else "",
        "world_info": "\n".join(info),
        "persona": f"Name = {persona['name']}\nDescription = {persona['description']}",
        "retrieved_passages": "\n\n".join(excerpts),
    }
    system = []
    contents = []
    counts = {}

    def append(role, parts):
        counts[block_id] += sum(len(part.get("text") or "") for part in parts)
        if role == "system" and not contents:
            system.extend(parts)
        elif contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})

    def text_part(text):
        return {"text": text}

    def history(history_role):
        prefix, suffix = wrappers["chat_history"]
        grouped = []
        for index, message in enumerate(messages):
            role = "user" if message["role"] == "user" else "model"
            if history_role == "multi-role" and settings["thought_signatures"] and message["model"] == settings["model"] and message["signed_parts"]:
                parts = list(message["signed_parts"])
            else:
                parts = [text_part(message["content"])]
            if index == 0 and prefix:
                parts.insert(0, text_part(prefix))
            if index == len(messages) - 1 and suffix:
                parts.append(text_part(suffix))
            if history_role == "multi-role":
                append(role, parts)
            else:
                grouped.extend(parts)
        if grouped:
            append(history_role, grouped)

    for block in settings["prompts"]:
        block_id = block["id"]
        counts[block_id] = 0
        kind = block["kind"]
        if kind == "chat_history":
            if block["enabled"]:
                history(block.get("role") or "multi-role")
            else:
                append("user", [text_part(next(message["content"] for message in reversed(messages) if message["role"] == "user"))])
        elif block["enabled"]:
            if kind == "custom":
                if block["text"].strip():
                    append(block["role"], [text_part(block["text"])])
            elif kind != "world_description" or blocks[kind]:
                append(block.get("role") or "system", [text_part(wrapped(blocks[kind], wrappers[kind]))])
    payload = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": settings["output_limit"],
            "thinkingConfig": {"thinkingLevel": settings["thinking_level"], "includeThoughts": True},
        },
    }
    if system:
        payload["systemInstruction"] = {"parts": system}
    return {"payload": payload, "prompt_counts": {"total": sum(counts.values()), "blocks": counts}}
