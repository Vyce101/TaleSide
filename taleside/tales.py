"""Store Tales, their ordered messages, and active generations."""

import json
import sqlite3
from contextlib import closing
from time import time
from uuid import uuid4

from .embeddings import MODEL, EmbeddingError
from .gemini_tales import GeminiTale, Generation, GenerationCancelled, InputTooLarge
from .provider_keys import KeyConflict, required_text, save_key_selection, selected_keys
from .tale_retrieval import chat_request, passages, query_text, retrieval_index
from .tale_settings import SETTINGS_SCHEMA, active_settings, edit_profile, settings_view, update_settings

TALE_SCHEMA = SETTINGS_SCHEMA + """
CREATE TABLE IF NOT EXISTS tales (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds ON DELETE CASCADE,
    title TEXT NOT NULL,
    automatic_title INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_activity_at REAL
);
CREATE INDEX IF NOT EXISTS tales_world ON tales (world_id);
CREATE TABLE IF NOT EXISTS tale_messages (
    id INTEGER PRIMARY KEY,
    tale_id TEXT NOT NULL REFERENCES tales ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT NOT NULL DEFAULT '',
    model TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    signed_parts TEXT
);
CREATE INDEX IF NOT EXISTS messages_tale ON tale_messages (tale_id, id);
"""


class TaleNotFound(Exception):
    pass


class MissingTaleKey(KeyConflict):
    def __init__(self, field):
        super().__init__(f"Choose a {field} in Tale Settings.")
        self.field = field


def saved_world(db, world_id):
    world = db.execute("SELECT * FROM worlds WHERE id = ? AND status != 'draft'", (world_id,)).fetchone()
    if world is None:
        raise TaleNotFound("This World could not be found.")
    return world


def saved_tale(db, world_id, tale_id):
    tale = db.execute("SELECT * FROM tales WHERE world_id = ? AND id = ?", (world_id, tale_id)).fetchone()
    if tale is None:
        raise TaleNotFound("This Tale could not be found.")
    return dict(tale)


def activity(db, world_id, timestamp):
    db.execute("UPDATE worlds SET last_tale_activity_at = ? WHERE id = ?", (timestamp, world_id))


