"""Read the saved World vectors and assemble the Gemini conversation request."""

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


def wrapped(text, pair):
    return "\n".join(part for part in (pair[0], text, pair[1]) if part)


def chat_request(world, books, excerpts, messages, settings, context, gemma):
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
            replay = history_role == "multi-role" and role == "model" and settings["thought_signatures"] and message["model"] == settings["model"]
            if replay and gemma and message.get("thinking"):
                parts = [{"text": message["thinking"], "thought": True}, text_part(message["content"])]
            elif replay and not gemma and message["signed_parts"]:
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
