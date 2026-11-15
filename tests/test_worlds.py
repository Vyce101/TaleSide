import codecs
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event, Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from taleside.books import BookSource
from taleside.embeddings import EmbeddingError, Gemini
from taleside.server import Server
from taleside.worlds import Worlds


class Provider:
    def __init__(self):
        self.embedded = []
        self.vector = [0.5] * 768
        self.started = Event()
        self.release = Event()
        self.release.set()

    def count(self, text):
        return len(text)

    def embed(self, text):
        self.embedded.append(text)
        self.started.set()
        if not self.release.wait(3):
            raise EmbeddingError("Request timed out.")
        if isinstance(self.vector, Exception):
            raise self.vector
        return self.vector


def wait_for(check):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.01)
    raise AssertionError("The expected state was not reached.")

class WorldTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.database = Path(directory) / "worlds.sqlite3"
        self.provider = Provider()
        self.worlds = Worlds(self.database, self.provider)
        self.addCleanup(lambda: self.worlds.close())
        self.addCleanup(self.provider.release.set)

    def test_oversized_import_requires_approval_and_keeps_full_text_and_original(self):
        original = codecs.BOM_UTF8 + b"a" * 9000
        world = self.worlds.prepare("World", [
            BookSource("First.txt", original, "Renamed"), BookSource("Second.txt", b"second"),
        ], max_size=9000)
        self.assertEqual(world["oversized_chunks"], [{
            "book_number": 1, "chunk_number": 1, "tokens": 9023, "characters": 9000, "embedded_characters": 8169,
        }])
        self.assertEqual(self.worlds.list(), [])
        self.assertFalse(self.worlds.accept(world["id"]))
        self.assertEqual(self.provider.embedded, [])
        self.assertTrue(self.worlds.accept(world["id"], allow_oversized=True))
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")
        self.assertEqual(self.provider.embedded, ["title: Renamed | text: " + "a" * 8169, "title: Second | text: second"])
        with self.worlds.connect() as db:
            originals = [tuple(row) for row in db.execute("SELECT original, working FROM books ORDER BY number")]
            model = tuple(db.execute("SELECT model, dimensions, max_chunk_size FROM worlds").fetchone())
        self.assertEqual(originals, [(original, "a" * 9000), (b"second", "second")])
        self.assertEqual(model, ("gemini-embedding-2", 768, 9000))

    def test_cancelling_an_import_leaves_no_saved_world_books_or_chunks(self):
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"a" * 9000)], max_size=9000)
        with self.worlds.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM worlds").fetchone()[0], 0)
        self.assertTrue(self.worlds.decline(world["id"]))
        self.assertFalse(self.worlds.accept(world["id"], allow_oversized=True))
        self.assertEqual(self.provider.embedded, [])
        with self.worlds.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM books").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM chunks").fetchone()[0], 0)

    def test_pause_finishes_in_flight_chunk_and_resume_only_embeds_remaining_text(self):
        self.provider.release.clear()
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
        self.assertTrue(self.worlds.accept(world["id"]))
        self.assertTrue(self.provider.started.wait(2))
        self.assertTrue(self.worlds.pause(world["id"]))
        self.provider.release.set()
        wait_for(lambda: self.worlds.list()[0]["embedded_chunks"] == 1)
        self.assertEqual(self.worlds.list()[0]["status"], "paused")
        self.assertTrue(self.worlds.resume(world["id"]))
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")
        self.assertEqual(self.provider.embedded, ["title: Book | text: abcd", "title: Book | text: efgh"])

    def test_restarted_job_waits_for_resume_and_keeps_the_saved_vector(self):
        self.provider.release.clear()
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
        self.worlds.accept(world["id"])
        self.assertTrue(self.provider.started.wait(2))
        old_worlds = self.worlds
        closing = Thread(target=old_worlds.close)
        closing.start()
        self.assertTrue(old_worlds.stopping.wait(2))
        self.provider.release.set()
        closing.join(2)
        self.assertFalse(closing.is_alive())
        self.worlds = Worlds(self.database, self.provider)
        self.assertEqual(self.worlds.list()[0]["status"], "paused")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 1)
        self.worlds.resume(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")
        self.assertEqual(self.provider.embedded, ["title: Book | text: abcd", "title: Book | text: efgh"])

    def test_invalid_vector_and_provider_error_fail_without_saving_progress(self):
        self.provider.vector = [float("nan")] * 768
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"text")])
        self.worlds.accept(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "failed")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 0)
        self.assertIn("invalid embedding", self.worlds.list()[0]["error"])
        self.provider.vector = EmbeddingError("Gemini is unavailable.")
        self.worlds.resume(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "failed")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 0)
        self.assertEqual(self.worlds.list()[0]["error"], "Gemini is unavailable.")
        self.provider.vector = [0.5] * 768
        self.worlds.resume(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")

    def test_homepage_api_only_allows_same_origin_state_changes(self):
        self.provider.release.clear()
        world = self.worlds.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
        self.worlds.accept(world["id"])
        self.assertTrue(self.provider.started.wait(2))
        with Server(self.worlds) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"{server.url}/api/worlds/{world['id']}/pause"
                foreign = Request(url, method="POST", headers={"Origin": "https://example.com"})
                with self.assertRaises(HTTPError) as caught:
                    urlopen(foreign)
                with caught.exception as response:
                    self.assertEqual(response.code, 403)
                local = Request(url, method="POST", headers={"Origin": server.url})
                with urlopen(local) as response:
                    self.assertEqual(json.load(response), {"ok": True})
                with urlopen(f"{server.url}/api/worlds") as response:
                    self.assertEqual(json.load(response)[0]["status"], "paused")
            finally:
                server.shutdown()
                thread.join()


@unittest.skipUnless(os.getenv("GEMINI_API_KEY"), "GEMINI_API_KEY is not configured")
class LiveGeminiTests(unittest.TestCase):
    def test_checks_and_embeds_an_approved_prefix_with_gemini(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = Gemini(os.environ["GEMINI_API_KEY"])
            worlds = Worlds(Path(directory) / "worlds.sqlite3", provider)
            try:
                text = b"The book on the table is blue. " * 1400
                draft = worlds.prepare("Example", [BookSource("Example.txt", text)], max_size=len(text))
                oversized, = draft["oversized_chunks"]
                self.assertGreater(oversized["tokens"], 8192)
                self.assertLess(oversized["embedded_characters"], len(text))
                self.assertFalse(worlds.accept(draft["id"]))
                self.assertTrue(worlds.accept(draft["id"], allow_oversized=True))
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    world = worlds.list()[0]
                    if world["status"] in ("ready", "failed"):
                        break
                    time.sleep(.1)
                self.assertEqual(world["status"], "ready", world["error"])
                self.assertEqual(world["embedded_chunks"], 1)
            finally:
                worlds.close()
