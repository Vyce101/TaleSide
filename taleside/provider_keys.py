"""Manage local keys and their World assignments in the same database."""

from collections import Counter
from uuid import uuid4

from . import key_protection
from .embeddings import MODEL, PROVIDER, EmbeddingError

KEY_SCHEMA = """
CREATE TABLE IF NOT EXISTS provider_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    nickname TEXT NOT NULL,
    protected_secret BLOB NOT NULL,
    UNIQUE (provider, nickname)
);
CREATE TABLE IF NOT EXISTS embedding_defaults (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL,
    key_id TEXT REFERENCES provider_keys ON DELETE SET NULL
);
"""


class KeyConflict(Exception):
    """A credential or its assignments changed before an action could complete."""


def required_text(value, message):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(message)
    return value.strip()


class ProviderKeys:
    def __init__(self, connect, lock):
        self.connect = connect
        self.lock = lock
        self.checking = Counter()

    @staticmethod
    def _key(db, key_id):
        return db.execute("SELECT * FROM provider_keys WHERE id = ? AND provider = ?",
                          (key_id, PROVIDER)).fetchone()

    def require(self, db, key_id, *, message="Choose a saved Google Gemini key in World Settings."):
        if not isinstance(key_id, str) or (key := self._key(db, key_id)) is None:
            raise KeyConflict(message)
        return key

    def secret(self, db, key_id):
        key = self.require(db, key_id)
        try:
            return key_protection.unprotect(key["protected_secret"])
        except (ImportError, OSError, ValueError):
            raise EmbeddingError("Could not open this API key. Replace it in App Settings.") from None

    @staticmethod
    def _protected(secret):
        secret = required_text(secret, "Enter an API key.")
        if not secret.isascii() or not secret.isprintable() or " " in secret:
            raise ValueError("Enter a Google Gemini API key without spaces or control characters.")
        try:
            return key_protection.protect(secret)
        except (ImportError, OSError):
            raise ValueError("Windows could not protect the API key.") from None

    @staticmethod
    def _summary(key):
        return {field: key[field] for field in ("id", "provider", "nickname")}

    @staticmethod
    def _assignments(db, key_id):
        return db.execute("""
            SELECT id, name, status FROM worlds WHERE key_id = ? AND status != 'draft' ORDER BY rowid
        """, (key_id,)).fetchall()

    def _busy(self, key_id, assignments):
        return bool(self.checking[key_id] or any(
            world["status"] in ("creating", "pausing") for world in assignments
        ))

    def settings(self):
        with self.lock, self.connect() as db:
            keys = []
            for key in db.execute("SELECT id, provider, nickname FROM provider_keys ORDER BY rowid"):
                summary = self._summary(key)
                summary["worlds"] = [
                    {"id": world["id"], "name": world["name"]} for world in self._assignments(db, key["id"])
                ]
                keys.append(summary)
            last = db.execute("SELECT model, key_id FROM embedding_defaults").fetchone()
            defaults = {"model": MODEL, "key_id": keys[0]["id"] if keys else None}
            if last and last["key_id"] and last["model"] == MODEL:
                defaults = dict(last)
            return {"keys": keys, "defaults": defaults}

    @staticmethod
    def remember(db, model, key_id):
        db.execute("""
            INSERT INTO embedding_defaults (id, model, key_id) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET model = excluded.model, key_id = excluded.key_id
        """, (model, key_id))

    @staticmethod
    def _check_nickname(db, nickname, key_id):
        if db.execute("""
            SELECT 1 FROM provider_keys WHERE provider = ? AND nickname = ? AND id != ?
        """, (PROVIDER, nickname, key_id)).fetchone():
            raise ValueError("A Google Gemini key already has that name.")

    def add(self, provider, nickname, secret):
        if provider != PROVIDER:
            raise ValueError("Choose Google Gemini as the provider.")
        nickname = required_text(nickname, "Enter a key name.")
        key_id = uuid4().hex
        with self.lock, self.connect() as db:
            self._check_nickname(db, nickname, key_id)
            db.execute("INSERT INTO provider_keys (id, provider, nickname, protected_secret) VALUES (?, ?, ?, ?)",
                       (key_id, provider, nickname, self._protected(secret)))
        return {"id": key_id, "provider": provider, "nickname": nickname}

    def rename(self, key_id, nickname):
        nickname = required_text(nickname, "Enter a key name.")
        with self.lock, self.connect() as db:
            self.require(db, key_id)
            self._check_nickname(db, nickname, key_id)
            db.execute("UPDATE provider_keys SET nickname = ? WHERE id = ?", (nickname, key_id))

    def replace(self, key_id, secret):
        with self.lock, self.connect() as db:
            self.require(db, key_id)
            if self._busy(key_id, self._assignments(db, key_id)):
                raise KeyConflict("Wait for book checks to finish and pause any Worlds using this key.")
            db.execute("UPDATE provider_keys SET protected_secret = ? WHERE id = ?",
                       (self._protected(secret), key_id))

    def _delete_impact(self, db, key_id):
        key = self.require(db, key_id)
        worlds = self._assignments(db, key_id)
        fallback = None
        if worlds:
            fallback = db.execute("""
                SELECT id, provider, nickname FROM provider_keys WHERE provider = ? AND id != ?
                ORDER BY rowid LIMIT 1
            """, (key["provider"], key_id)).fetchone()
        return {
            "key": self._summary(key),
            "worlds": [{"id": world["id"], "name": world["name"]} for world in worlds],
            "fallback": self._summary(fallback) if fallback else None,
            "busy": self._busy(key_id, worlds),
            "tales_use_key": any(db.execute(f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1",
                                           (key_id,)).fetchone()
                                 for table, column in (("worlds", "retrieval_key_id"),
                                                       ("tale_settings", "chat_key_id"),
                                                       ("chat_profiles", "chat_key_id"))),
        }

    def delete_impact(self, key_id):
        with self.lock, self.connect() as db:
            return self._delete_impact(db, key_id)

    def delete(self, key_id, confirmed_impact):
        with self.lock, self.connect() as db:
            impact = self._delete_impact(db, key_id)
            if impact["busy"]:
                raise KeyConflict("Wait for book checks to finish and pause any Worlds using this key.")
            if impact != confirmed_impact:
                raise KeyConflict("Key usage changed. Review the updated delete confirmation.")
            fallback = impact["fallback"]
            db.execute("UPDATE worlds SET key_id = ? WHERE key_id = ?",
                       (fallback["id"] if fallback else None, key_id))
            db.execute("DELETE FROM provider_keys WHERE id = ?", (key_id,))
