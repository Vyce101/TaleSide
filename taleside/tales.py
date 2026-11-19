"""Store Tales, their ordered messages, and active generations."""

from time import time
from uuid import uuid4

from .embeddings import MODEL
from .gemini_tales import GeminiTale
from .provider_keys import KeyConflict, required_text
from .tale_settings import SETTINGS_SCHEMA, edit_profile, settings_view, update_settings

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

    def set_retrieval_key(self, world_id, key_id):
        with self.worlds.lock, self.worlds.connect() as db:
            world = saved_world(db, world_id)
            if world["status"] in ("creating", "pausing"):
                raise KeyConflict("Wait for World creation to pause or finish.")
            if world["model"] != MODEL:
                raise KeyConflict("This World's embedding model is unavailable.")
            self.worlds.keys.require(db, key_id, message="Choose a compatible Retrieval Key.")
            db.execute("UPDATE worlds SET retrieval_key_id = ? WHERE id = ?", (key_id, world_id))

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
            if world["status"] != "ready":
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

    def cancel_locked(self, tale_id):
        generation = self.active.get(tale_id)
        if generation:
            generation.cancel()

