"""Assemble the Gemini conversation request from retrieved context and Tale history."""


def _wrapped(text, pair):
    return "\n".join(part for part in (pair[0], text, pair[1]) if part)


PROMPT_NAMES = {
    "world_description": "World Description",
    "world_info": "World Info",
    "persona": "Persona",
    "retrieved_passages": "Retrieved Context",
    "chat_history": "Chat History",
}


def _joined_parts(texts, separator):
    parts = []
    for text in texts:
        if parts:
            parts.append(separator)
        parts.append(text)
    return parts


def _retrieved_prompt(passage_parts, graph_notes, wrapper, include_source_legend):
    """Return the prompt text and the pieces used to deduplicate it in saved captures."""
    source_legend = "B1:C1 means Book 1, Chunk 1.\n" if include_source_legend else ""
    body_parts = list(passage_parts)
    if passage_parts and graph_notes:
        body_parts.append("\n\n")
    body_parts.extend(_joined_parts(graph_notes, "\n\n"))

    prefix, suffix = wrapper
    groups = [[prefix], body_parts, [suffix]]
    parts = [source_legend] if source_legend else []
    for index, group in enumerate(group for group in groups if any(group)):
        if index:
            parts.append("\n")
        parts.extend(group)
    text = "".join(parts)

    chunk_characters = sum(map(len, passage_parts))
    graph_characters = len("\n\n".join(graph_notes))
    wrapper_characters = len(text) - chunk_characters - graph_characters
    if passage_parts or not graph_notes:
        chunk_characters += wrapper_characters
    else:
        graph_characters += wrapper_characters
    return text, parts, chunk_characters, graph_characters


def _sent_history(message, parts, persona_name, world_name):
    sent_text = "".join(part.get("text", "") for part in parts if not part.get("thought"))
    thinking = "".join(part.get("text", "") for part in parts if part.get("thought"))
    name = (message.get("player_name") or persona_name) if message["role"] == "user" else world_name
    return dict(
        turn=message["turn"], role=message["role"], name=name,
        model=message["model"], text=sent_text, thinking=thinking,
        has_thinking=bool(message.get("thinking")), has_signature=bool(message.get("signed_parts")),
        signature_sent=any(part.get("thoughtSignature") for part in parts),
    )


def chat_request(world, books, passage_parts, messages, settings, context, graph, gemma, retrieval):
    wrappers = settings["wrappers"]
    world_info = [f"Name = {world['name']}", f"Chunk Size = {world['max_chunk_size']} Characters",
            f"Books = {len(books)}"]
    world_info.extend(f"Book {book['number']} - {book['name']}" for book in books)
    if graph is not None:
        world_info.extend([f"Entities = {graph['entities']}", f"Relationships = {graph['relationships']}"])
    persona = context["persona"]
    block_text = {
        "world_description": context["description"] if context["description"].strip() else "",
        "world_info": "\n".join(world_info),
        "persona": f"Name = {persona['name']}\nDescription = {persona['description']}",
    }
    system_parts = []
    contents = []
    characters_by_block = {}
    sections = []
    history = []
    retrieved_parts = []
    graph_notes = graph["notes"] if graph is not None else []
    chunk_characters = 0
    graph_characters = 0

    def append_prompt_parts(block_id, role, parts):
        characters_by_block[block_id] += sum(len(part.get("text") or "") for part in parts)
        if role == "system" and not contents:
            system_parts.extend(parts)
        elif contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})

    def text_part(text):
        return {"text": text}

    def append_history(block_id, history_role):
        prefix, suffix = wrappers["chat_history"]
        grouped_parts = []
        keep_message_roles = history_role == "multi-role"
        for index, message in enumerate(messages):
            role = "user" if message["role"] == "user" else "model"
            replay_model_thoughts = (
                keep_message_roles
                and role == "model"
                and settings["thought_signatures"]
                and message["model"] == settings["model"]
            )
            if replay_model_thoughts and gemma and message.get("thinking"):
                parts = [{"text": message["thinking"], "thought": True}, text_part(message["content"])]
            elif replay_model_thoughts and not gemma and message["signed_parts"]:
                parts = list(message["signed_parts"])
            else:
                parts = [text_part(message["content"])]
            history.append(_sent_history(message, parts, persona["name"], world["name"]))
            if index == 0 and prefix:
                parts.insert(0, text_part(prefix))
            if index == len(messages) - 1 and suffix:
                parts.append(text_part(suffix))
            if keep_message_roles:
                append_prompt_parts(block_id, role, parts)
            else:
                grouped_parts.extend(parts)
        if grouped_parts:
            append_prompt_parts(block_id, history_role, grouped_parts)

    for block in settings["prompts"]:
        block_id = block["id"]
        characters_by_block[block_id] = 0
        kind = block["kind"]
        section = dict(id=block_id, name=block.get("name") or PROMPT_NAMES.get(kind, kind), kind=kind)
        sections.append(section)
        if kind == "chat_history":
            if block["enabled"]:
                append_history(block_id, block.get("role") or "multi-role")
            else:
                latest_user = next(message for message in reversed(messages) if message["role"] == "user")
                parts = [text_part(latest_user["content"])]
                history.append(_sent_history(latest_user, parts, persona["name"], world["name"]))
                append_prompt_parts(block_id, "user", parts)
            continue

        if not block["enabled"]:
            continue
        if kind == "custom":
            if block["text"].strip():
                section["text"] = block["text"]
                append_prompt_parts(block_id, block["role"], [text_part(block["text"])])
            continue
        if kind == "world_description" and not block_text[kind]:
            continue

        if kind == "retrieved_passages":
            text, retrieved_parts, chunk_characters, graph_characters = _retrieved_prompt(
                passage_parts, graph_notes, wrappers[kind], include_source_legend=graph is not None,
            )
        else:
            text = _wrapped(block_text[kind], wrappers[kind])
            section["text"] = text
        append_prompt_parts(block_id, block.get("role") or "system", [text_part(text)])

    payload = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": settings["output_limit"],
            "thinkingConfig": {"thinkingLevel": settings["thinking_level"], "includeThoughts": True},
        },
    }
    if system_parts:
        payload["systemInstruction"] = {"parts": system_parts}
    prompt_counts = {"total": sum(characters_by_block.values()), "blocks": characters_by_block}
    for section in sections:
        section["characters"] = characters_by_block[section["id"]]
    trace = dict(retrieval, sections=sections, history=history, retrieved_parts=retrieved_parts,
                 graph_characters=graph_characters, chunk_characters=chunk_characters,
                 minimum_similarity=settings["minimum_similarity"])
    return {"payload": payload, "prompt_counts": prompt_counts, "trace": trace}
