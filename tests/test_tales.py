import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from taleside.books import BookSource
from taleside.provider_keys import KEY_SCHEMA
from taleside.worlds import SCHEMA, Worlds
from test_worlds import Provider, wait_for

class TaleTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.database = Path(directory) / "worlds.sqlite3"
        self.worlds = Worlds(self.database, Provider())
        self.addCleanup(lambda: self.worlds.close())
        self.key = self.worlds.keys.add("gemini", "Import and retrieval", "fake-retrieval")["id"]
        self.chat_key = self.worlds.keys.add("gemini", "Chat", "fake-chat")["id"]
        draft = self.worlds.prepare("Test World", [BookSource("First.txt", b"abcdefghi"),
                                                    BookSource("Second.txt", b"jklmno")],
                                    max_size=6, search_distance=0, model="gemini-embedding-2", key_id=self.key)
        self.world = draft["id"]
        self.worlds.accept(self.world)
        wait_for(lambda: self.worlds.detail(self.world)["status"] == "ready")
        self.worlds.tales.settings({"chat_key_id": self.chat_key})
        self.tale = self.worlds.tales.create(self.world)["id"]

    def test_tales_sort_with_pins_while_play_resumes_latest_and_world_deletion_cascades(self):
        tales = self.worlds.tales
        tales.change(self.world, self.tale, "pin", {"pinned": True})
        another = tales.create(self.world)["id"]
        self.assertEqual([item["title"] for item in tales.list(self.world)], ["Untitled Tale", "Untitled Tale 2"])
        tales.change(self.world, another, "rename", {"title": "Untitled Tale"})
        self.assertEqual([item["id"] for item in tales.list(self.world)], [self.tale, another])
        self.assertEqual(tales.create(self.world, resume=True), {"id": another})
        self.assertTrue(self.worlds.discard(self.world))
        with self.worlds.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM tales").fetchone()[0], 0)
    def test_profile_round_trip_and_key_deletion_clear_only_tale_assignments(self):
        tales = self.worlds.tales
        tales.set_retrieval_key(self.world, self.chat_key)
        self.assertEqual(self.worlds.detail(self.world)["key_id"], self.key)
        profile_id = tales.settings({"name": "Readers"}, "create")["settings"]["profile_id"]
        tales.settings({"output_limit": 511})
        tales.settings({"id": profile_id}, "select")
        self.assertEqual(tales.settings()["settings"]["output_limit"], 65536)
        tales.settings({"id": profile_id, "name": "New name"}, "rename")
        self.assertEqual(tales.settings()["profiles"][0]["name"], "New name")
        keys = self.worlds.keys
        keys.delete(self.chat_key, keys.delete_impact(self.chat_key))
        self.assertIsNone(self.worlds.detail(self.world)["retrieval_key_id"])
        self.assertIsNone(tales.settings()["settings"]["chat_key_id"])
        self.worlds.close()
        self.worlds = Worlds(self.database, Provider())
        tales = self.worlds.tales
        tales.settings({"id": profile_id}, "select")
        self.assertIsNone(tales.settings()["settings"]["chat_key_id"])
        self.assertIsNone(self.worlds.detail(self.world)["retrieval_key_id"])
        self.assertEqual(self.worlds.detail(self.world)["key_id"], self.key)
        self.assertIsNone(tales.settings({"id": profile_id}, "delete")["settings"]["profile_id"])

    def test_legacy_world_copies_its_existing_key_on_migration(self):
        path = self.database.with_name("legacy.sqlite3")
        key = uuid4().hex
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript(KEY_SCHEMA + SCHEMA)
            db.execute("INSERT INTO provider_keys VALUES (?, 'gemini', 'Saved key', X'00')", (key,))
            db.execute("""
                INSERT INTO worlds (id, name, status, model, dimensions, max_token_limit,
                                    max_chunk_size, boundary_search_distance, key_id)
                VALUES (?, 'Legacy', 'ready', 'gemini-embedding-2', 768, 8192, 8000, 1000, ?)
            """, (self.world, key))
        worlds = Worlds(path, Provider())
        self.addCleanup(worlds.close)
        self.assertEqual(worlds.detail(self.world)["retrieval_key_id"], key)
