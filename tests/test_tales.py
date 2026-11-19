import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from threading import Event, Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from taleside.books import BookSource
from taleside.embeddings import EmbeddingError
from taleside.gemini_tales import InputTooLarge
from taleside.provider_keys import KEY_SCHEMA
from taleside.server import Server
from taleside.tales import TALE_SCHEMA
from taleside.worlds import SCHEMA, Worlds
from test_worlds import Provider, wait_for


class StoryProvider:
    def __init__(self):
        self.queries = []
        self.prompts = []
        self.counts = []
        self.parts = [
            {"text": "Provider thinking.", "thought": True},
            {"text": "“Read the gate inscription.”"},
            {"text": "", "thoughtSignature": "opaque-signature"},
        ]
        self.wait = False
        self.fail = False
        self.cancelled = Event()
        self.reject_long_chat = False
        self.reject_long_retrieval = False
        self.retrieval_error = None

    def __call__(self, generation):
        from types import SimpleNamespace

        def chat(model, key, prompt):
            self.prompts.append((model, key, prompt))
            if self.reject_long_chat and len(prompt["contents"]) > 1:
                raise InputTooLarge("Too long")
            yield from self.parts
            if self.fail:
                raise EmbeddingError("Provider interrupted")
            if self.wait and generation.cancelled.wait(3):
                self.cancelled.set()
                generation.check()

        return SimpleNamespace(embed=self.embed, count=self.count, chat=chat)

    def embed(self, world, key, text):
        self.queries.append((world["model"], key, text))
        if self.retrieval_error:
            raise self.retrieval_error
        if self.reject_long_retrieval and "\n\n" in text:
            raise InputTooLarge("Too long")
        return [1] * world["dimensions"]

    def count(self, model, key, body):
        self.counts.append((model, key, body))
        return 10


class TaleTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.database = Path(directory) / "worlds.sqlite3"
        self.worlds = Worlds(self.database, Provider())
        self.addCleanup(lambda: self.worlds.close())
        self.provider = StoryProvider()
        self.worlds.tales.provider = self.provider
        self.key = self.worlds.keys.add("gemini", "Import and retrieval", "fake-retrieval")["id"]
        self.chat_key = self.worlds.keys.add("gemini", "Chat", "fake-chat")["id"]
        draft = self.worlds.prepare("Test World", [BookSource("First.txt", b"abcdefghi"),
                                                    BookSource("Second.txt", b"jklmno")],
                                    max_size=6, search_distance=0, model="gemini-embedding-2", key_ids=[self.key])
        self.world = draft["id"]
        self.worlds.accept(self.world)
        wait_for(lambda: self.worlds.detail(self.world)["status"] == "ready")
        self.worlds.tales.settings({"chat_key_ids": [self.chat_key]})
        self.tale = self.worlds.tales.create(self.world)["id"]

    def open_server(self):
        server = self.enterContext(Server(self.worlds))
        worker = Thread(target=server.serve_forever)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)
        self.url = server.url

    def request(self, path, body=None):
        options = {}
        if body is not None:
            options["data"] = json.dumps(body).encode()
            options["headers"] = {"Content-Type": "application/json", "Origin": self.url}
        return urlopen(Request(self.url + path, **options), timeout=4)

    def send(self, text):
        with self.request(self.route + "/generate", {"content": text, "generation_id": uuid4().hex}) as stream:
            return [json.loads(line) for line in stream]

    @property
    def route(self):
        return f"/api/worlds/{self.world}/tales/{self.tale}"

    def test_streams_only_provider_thinking_and_sends_exact_wrapped_context(self):
        self.open_server()
        self.worlds.tales.settings({"chunk_overlap": 4})
        self.assertEqual(self.send("  Where is the gate?  "), [
            {"type": "thinking", "text": "Provider thinking."},
            {"type": "reply", "text": "“Read the gate inscription.”"},
            {"type": "done", "status": "complete"},
        ])
        self.assertEqual(self.provider.queries, [
            ("gemini-embedding-2", "fake-retrieval", "task: search result | query: Where is the gate?"),
        ])
        self.assertEqual(self.provider.prompts, [("gemini-4-hydrogen", "fake-chat", {
            "systemInstruction": {"parts": [{"text":
                "<world_info>\nName = Test World\nChunk Size = 6 Characters\nBooks = 2\n"
                "Book 1 - First\nBook 2 - Second\n</world_info>\n\n"
                "<retrieved_passages>\nabcdef\n\nghi\n\njklmno\n</retrieved_passages>",
            }]},
            "contents": [{"role": "user", "parts": [{"text": "<chat_history>\nWhere is the gate?\n</chat_history>"}]}],
            "generationConfig": {"maxOutputTokens": 65536,
                                 "thinkingConfig": {"thinkingLevel": "HIGH", "includeThoughts": True}},
        })])
        self.assertEqual(self.provider.counts, [])
        self.send("What does it say?")
        history = self.provider.prompts[-1][2]["contents"]
        self.assertEqual(history, [
            {"role": "user", "parts": [{"text": "<chat_history>\nWhere is the gate?"}]},
            {"role": "model", "parts": [{"text": "“Read the gate inscription.”"},
                                         {"text": "", "thoughtSignature": "opaque-signature"}]},
            {"role": "user", "parts": [{"text": "What does it say?\n</chat_history>"}]},
        ])
        self.assertEqual(self.provider.queries[-1][2],
                         "task: search result | query: “Read the gate inscription.”\n\nWhat does it say?")
        self.worlds.tales.settings({"thought_signatures": False})
        self.send("Read it aloud.")
        self.assertNotIn("thoughtSignature", json.dumps(self.provider.prompts[-1]))
        self.assertNotIn("Provider thinking.", json.dumps(self.provider.prompts[-1]))
        with self.request(self.route) as response:
            tale = json.load(response)
        self.assertEqual(tale["title"], "Where is the gate?")
        self.assertEqual(len(tale["messages"]), 6)
        self.assertNotIn("opaque-signature", json.dumps(tale))

    def test_retrieval_passes_whole_approved_chunk_and_adds_only_prior_chunk_text(self):
        self.open_server()
        with self.worlds.connect() as db:
            db.execute("""
                UPDATE chunks SET embed_end = 7 WHERE number = 2
                AND book_id = (SELECT id FROM books WHERE world_id = ? AND number = 1)
            """, (self.world,))
            db.execute("""
                UPDATE chunks SET vector = ? WHERE number = 1
                AND book_id IN (SELECT id FROM books WHERE world_id = ?)
            """, (bytes(3072 * 4), self.world))
        self.worlds.tales.settings({"chunk_overlap": 2, "retrieved_chunks": 1})
        self.send("Find the matching passage.")
        system = self.provider.prompts[-1][2]["systemInstruction"]["parts"][0]["text"]
        self.assertIn("<retrieved_passages>\nefghi\n</retrieved_passages>", system)

    def test_chat_length_rejection_keeps_full_history_and_ends_the_send(self):
        self.open_server()
        self.send("First question.")
        self.send("Second question.")
        self.provider.reject_long_chat = True
        self.request("/api/tale-settings", {"chat_key_ids": [self.chat_key, self.key]}).close()
        self.assertEqual(self.send("Latest question."), [{"type": "done", "status": "error"}])
        _, key, prompt = self.provider.prompts[2]
        self.assertEqual(key, "fake-chat")
        self.assertEqual(len(self.provider.prompts), 3)
        self.assertEqual(self.provider.counts, [])
        self.assertEqual([part["text"] for message in prompt["contents"] if message["role"] == "user"
                          for part in message["parts"]],
                         ["<chat_history>\nFirst question.", "Second question.", "Latest question.\n</chat_history>"])
        messages = self.worlds.tales.detail(self.world, self.tale)["messages"]
        self.assertEqual([message["content"] for message in messages if message["role"] == "user"],
                         ["First question.", "Second question.", "Latest question."])
        self.assertEqual(messages[-1]["status"], "error")

        self.provider.reject_long_chat = False
        self.assertEqual(self.send("Try again.")[-1]["status"], "complete")
        self.assertEqual(self.provider.prompts[-1][1], "fake-retrieval")

    def test_retrieval_length_checks_rotate_separately_from_chat(self):
        self.open_server()
        self.send("First question.")
        selection = [self.key, self.chat_key]
        self.request(f"/api/worlds/{self.world}/retrieval-key", {"key_ids": selection}).close()
        self.request("/api/tale-settings", {"chat_key_ids": selection, "messages_to_embed": 3}).close()
        self.provider.reject_long_retrieval = True
        self.assertEqual(self.send("Latest question.")[-1]["status"], "complete")
        self.assertEqual([request[1] for request in self.provider.queries[1:]],
                         ["fake-retrieval", "fake-retrieval", "fake-chat"])
        self.assertEqual(self.provider.queries[-1][2], "task: search result | query: Latest question.")
        self.assertEqual([request[1] for request in self.provider.counts], ["fake-chat"])
        self.assertEqual(self.provider.prompts[-1][1], "fake-retrieval")

        self.provider.retrieval_error = EmbeddingError("Gemini returned HTTP 429.")
        self.assertEqual(self.send("Another question."), [{"type": "done", "status": "error"}])
        self.assertEqual(len(self.provider.queries), 5)
        self.assertEqual(self.provider.queries[-1][1], "fake-retrieval")
        self.assertEqual(len(self.provider.prompts), 2)
        self.provider.retrieval_error = None
        self.provider.reject_long_retrieval = False
        self.assertEqual(self.send("Try again.")[-1]["status"], "complete")
        self.assertEqual(self.provider.queries[-1][1], "fake-chat")
        self.assertEqual(self.provider.prompts[-1][1], "fake-chat")

    def test_stop_and_disconnect_keep_partial_text_and_prevent_overlapping_sends(self):
        self.open_server()
        self.provider.wait = True
        for disconnect in (False, True):
            self.provider.cancelled.clear()
            generation_id = uuid4().hex
            with self.request(self.route + "/generate", {"content": "Go", "generation_id": generation_id}) as stream:
                self.assertEqual(json.loads(stream.readline())["type"], "thinking")
                self.assertEqual(json.loads(stream.readline())["type"], "reply")
                with self.assertRaises(HTTPError) as error:
                    self.request(self.route + "/generate", {"content": "Again", "generation_id": uuid4().hex})
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
                if not disconnect:
                    with self.request(self.route + "/stop", {"generation_id": generation_id, "user_stopped": True}):
                        self.assertEqual(json.loads(stream.readline()), {"type": "done", "status": "stopped"})
            self.assertTrue(self.provider.cancelled.wait(2))
            expected = "error" if disconnect else "stopped"
            wait_for(lambda: self.worlds.tales.detail(self.world, self.tale)["messages"][-1]["status"] == expected)
            last = self.worlds.tales.detail(self.world, self.tale)["messages"][-1]
            self.assertEqual(last["content"], "“Read the gate inscription.”")
            self.assertEqual(last["thinking"], "Provider thinking.")

    def test_tales_sort_with_pins_while_play_resumes_latest_and_world_deletion_cascades(self):
        tales = self.worlds.tales
        tales.change(self.world, self.tale, "pin", {"pinned": True})
        another = tales.create(self.world)["id"]
        self.assertEqual([item["title"] for item in tales.list(self.world)], ["Untitled Tale", "Untitled Tale 2"])
        tales.change(self.world, another, "rename", {"title": "Untitled Tale"})
        self.assertEqual([item["id"] for item in tales.list(self.world)], [self.tale, another])
        self.assertEqual(tales.create(self.world, resume=True), {"id": another})
        self.open_server()
        self.send("A message to cascade")
        self.assertTrue(self.worlds.discard(self.world))
        with self.worlds.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM tales").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM tale_messages").fetchone()[0], 0)

    def test_interrupted_reply_becomes_context_for_the_next_message(self):
        self.open_server()
        self.provider.fail = True
        self.assertEqual(self.send("First question.")[-1], {"type": "done", "status": "error"})
        self.provider.fail = False
        self.assertEqual(self.send("Next question.")[-1], {"type": "done", "status": "complete"})
        self.assertEqual(self.provider.queries[-1][2],
                         "task: search result | query: “Read the gate inscription.”\n\nNext question.")

    def test_deleting_a_tale_during_streaming_cancels_it_and_removes_messages(self):
        self.open_server()
        self.provider.wait = True
        with self.request(self.route + "/generate", {"content": "Go", "generation_id": uuid4().hex}) as stream:
            self.assertEqual(json.loads(stream.readline())["type"], "thinking")
            with self.request(self.route + "/delete", {}):
                self.assertTrue(self.provider.cancelled.wait(2))
        self.assertEqual(self.worlds.tales.list(self.world), [])
        with self.worlds.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM tale_messages").fetchone()[0], 0)

    def test_profile_round_trip_and_key_deletion_clear_only_tale_assignments(self):
        tales = self.worlds.tales
        tales.set_retrieval_keys(self.world, [self.chat_key])
        self.assertEqual(self.worlds.detail(self.world)["embedding_key_ids"], [self.key])
        tales.settings({"chat_key_ids": [self.chat_key, self.key]})
        profile_id = tales.settings({"name": "Readers"}, "create")["settings"]["profile_id"]
        tales.settings({"output_limit": 511, "chat_key_ids": []})
        tales.settings({"id": profile_id}, "select")
        self.assertEqual(tales.settings()["settings"]["output_limit"], 65536)
        self.assertEqual(tales.settings()["settings"]["chat_key_ids"], [self.chat_key, self.key])
        new_selection = [self.key, self.chat_key]
        tales.settings({"chat_key_ids": new_selection})
        tales.settings({"id": profile_id}, "save")
        tales.settings({"chat_key_ids": []})
        self.assertEqual(tales.settings({"id": profile_id}, "select")["settings"]["chat_key_ids"], new_selection)
        tales.settings({"id": profile_id, "name": "New name"}, "rename")
        self.assertEqual(tales.settings()["profiles"][0]["name"], "New name")
        keys = self.worlds.keys
        keys.delete(self.chat_key, keys.delete_impact(self.chat_key))
        self.assertEqual(self.worlds.detail(self.world)["retrieval_key_ids"], [])
        self.assertEqual(tales.settings()["settings"]["chat_key_ids"], [self.key])
        self.worlds.close()
        self.worlds = Worlds(self.database, Provider())
        tales = self.worlds.tales
        tales.settings({"id": profile_id}, "select")
        self.assertEqual(tales.settings()["settings"]["chat_key_ids"], [self.key])
        self.assertEqual(self.worlds.detail(self.world)["retrieval_key_ids"], [])
        self.assertEqual(self.worlds.detail(self.world)["embedding_key_ids"], [self.key])
        self.assertIsNone(tales.settings({"id": profile_id}, "delete")["settings"]["profile_id"])

    def test_legacy_key_settings_migrate_to_one_key_selections(self):
        path = self.database.with_name("legacy.sqlite3")
        key = uuid4().hex
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript(KEY_SCHEMA + SCHEMA + TALE_SCHEMA)
            db.execute("INSERT INTO provider_keys VALUES (?, 'gemini', 'Saved key', X'00')", (key,))
            db.execute("""
                INSERT INTO worlds (id, name, status, model, dimensions, max_token_limit,
                                    max_chunk_size, boundary_search_distance, key_id)
                VALUES (?, 'Legacy', 'ready', 'gemini-embedding-2', 768, 8192, 8000, 1000, ?)
            """, (self.world, key))
            db.execute("INSERT INTO embedding_defaults VALUES (1, 'gemini-embedding-2', ?)", (key,))
            db.execute("INSERT INTO chat_profiles VALUES ('legacy-profile', 'Saved profile', '{}', ?)", (key,))
            db.execute("INSERT INTO tale_settings VALUES (1, '{}', ?, 'legacy-profile')", (key,))
        worlds = Worlds(path, Provider())
        self.addCleanup(worlds.close)
        world = worlds.detail(self.world)
        self.assertEqual(world["embedding_key_ids"], [key])
        self.assertEqual(world["retrieval_key_ids"], [key])
        self.assertEqual(worlds.keys.settings()["defaults"]["key_ids"], [key])
        self.assertEqual(worlds.tales.settings()["settings"]["chat_key_ids"], [key])
        worlds.tales.settings({"chat_key_ids": []})
        self.assertEqual(worlds.tales.settings({"id": "legacy-profile"}, "select")["settings"]["chat_key_ids"], [key])
