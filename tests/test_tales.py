import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from taleside.books import BookSource
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