class Tales:
    def __init__(self, worlds, provider=GeminiTale):
        self.worlds = worlds
        self.provider = provider
        self.active = {}

    def settings(self, changes=None, profile_action=None):
        with self.worlds.lock, self.worlds.connect() as db:
            if profile_action is not None:
                edit_profile(db, profile_action, changes)
            elif changes is not None:
                update_settings(db, changes)
            return settings_view(db)

    def set_retrieval_keys(self, world_id, key_ids):
        with self.worlds.lock, self.worlds.connect() as db:
            world = saved_world(db, world_id)
            if world["model"] != MODEL:
                raise KeyConflict("This World's embedding model is unavailable.")
            self.worlds.keys.validate_selection(db, key_ids, "Choose compatible Retrieval Keys.")
            save_key_selection(db, "world_retrieval_keys", world_id, key_ids)

    def list(self, world_id):
        with self.worlds.lock, self.worlds.connect() as db:
            saved_world(db, world_id)
            rows = db.execute("""
                SELECT t.id, t.title, t.pinned, t.created_at, t.last_activity_at,
                       (SELECT count(*) FROM tale_messages WHERE tale_id = t.id) AS message_count,
                       m.role, m.content, m.thinking != '' AS has_thinking, m.status
                FROM tales t LEFT JOIN tale_messages m ON m.id = (
                    SELECT id FROM tale_messages WHERE tale_id = t.id ORDER BY id DESC LIMIT 1
                )
                WHERE t.world_id = ? ORDER BY t.pinned DESC, coalesce(t.last_activity_at, t.created_at) DESC, t.rowid DESC
            """, (world_id,))
            tales = []
            for row in rows:
                tale = dict(row)
                generation = self.active.get(tale["id"])
                if generation and tale["status"] == "generating":
                    tale.update(content=generation.reply, has_thinking=bool(generation.thinking))
                tale["content"] = (tale["content"] or "")[:400]
                tales.append(tale)
            return tales

    def detail(self, world_id, tale_id):
        with self.worlds.lock, self.worlds.connect() as db:
            tale = saved_tale(db, world_id, tale_id)
            messages = [dict(row) for row in db.execute("""
                SELECT id, role, content, thinking, model, status FROM tale_messages WHERE tale_id = ? ORDER BY id
            """, (tale_id,))]
            generation = self.active.get(tale_id)
            if generation and messages and messages[-1]["status"] == "generating":
                messages[-1].update(content=generation.reply, thinking=generation.thinking)
            tale["messages"] = messages
            return tale

    def create(self, world_id, *, resume=False):
        with self.worlds.lock, self.worlds.connect() as db:
            world = saved_world(db, world_id)
            if retrieval_index(db, world) is None:
                raise KeyConflict("This World is still being prepared.")
            if resume:
                latest = db.execute("""
                    SELECT id FROM tales WHERE world_id = ?
                    ORDER BY coalesce(last_activity_at, created_at) DESC, rowid DESC LIMIT 1
                """, (world_id,)).fetchone()
                if latest:
                    return {"id": latest["id"]}
            titles = {row[0] for row in db.execute("SELECT title FROM tales WHERE world_id = ?", (world_id,))}
            title = "Untitled Tale"
            number = 2
            while title in titles:
                title = f"Untitled Tale {number}"
                number += 1
            tale_id, now = uuid4().hex, time()
            db.execute("INSERT INTO tales (id, world_id, title, created_at) VALUES (?, ?, ?, ?)",
                       (tale_id, world_id, title, now))
            activity(db, world_id, now)
            return {"id": tale_id}

    def change(self, world_id, tale_id, action, fields):
        with self.worlds.lock, self.worlds.connect() as db:
            saved_tale(db, world_id, tale_id)
            if action == "rename":
                title = required_text(fields.get("title"), "Enter a Tale title.")
                db.execute("UPDATE tales SET title = ?, automatic_title = 0 WHERE id = ?", (title, tale_id))
            elif action == "pin":
                pinned = fields.get("pinned")
                if type(pinned) is not bool:
                    raise ValueError("Pinning requires true or false.")
                db.execute("UPDATE tales SET pinned = ? WHERE id = ?", (pinned, tale_id))
            elif action == "delete":
                self.cancel_locked(tale_id)
                db.execute("DELETE FROM tales WHERE id = ?", (tale_id,))
            elif action == "stop":
                generation = self.active.get(tale_id)
                if generation and generation.id == fields.get("generation_id"):
                    generation.cancel(user_stopped=fields.get("user_stopped") is True)

    def cancel_locked(self, tale_id):
        generation = self.active.get(tale_id)
        if generation:
            generation.cancel()

    def begin(self, world_id, tale_id, content, generation_id):
        content = required_text(content, "Enter a message.")
        with self.worlds.lock, self.worlds.connect() as db:
            world = retrieval_index(db, saved_world(db, world_id))
            tale = saved_tale(db, world_id, tale_id)
            if tale_id in self.active:
                raise KeyConflict("This Tale is already generating.")
            if world is None:
                raise KeyConflict("This World's embeddings are unavailable.")
            settings = active_settings(db)
            retrieval_key_ids = selected_keys(db, "world_retrieval_keys", world_id)
            if not retrieval_key_ids:
                raise MissingTaleKey("Retrieval Key")
            if not settings["chat_key_ids"]:
                raise MissingTaleKey("Chat Key")
            history = []
            for row in db.execute("""
                SELECT role, content, model, signed_parts FROM tale_messages
                WHERE tale_id = ? AND content != '' ORDER BY id
            """, (tale_id,)):
                message = dict(row)
                message["signed_parts"] = json.loads(message["signed_parts"] or "null")
                history.append(message)
            books = db.execute("SELECT number, name FROM books WHERE world_id = ? ORDER BY number", (world_id,)).fetchall()
            if tale["automatic_title"] and not history:
                title = " ".join(content.split())
                if len(title) > 60:
                    title = title[:59].rstrip() + "…"
                db.execute("UPDATE tales SET title = ?, automatic_title = 0 WHERE id = ?", (title, tale_id))
            now = time()
            db.execute("UPDATE tales SET last_activity_at = ? WHERE id = ?", (now, tale_id))
            activity(db, world_id, now)
            db.execute("INSERT INTO tale_messages (tale_id, role, content) VALUES (?, 'user', ?)", (tale_id, content))
            assistant = db.execute("""
                INSERT INTO tale_messages (tale_id, role, model, status) VALUES (?, 'assistant', ?, 'generating')
            """, (tale_id, settings["model"])).lastrowid
            snapshot = self.worlds.retrieval_snapshot()
            try:
                db.commit()
            except sqlite3.Error:
                snapshot.close()
                raise
            generation = self.active[tale_id] = Generation(world_id, generation_id)
        history.append({"role": "user", "content": content})
        return generation, assistant, world, books, settings, history, retrieval_key_ids, snapshot

    def generate(self, tale_id, prepared, emit):
        generation, assistant, world, books, settings, history, retrieval_key_ids, snapshot = prepared
        status = "error"
        signed_parts = []

        def next_key(purpose, key_ids):
            with self.worlds.lock, self.worlds.connect() as db:
                generation.check()
                return self.worlds.keys.next_secret(db, purpose, key_ids)

        try:
            with closing(snapshot) as db:
                provider = self.provider(generation)
                query = self.embed(provider, world, lambda: next_key("retrieval", retrieval_key_ids),
                                   history[-settings["messages_to_embed"]:])
                generation.check()
                excerpts = passages(db, world, query, settings, generation.cancelled)
            generation.check()
            body = chat_request(world, books, excerpts, history, settings)
            chat_key = next_key("chat", settings["chat_key_ids"])
            for part in provider.chat(settings["model"], chat_key, body):
                generation.check()
                value = part.get("text", "")
                thought = part.get("thought") is True
                if isinstance(value, str) and value:
                    field = "thinking" if thought else "reply"
                    setattr(generation, field, getattr(generation, field) + value)
                    emit({"type": field, "text": value})
                if not thought and settings["thought_signatures"] and isinstance(value, str):
                    signature = part.get("thoughtSignature")
                    if isinstance(signature, str) and signature:
                        signed_parts.append({"text": value, "thoughtSignature": signature})
                    elif value:
                        if signed_parts and "thoughtSignature" not in signed_parts[-1]:
                            signed_parts[-1]["text"] += value
                        else:
                            signed_parts.append({"text": value})
            status = "complete"
        except GenerationCancelled:
            pass
        except (EmbeddingError, KeyConflict, KeyError, TypeError, ValueError, sqlite3.Error):
            status = "error"
        finally:
            if not any("thoughtSignature" in part for part in signed_parts):
                signed_parts = None
            try:
                with self.worlds.lock:
                    try:
                        with self.worlds.connect() as db:
                            if generation.cancelled.is_set():
                                status = "stopped" if generation.user_stopped else "error"
                            db.execute("""
                                UPDATE tale_messages SET content = ?, thinking = ?, status = ?, signed_parts = ?
                                WHERE id = ? AND tale_id = ?
                            """, (generation.reply, generation.thinking, status,
                                  json.dumps(signed_parts) if signed_parts else None, assistant, tale_id))
                    finally:
                        self.active.pop(tale_id, None)
            finally:
                emit({"type": "done", "status": status})

    @staticmethod
    def embed(provider, world, next_key, messages):
        while True:
            try:
                return provider.embed(world, next_key(), query_text(messages))
            except InputTooLarge:
                if len(messages) == 1:
                    raise
                messages = messages[1:]
                while len(messages) > 1:
                    try:
                        count = provider.count(world["model"], next_key(), {
                            "contents": [{"parts": [{"text": query_text(messages)}]}],
                        })
                        if count <= world["max_token_limit"]:
                            break
                    except InputTooLarge:
                        pass
                    messages = messages[1:]
