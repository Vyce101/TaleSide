import codecs
import tempfile
import unittest
from pathlib import Path

from taleside.books import BookSource
from taleside.worlds import Worlds


class TokenCounter:
    def count(self, text):
        return len(text)


class WorldTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.database = Path(directory) / "worlds.sqlite3"
        self.worlds = Worlds(self.database, TokenCounter())

    def test_prepares_a_hidden_draft_with_oversized_chunks_and_originals(self):
        original = codecs.BOM_UTF8 + b"a" * 9000
        world = self.worlds.prepare("World", [
            BookSource("First.txt", original, "Renamed"), BookSource("Second.txt", b"second"),
        ], max_size=9000)
        self.assertEqual(world["oversized_chunks"], [{
            "book_number": 1, "chunk_number": 1, "tokens": 9023, "characters": 9000, "embedded_characters": 8169,
        }])
        self.assertEqual(self.worlds.list(), [])
        with self.worlds.connect() as db:
            originals = [tuple(row) for row in db.execute("SELECT original, working FROM books ORDER BY number")]
            model = tuple(db.execute("SELECT model, dimensions, max_chunk_size FROM worlds").fetchone())
        self.assertEqual(originals, [(original, "a" * 9000), (b"second", "second")])
        self.assertEqual(model, ("gemini-embedding-2", 768, 9000))

    def test_declines_a_draft_once(self):
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"a" * 9000)], max_size=9000)
        self.assertTrue(self.worlds.decline(world["id"]))
        self.assertFalse(self.worlds.decline(world["id"]))
