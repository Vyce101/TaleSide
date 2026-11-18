import codecs
import json
import os
import tempfile
import time
import unittest
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from threading import Event, Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from taleside.books import BookSource
from taleside.embeddings import EmbeddingError
from taleside.server import Server
from taleside.worlds import Worlds


class Provider:
    def __init__(self):
        self.embedded = []
        self.vector = None
        self.embed_requests = []
        self.count_requests = []
        self.count_started = Event()
        self.count_release = Event()
        self.count_release.set()
        self.started = Event()
        self.release = Event()
        self.release.set()

    def __call__(self, secret, *, model, dimensions):
        return SimpleNamespace(
            count=partial(self.count, secret, model),
            embed=partial(self.embed, secret, model, dimensions),
        )

    def count(self, secret, model, text):
        self.count_requests.append((secret, model, text))
        self.count_started.set()
        if not self.count_release.wait(3):
            raise EmbeddingError("Request timed out.")
        return len(text)

    def embed(self, secret, model, dimensions, text):
        self.embedded.append(text)
        self.embed_requests.append((secret, model, dimensions, text))
        self.started.set()
        if not self.release.wait(3):
            raise EmbeddingError("Request timed out.")
        if isinstance(self.vector, Exception):
            raise self.vector
        return self.vector if self.vector is not None else [0.5] * dimensions


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
        self.addCleanup(self.provider.count_release.set)
        self.key = self.worlds.keys.add("gemini", "Personal", "fake-personal-key")["id"]

    def prepare(self, name, books, *chunk_settings, key_id=None, **settings):
        return self.worlds.prepare(name, books, *chunk_settings, model="gemini-embedding-2",
                                   key_id=key_id or self.key, **settings)

    def test_oversized_import_requires_approval_and_keeps_full_text_and_original(self):
        original = codecs.BOM_UTF8 + b"a" * 9000
        world = self.prepare("World", [
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
        self.assertEqual(model, ("gemini-embedding-2", 3072, 9000))

    def test_cancelling_an_import_leaves_no_saved_world_books_or_chunks(self):
        world = self.prepare("World", [BookSource("Book.txt", b"a" * 9000)], max_size=9000)
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
        world = self.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
        self.assertTrue(self.worlds.accept(world["id"]))
        self.assertTrue(self.provider.started.wait(2))
        self.assertTrue(self.worlds.pause(world["id"]))
        self.assertEqual(self.worlds.detail(world["id"])["status"], "pausing")
        self.assertFalse(self.worlds.resume(world["id"]))
        self.provider.release.set()
        wait_for(lambda: self.worlds.list()[0]["status"] == "paused")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 1)
        self.assertEqual(self.worlds.list()[0]["status"], "paused")
        self.assertTrue(self.worlds.resume(world["id"]))
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")
        self.assertEqual(self.provider.embedded, ["title: Book | text: abcd", "title: Book | text: efgh"])

    def test_restarted_job_waits_for_resume_and_keeps_the_saved_vector(self):
        self.provider.release.clear()
        world = self.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
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

    def test_failed_request_while_pausing_can_be_retried(self):
        self.provider.release.clear()
        self.provider.vector = EmbeddingError("Gemini is unavailable.")
        world = self.prepare("World", [BookSource("Book.txt", b"text")])
        self.worlds.accept(world["id"])
        self.assertTrue(self.provider.started.wait(2))
        self.assertTrue(self.worlds.pause(world["id"]))
        self.provider.release.set()
        wait_for(lambda: self.worlds.detail(world["id"])["status"] == "failed")
        self.assertEqual(self.worlds.detail(world["id"])["embedded_chunks"], 0)
        self.provider.vector = None
        self.assertTrue(self.worlds.resume(world["id"]))
        wait_for(lambda: self.worlds.detail(world["id"])["status"] == "ready")

    def test_discard_during_embedding_cascades_and_does_not_restore_the_world(self):
        self.provider.release.clear()
        first = self.prepare("First", [BookSource("First.txt", b"first")])
        self.worlds.accept(first["id"])
        self.assertTrue(self.provider.started.wait(2))
        second = self.prepare("Second", [BookSource("Second.txt", b"second")])
        self.worlds.accept(second["id"])
        self.assertTrue(self.worlds.pause(second["id"]))
        self.assertEqual(self.worlds.detail(second["id"])["status"], "paused")
        self.assertTrue(self.worlds.discard(first["id"]))
        self.provider.release.set()
        self.worlds.resume(second["id"])
        wait_for(lambda: self.worlds.detail(second["id"])["status"] == "ready")
        self.assertIsNone(self.worlds.detail(first["id"]))
        with self.worlds.connect() as db:
            for table in ("books", "chunks"):
                self.assertEqual(db.execute(f"SELECT count(*) FROM {table} WHERE world_id = ?",
                                            (first["id"],)).fetchone()[0], 0)

    def test_invalid_vector_and_provider_error_fail_without_saving_progress(self):
        self.provider.vector = [float("nan")] * 3072
        world = self.prepare("World", [BookSource("Book.txt", b"text")])
        self.worlds.accept(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "failed")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 0)
        self.assertIn("invalid embedding", self.worlds.list()[0]["error"])
        self.provider.vector = EmbeddingError("Gemini is unavailable.")
        self.worlds.resume(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "failed")
        self.assertEqual(self.worlds.list()[0]["embedded_chunks"], 0)
        self.assertEqual(self.worlds.list()[0]["error"], "Gemini is unavailable.")
        self.provider.vector = None
        self.worlds.resume(world["id"])
        wait_for(lambda: self.worlds.list()[0]["status"] == "ready")

    def test_replacing_a_key_keeps_its_id_and_survives_restart(self):
        alternate = self.worlds.keys.add("gemini", "Work", "fake-work-key")["id"]
        self.worlds.keys.replace(alternate, "fake-replacement-secret")
        self.worlds.close()
        self.worlds = Worlds(self.database, self.provider)
        world = self.prepare("World", [BookSource("Book.txt", b"chapter")], key_id=alternate)
        self.assertTrue(self.worlds.accept(world["id"]))
        wait_for(lambda: self.worlds.detail(world["id"])["status"] == "ready")
        self.assertEqual(self.provider.count_requests, [
            ("fake-replacement-secret", "gemini-embedding-2", "title: Book | text: chapter"),
        ])
        self.assertEqual(self.provider.embed_requests, [
            ("fake-replacement-secret", "gemini-embedding-2", 3072, "title: Book | text: chapter"),
        ])
        self.assertEqual(self.worlds.keys.settings()["defaults"]["key_id"], alternate)

    def test_provider_key_api_omits_secrets_and_rejects_cross_origin_changes(self):
        with Server(self.worlds) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            secret = "fake-private-credential"
            body = json.dumps({"provider": "gemini", "nickname": "Work", "secret": secret}).encode()

            def add(origin):
                headers = {"Origin": origin, "Content-Type": "application/json"}
                return urlopen(Request(server.url + "/api/provider-keys", data=body, headers=headers))

            try:
                with self.assertRaises(HTTPError) as caught:
                    add("https://example.com")
                with caught.exception as response:
                    self.assertEqual(response.code, 403)
                with add(server.url) as response:
                    public_key = json.load(response)
                    self.assertEqual(set(public_key), {"id", "provider", "nickname"})
                with urlopen(server.url + "/api/settings") as response:
                    data = response.read()
                    self.assertNotIn(secret.encode(), data)
                    settings = json.loads(data)
                    self.assertEqual(len(settings["keys"]), 2)
                    self.assertEqual(settings["models"][0]["dimensions"], 3072)
                with self.assertRaises(HTTPError) as caught:
                    add(server.url)
                with caught.exception as response:
                    self.assertEqual(response.code, 400)
                    self.assertNotIn(secret.encode(), response.read())
                with self.worlds.connect() as db:
                    protected = db.execute("SELECT protected_secret FROM provider_keys WHERE id = ?",
                                           (public_key["id"],)).fetchone()[0]
                    self.assertNotIn(secret.encode(), protected)
            finally:
                server.shutdown()
                thread.join()

    def test_homepage_api_only_allows_same_origin_state_changes(self):
        self.provider.release.clear()
        world = self.prepare("World", [BookSource("Book.txt", b"abcdefgh")], 4, 0)
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
                    self.assertEqual(json.load(response)[0]["status"], "pausing")
                resume = Request(url.replace("/pause", "/resume"), method="POST", headers={"Origin": server.url})
                with self.assertRaises(HTTPError) as caught:
                    urlopen(resume)
                with caught.exception as response:
                    self.assertEqual(response.code, 409)
            finally:
                server.shutdown()
                thread.join()

    def test_http_import_keeps_file_order_and_bytes_and_accepts_only_once(self):
        second = codecs.BOM_UTF16_LE + "second\r\n".encode("utf-16-le")
        first = codecs.BOM_UTF8 + b"first\r\n"
        settings = json.dumps({
            "name": " ",
            "model": "gemini-embedding-2",
            "key_id": self.key,
            "max_chunk_size": 8000,
            "boundary_search_distance": 1000,
            "books": [
                {"filename": "Second.part.txt", "name": "Same title"},
                {"filename": "First.txt", "name": "Same title"},
            ],
        }).encode()
        files = b"".join(
            b'--boundary\r\nContent-Disposition: form-data; name="book"; filename="Book.txt"\r\n'
            b'Content-Type: text/plain\r\n\r\n' + original + b"\r\n"
            for original in (second, first)
        )
        body = (b'--boundary\r\nContent-Disposition: form-data; name="settings"\r\n\r\n' + settings
                + b"\r\n" + files + b"--boundary--\r\n")
        world_id = uuid4().hex
        with Server(self.worlds) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def post(path, data, content_type="application/json"):
                headers = {"Origin": server.url, "Content-Type": content_type}
                with urlopen(Request(server.url + path, data=data, headers=headers)) as response:
                    return json.load(response)

            try:
                route = f"/api/world-imports/{world_id}"
                prepared = post(route + "/prepare", body, "multipart/form-data; boundary=boundary")
                self.assertEqual(prepared["oversized_chunks"], [])
                self.assertEqual(self.worlds.list(), [])
                accepted = post(route + "/accept", b"{}")["world"]
                self.assertEqual(accepted["name"], "TaleSide")
                self.assertEqual([book["filename"] for book in accepted["books"]], ["Second.part.txt", "First.txt"])
                self.assertEqual(post(route + "/accept", b"{}")["world"]["id"], world_id)
                wait_for(lambda: self.worlds.detail(world_id)["status"] == "ready")
                self.assertEqual(self.provider.embedded, ["title: Same title | text: second\n",
                                                          "title: Same title | text: first\n"])

                self.assertEqual(post(f"/api/worlds/{world_id}/rename", b'{"name":"Renamed"}'), {"ok": True})
                with urlopen(f"{server.url}/api/worlds/{world_id}") as response:
                    self.assertEqual(json.load(response)["name"], "Renamed")
                with urlopen(f"{server.url}/worlds/{world_id}") as response:
                    self.assertIn(b'id="studio"', response.read())
                with self.worlds.connect() as db:
                    originals = [row[0] for row in db.execute("SELECT original FROM books ORDER BY number")]
                self.assertEqual(originals, [second, first])
            finally:
                server.shutdown()
                thread.join()


@unittest.skipUnless(os.getenv("GEMINI_API_KEY"), "GEMINI_API_KEY is not configured")
class LiveGeminiTests(unittest.TestCase):
    def test_checks_and_embeds_an_approved_prefix_with_gemini(self):
        with tempfile.TemporaryDirectory() as directory:
            worlds = Worlds(Path(directory) / "worlds.sqlite3")
            key_id = worlds.keys.add("gemini", "Live test", os.environ["GEMINI_API_KEY"])["id"]
            try:
                text = b"The book on the table is blue. " * 1400
                draft = worlds.prepare("Example", [BookSource("Example.txt", text)], max_size=len(text),
                                       model="gemini-embedding-2", key_id=key_id)
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
