"""Local shared settings and saved chat profiles."""

import json
from math import isfinite
from uuid import uuid4

from .provider_keys import KeyConflict, required_text

HYDROGEN = "gemini-4-hydrogen"
CHAT_MODELS = [{
    "id": HYDROGEN, "provider": "gemini", "provider_name": "Google Gemini",
    "thinking_levels": ["LOW", "MEDIUM", "HIGH", "XHIGH"], "default_thinking_level": "HIGH",
    "thought_signatures": True, "max_output": 65536, "context_limit": 1048576,
}]
WRAPPERS = {name: [f"<{name}>", f"</{name}>"]
            for name in ("world_info", "retrieved_passages", "chat_history")}
DEFAULTS = {
    "model": HYDROGEN, "thinking_level": "HIGH", "output_limit": 65536,
    "thought_signatures": True, "retrieved_chunks": 10, "minimum_similarity": .15,
    "chunk_overlap": 400, "messages_to_embed": 2, "wrappers": WRAPPERS,
}
SETTINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    configuration TEXT NOT NULL,
    chat_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS tale_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    configuration TEXT NOT NULL,
    chat_key_id TEXT REFERENCES provider_keys ON DELETE SET NULL,
    profile_id TEXT REFERENCES chat_profiles ON DELETE SET NULL
);
"""


def active_settings(db):
    row = db.execute("SELECT * FROM tale_settings WHERE id = 1").fetchone()
    if row is None:
        return {**DEFAULTS, "chat_key_id": None, "profile_id": None}
    return {**DEFAULTS, **json.loads(row["configuration"]), "chat_key_id": row["chat_key_id"],
            "profile_id": row["profile_id"]}


def settings_view(db):
    return {
        "settings": active_settings(db),
        "profiles": [dict(row) for row in db.execute("SELECT id, name FROM chat_profiles ORDER BY rowid")],
        "models": CHAT_MODELS, "wrapper_defaults": WRAPPERS,
    }


def save_settings(db, settings):
    configuration = {field: settings[field] for field in DEFAULTS}
    db.execute("""
        INSERT INTO tale_settings (id, configuration, chat_key_id, profile_id) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET configuration = excluded.configuration,
        chat_key_id = excluded.chat_key_id, profile_id = excluded.profile_id
    """, (json.dumps(configuration), settings["chat_key_id"], settings["profile_id"]))


def update_settings(db, changes):
    if changes.keys() - (DEFAULTS.keys() | {"chat_key_id"}):
        raise ValueError("Unknown Tale setting.")
    current = active_settings(db)
    updated = {**current, **changes}
    model = next((model for model in CHAT_MODELS if model["id"] == updated["model"]), None)
    if model is None:
        raise ValueError("Choose a supported Chat Model.")
    if updated["model"] != current["model"]:
        updated.update(thinking_level=model["default_thinking_level"], output_limit=model["max_output"])
    if updated["thinking_level"] not in model["thinking_levels"]:
        raise ValueError("Choose a supported Thinking Level.")
    output = updated["output_limit"]
    if type(output) is not int:
        raise ValueError("Enter a whole number for Output Limit.")
    updated["output_limit"] = min(model["max_output"], max(256, output))

    key = updated["chat_key_id"]
    if key is not None and (not isinstance(key, str) or not db.execute(
        "SELECT 1 FROM provider_keys WHERE id = ? AND provider = ?", (key, model["provider"])
    ).fetchone()):
        if "chat_key_id" in changes:
            raise KeyConflict("Choose a compatible Chat Key in Tale Settings.")
        updated["chat_key_id"] = None
    if updated["model"] != current["model"] and updated["chat_key_id"] is None:
        first_key = db.execute("SELECT id FROM provider_keys WHERE provider = ? ORDER BY rowid LIMIT 1",
                               (model["provider"],)).fetchone()
        updated["chat_key_id"] = first_key["id"] if first_key else None

    for field, minimum in (("retrieved_chunks", 1), ("chunk_overlap", 0), ("messages_to_embed", 1)):
        if type(updated[field]) is not int or updated[field] < minimum:
            raise ValueError(f"Enter a whole number of at least {minimum} for {field.replace('_', ' ')}.")
    similarity = updated["minimum_similarity"]
    if type(similarity) not in (int, float) or not 0 <= similarity <= 1 or not isfinite(similarity):
        raise ValueError("Minimum Similarity must be between 0 and 1.")
    if type(updated["thought_signatures"]) is not bool:
        raise ValueError("Thought signatures must be on or off.")
    wrappers = updated["wrappers"]
    if not isinstance(wrappers, dict) or wrappers.keys() != WRAPPERS.keys() or any(
        not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(text, str) for text in pair)
        for pair in wrappers.values()
    ):
        raise ValueError("Enter a prefix and suffix for each of the three wrappers.")
    save_settings(db, updated)


def edit_profile(db, action, fields):
    settings = active_settings(db)
    profile_id = fields.get("id")
    if action == "create":
        name = required_text(fields.get("name"), "Enter a profile name.")
        profile_id = uuid4().hex
        db.execute("INSERT INTO chat_profiles VALUES (?, ?, ?, ?)", (
            profile_id, name, json.dumps({field: settings[field] for field in DEFAULTS}), settings["chat_key_id"],
        ))
        save_settings(db, {**settings, "profile_id": profile_id})
        return

    profile = None
    if isinstance(profile_id, str):
        profile = db.execute("SELECT * FROM chat_profiles WHERE id = ?", (profile_id,)).fetchone()
    if action == "select" and profile_id is None:
        save_settings(db, {**settings, "profile_id": None})
    elif profile is None:
        raise KeyConflict("This chat profile no longer exists.")
    elif action == "select":
        save_settings(db, {**DEFAULTS, **json.loads(profile["configuration"]),
                            "chat_key_id": profile["chat_key_id"], "profile_id": profile_id})
    elif action == "save":
        db.execute("UPDATE chat_profiles SET configuration = ?, chat_key_id = ? WHERE id = ?", (
            json.dumps({field: settings[field] for field in DEFAULTS}), settings["chat_key_id"], profile_id,
        ))
    elif action == "rename":
        name = required_text(fields.get("name"), "Enter a profile name.")
        db.execute("UPDATE chat_profiles SET name = ? WHERE id = ?", (name, profile_id))
    elif action == "delete":
        db.execute("DELETE FROM chat_profiles WHERE id = ?", (profile_id,))
