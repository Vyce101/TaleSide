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

SELECTION_OWNERS = (
    ("world_embedding_keys", "worlds", "TEXT", "key_id"),
    ("world_retrieval_keys", "worlds", "TEXT", "retrieval_key_id"),
    ("embedding_default_keys", "embedding_defaults", "INTEGER", "key_id"),
    ("tale_chat_keys", "tale_settings", "INTEGER", "chat_key_id"),
    ("chat_profile_keys", "chat_profiles", "TEXT", "chat_key_id"),
)
SELECTION_SCHEMA = "".join(f"""
CREATE TABLE IF NOT EXISTS {table} (
    owner_id {owner_type} NOT NULL REFERENCES {owner_table} ON DELETE CASCADE,
    key_id TEXT NOT NULL REFERENCES provider_keys ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (owner_id, key_id),
    UNIQUE (owner_id, position)
);
""" for table, owner_table, owner_type, _ in SELECTION_OWNERS)


def migrate_key_selections(db):
    if db.execute("PRAGMA user_version").fetchone()[0] >= 1:
        return
    for table, owner_table, _, old_column in SELECTION_OWNERS:
        db.execute(f"""
            INSERT INTO {table} (owner_id, key_id, position)
            SELECT id, {old_column}, 0 FROM {owner_table} WHERE {old_column} IS NOT NULL
        """)
    db.execute("PRAGMA user_version = 1")


def selected_keys(db, table, owner_id):
    return [row["key_id"] for row in db.execute(
        f"SELECT key_id FROM {table} WHERE owner_id = ? ORDER BY position", (owner_id,)
    )]


def save_key_selection(db, table, owner_id, key_ids):
    db.execute(f"DELETE FROM {table} WHERE owner_id = ?", (owner_id,))
    db.executemany(f"INSERT INTO {table} (owner_id, key_id, position) VALUES (?, ?, ?)",
                   ((owner_id, key_id, position) for position, key_id in enumerate(key_ids)))


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
        self.next_position = {}

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
    def validate_selection(db, key_ids, message, *, provider=PROVIDER, required=False):
        if not isinstance(key_ids, list) or any(not isinstance(key_id, str) for key_id in key_ids):
            raise ValueError("Provide a list of saved key IDs.")
        if len(set(key_ids)) != len(key_ids):
            raise ValueError("Select each key only once.")
        if required and not key_ids:
            raise KeyConflict(message)
        for key_id in key_ids:
            if db.execute("SELECT 1 FROM provider_keys WHERE id = ? AND provider = ?",
                          (key_id, provider)).fetchone() is None:
                raise KeyConflict(message)

    def next_secret(self, db, purpose, key_ids):
        # Advance before opening the credential so a failed attempt also takes its turn.
        if not key_ids:
            raise KeyConflict("Choose a saved Google Gemini key.")
        selection = (purpose, tuple(key_ids))
        position = self.next_position.get(selection, 0)
        self.next_position[selection] = (position + 1) % len(key_ids)
        return self.secret(db, key_ids[position])

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
            SELECT world.id, world.name, world.status
            FROM worlds world JOIN world_embedding_keys selection ON selection.owner_id = world.id
            WHERE selection.key_id = ? AND world.status != 'draft' ORDER BY world.rowid
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
            last = db.execute("SELECT model FROM embedding_defaults WHERE id = 1").fetchone()
            key_ids = (selected_keys(db, "embedding_default_keys", 1) if last and last["model"] == MODEL
                       else [key["id"] for key in keys if key["provider"] == PROVIDER][:1])
            defaults = {"model": MODEL, "key_ids": key_ids}
            return {"keys": keys, "defaults": defaults}

    @staticmethod
    def remember(db, model, key_ids):
        db.execute("""
            INSERT INTO embedding_defaults (id, model) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET model = excluded.model
        """, (model,))
        save_key_selection(db, "embedding_default_keys", 1, key_ids)

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
        return {
            "key": self._summary(key),
            "worlds": [{"id": world["id"], "name": world["name"]} for world in worlds],
            "busy": self._busy(key_id, worlds),
            "tales_use_key": any(db.execute(f"SELECT 1 FROM {table} WHERE key_id = ? LIMIT 1", (key_id,)).fetchone()
                                 for table in ("world_retrieval_keys", "tale_chat_keys", "chat_profile_keys")),
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
            db.execute("DELETE FROM provider_keys WHERE id = ?", (key_id,))
