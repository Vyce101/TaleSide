"""Assemble the Gemini conversation request from retrieved context and Tale history."""


def _wrapped(text, pair):
    return "\n".join(part for part in (pair[0], text, pair[1]) if part)


def chat_request(world, books, excerpts, messages, settings, context, graph, gemma):
    wrappers = settings["wrappers"]
    world_info = [f"Name = {world['name']}", f"Chunk Size = {world['max_chunk_size']} Characters",
            f"Books = {len(books)}"]
    world_info.extend(f"Book {book['number']} - {book['name']}" for book in books)
    if graph is not None:
        world_info.extend([f"Entities = {graph['entities']}", f"Relationships = {graph['relationships']}"])
    retrieved_context = "\n\n".join(excerpts + (graph["notes"] if graph is not None else []))
    persona = context["persona"]
    block_text = {
        "world_description": context["description"] if context["description"].strip() else "",
        "world_info": "\n".join(world_info),
        "persona": f"Name = {persona['name']}\nDescription = {persona['description']}",
        "retrieved_passages": retrieved_context,
    }
    system_parts = []
    contents = []
    characters_by_block = {}

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
        if kind == "chat_history":
            if block["enabled"]:
                append_history(block_id, block.get("role") or "multi-role")
            else:
                latest_user_text = next(message["content"] for message in reversed(messages) if message["role"] == "user")
                append_prompt_parts(block_id, "user", [text_part(latest_user_text)])
            continue

        if not block["enabled"]:
            continue
        if kind == "custom":
            if block["text"].strip():
                append_prompt_parts(block_id, block["role"], [text_part(block["text"])])
            continue
        if kind == "world_description" and not block_text[kind]:
            continue

        text = _wrapped(block_text[kind], wrappers[kind])
        if kind == "retrieved_passages" and graph is not None:
            text = "B1:C1 means Book 1, Chunk 1.\n" + text
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
    return {"payload": payload, "prompt_counts": prompt_counts}
