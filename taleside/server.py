"""Serve the TaleSide pages, static assets, and local World API."""

import json
import mimetypes
import os
import re
import socket
import sqlite3
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from select import select
from threading import Thread
from urllib.parse import unquote, urlsplit

from .books import BookSource
from .embeddings import MODEL_INFO, EmbeddingError
from .provider_keys import KeyConflict
from .tales import MissingTaleKey, TaleNotFound

WEB_ROOT = Path(__file__).resolve().parent / "web"
MIME_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2"}
APP_PAGE = "/pages/index.html"
WORLD_ID = re.compile(r"[0-9a-f]{32}")
WORLD_PAGE = re.compile(r"/worlds/(?:[0-9a-f]{32}(?:/tales/[0-9a-f]{32})?|demo-[a-z0-9-]+)")
TALE_API = re.compile(r"/api/worlds/([0-9a-f]{32})/tales(?:/([0-9a-f]{32}))?(?:/([a-z-]+))?")
INSTANCE_PATH = "/api/instance"
INSTANCE = {"app": "TaleSide"}


class Handler(BaseHTTPRequestHandler):
    def local_request(self):
        return (self.headers.get("Host") == self.server.host
                and self.headers.get("Origin") in (None, self.server.url))

    def send_bytes(self, body, content_type, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if content_type == "application/json":
            self.send_header("Cache-Control", "no-store")
        try:
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            # A browser may cancel an image request when switching previews.
            pass

    def send_json(self, value, status=HTTPStatus.OK):
        self.send_bytes(json.dumps(value).encode(), "application/json", status)

    def api_error(self, message, status):
        self.send_json({"error": message}, status)

    def do_GET(self):
        if not self.local_request():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        path = unquote(urlsplit(self.path).path)
        if path == INSTANCE_PATH:
            self.send_json(INSTANCE)
            return
        if path == "/api/settings":
            self.send_json({"models": [MODEL_INFO], **self.server.worlds.keys.settings()})
            return
        impact = re.fullmatch(r"/api/provider-keys/([0-9a-f]{32})/delete-impact", path)
        if impact:
            try:
                self.send_json(self.server.worlds.keys.delete_impact(impact[1]))
            except KeyConflict as error:
                self.api_error(str(error), HTTPStatus.CONFLICT)
            return
        if path == "/api/worlds":
            self.send_json(self.server.worlds.list())
            return
        tales = self.server.worlds.tales
        if path == "/api/tale-settings":
            self.send_json(tales.settings())
            return
        match = TALE_API.fullmatch(path)
        if match and not match[3]:
            try:
                self.send_json(tales.detail(match[1], match[2]) if match[2] else tales.list(match[1]))
            except TaleNotFound as error:
                self.api_error(str(error), HTTPStatus.NOT_FOUND)
            return
        if path.startswith("/api/worlds/"):
            world_id = path.removeprefix("/api/worlds/")
            world = self.server.worlds.detail(world_id) if WORLD_ID.fullmatch(world_id) else None
            if world is None:
                self.api_error("This World could not be found.", HTTPStatus.NOT_FOUND)
            else:
                self.send_json(world)
            return
        if path in ("/", "/create") or WORLD_PAGE.fullmatch(path):
            path = APP_PAGE
        parts = path.lstrip("/").split("/")
        if parts[0] not in ("assets", "pages") or any(part in ("", ".", "..") for part in parts) or "\\" in path:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        target = WEB_ROOT.joinpath(*parts).resolve()
        allowed_root = WEB_ROOT / parts[0]
        if not target.is_relative_to(allowed_root) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = MIME_TYPES.get(target.suffix) or mimetypes.guess_type(target)[0] or "application/octet-stream"
        self.send_bytes(target.read_bytes(), content_type)

    def read_body(self):
        length = self.headers.get("Content-Length", "")
        if not length.isascii() or not length.isdecimal():
            raise ValueError("The request body needs a valid length.")
        length = int(length)
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("The request ended before all data was received.")
        return body

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Expected a JSON request.")
        return self.json_object(self.read_body())

    @staticmethod
    def json_object(data):
        try:
            value = json.loads(data)
        except (TypeError, ValueError, RecursionError):
            raise ValueError("The request contains invalid JSON.") from None
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object.")
        return value

    def prepare_import(self, world_id):
        if self.headers.get_content_type() != "multipart/form-data":
            raise ValueError("Send the settings and TXT files together.")
        mime_header = f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode("ascii")
        message = BytesParser(policy=policy.default).parsebytes(mime_header + self.read_body())
        if not message.is_multipart() or message.defects:
            raise ValueError("The book upload is incomplete.")
        parts = list(message.iter_parts())
        if (not parts or parts[0].is_multipart() or parts[0].defects
                or parts[0].get_param("name", header="content-disposition") != "settings"):
            raise ValueError("The upload is missing World settings.")
        settings = self.json_object(parts[0].get_payload(decode=True))
        book_details = settings.get("books")
        file_parts = parts[1:]
        if not isinstance(book_details, list) or len(book_details) != len(file_parts):
            raise ValueError("The book list does not match the uploaded files.")
        books = []
        for details, part in zip(book_details, file_parts):
            if (not isinstance(details, dict) or not isinstance(details.get("filename"), str)
                    or part.is_multipart() or part.defects
                    or part.get_param("name", header="content-disposition") != "book"
                    or part.get("content-transfer-encoding") is not None):
                raise ValueError("The upload contains an invalid book.")
            books.append(BookSource(details["filename"], part.get_payload(decode=True), details.get("name")))
        return self.server.worlds.prepare(settings.get("name"), books, settings.get("max_chunk_size"),
                                          settings.get("boundary_search_distance"), model=settings.get("model"),
                                          key_ids=settings.get("key_ids"), world_id=world_id)

    def do_POST(self):
        if not self.local_request() or self.headers.get("Origin") != self.server.url:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        try:
            tales = self.server.worlds.tales
            if path == "/api/tale-settings":
                changes = self.read_json()
                if "chat_key_id" in changes:
                    key_id = changes.pop("chat_key_id")
                    changes.setdefault("chat_key_ids", [] if key_id is None else [key_id])
                self.send_json(tales.settings(changes))
                return
            profile = re.fullmatch(r"/api/chat-profiles/(select|create|save|rename|delete)", path)
            if profile:
                self.send_json(tales.settings(self.read_json(), profile[1]))
                return
            match = TALE_API.fullmatch(path)
            if match:
                self.update_tale(*match.groups())
                return
            if path == "/api/provider-keys":
                details = self.read_json()
                key = self.server.worlds.keys.add(details.get("provider"), details.get("nickname"),
                                                  details.get("secret"))
                self.send_json(key, HTTPStatus.CREATED)
                return
            match = re.fullmatch(r"/api/(worlds|world-imports|provider-keys)/([0-9a-f]{32})/([a-z-]+)", path)
            if match is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            group, item_id, action = match.groups()
            if group == "world-imports":
                self.update_import(item_id, action)
            elif group == "provider-keys":
                self.update_key(item_id, action)
            else:
                self.update_world(item_id, action)
        except TaleNotFound as error:
            self.api_error(str(error), HTTPStatus.NOT_FOUND)
        except MissingTaleKey as error:
            self.send_json({"error": str(error), "missing_key": error.field}, HTTPStatus.CONFLICT)
        except KeyConflict as error:
            self.api_error(str(error), HTTPStatus.CONFLICT)
        except ValueError as error:
            self.api_error(str(error), HTTPStatus.BAD_REQUEST)
        except EmbeddingError as error:
            self.api_error(str(error), HTTPStatus.BAD_GATEWAY)
        except sqlite3.Error:
            self.api_error("Could not update the local World database.", HTTPStatus.INTERNAL_SERVER_ERROR)

    def update_key(self, key_id, action):
        keys = self.server.worlds.keys
        if action == "rename":
            keys.rename(key_id, self.read_json().get("nickname"))
        elif action == "replace":
            keys.replace(key_id, self.read_json().get("secret"))
        elif action == "delete":
            keys.delete(key_id, self.read_json().get("impact"))
        else:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_json({"ok": True})

    def update_import(self, world_id, action):
        worlds = self.server.worlds
        if action == "prepare":
            self.send_json(self.prepare_import(world_id))
        elif action == "cancel":
            worlds.decline(world_id)
            self.send_json({"ok": True})
        elif action == "accept":
            allow = self.read_json().get("allow_oversized", False)
            if type(allow) is not bool:
                raise ValueError("Oversized chunk approval must be true or false.")
            if worlds.accept(world_id, allow):
                self.send_json({"world": worlds.detail(world_id)}, HTTPStatus.CREATED)
            else:
                self.api_error("This import expired or requires approval. Check the books again.",
                               HTTPStatus.CONFLICT)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def update_world(self, world_id, action):
        worlds = self.server.worlds
        if action == "rename":
            updated = worlds.rename(world_id, self.read_json().get("name"))
        elif action == "embedding-key":
            updated = worlds.set_embedding_keys(world_id, self.read_json().get("key_ids"))
        elif action == "retrieval-key":
            fields = self.read_json()
            worlds.tales.set_retrieval_keys(world_id, fields.get("key_ids", [fields.get("key_id")]))
            updated = True
        elif action == "discard":
            updated = worlds.discard(world_id)
        elif action == "pause":
            updated = worlds.pause(world_id)
        elif action == "resume":
            updated = worlds.resume(world_id)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if updated:
            self.send_json({"ok": True})
        else:
            self.api_error("This World has already changed state.", HTTPStatus.CONFLICT)

    def update_tale(self, world_id, tale_id, action):
        tales = self.server.worlds.tales
        if tale_id is None and action in (None, "play"):
            self.send_json(tales.create(world_id, resume=action == "play"))
        elif tale_id and action == "generate":
            fields = self.read_json()
            generation_id = fields.get("generation_id")
            if not isinstance(generation_id, str) or not WORLD_ID.fullmatch(generation_id):
                raise ValueError("A valid generation ID is required.")
            prepared = tales.begin(world_id, tale_id, fields.get("content"), generation_id)
            self.stream_tale(tales, tale_id, prepared)
        elif tale_id and action in ("rename", "pin", "delete", "stop"):
            tales.change(world_id, tale_id, action, self.read_json())
            self.send_json({"ok": True})
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def stream_tale(self, tales, tale_id, prepared):
        generation = prepared[0]
        events = Queue()
        worker = Thread(target=tales.generate, args=(tale_id, prepared, events.put), daemon=True)
        worker.start()
        self.close_connection = True
        completed = False
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            while True:
                readable, _, _ = select([self.connection], [], [], 0)
                if readable and not self.connection.recv(1, socket.MSG_PEEK):
                    return
                try:
                    event = events.get(timeout=.1)
                except Empty:
                    if not worker.is_alive():
                        return
                    continue
                self.wfile.write((json.dumps(event) + "\n").encode())
                if event["type"] == "done":
                    completed = True
                    return
        except OSError:
            pass
        finally:
            if not completed and worker.is_alive():
                generation.cancel()

    def log_request(self, code="-", size="-"):
        if str(code)[0] in "45":
            super().log_request(code, size)


class Server(ThreadingHTTPServer):
    def __init__(self, worlds, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.worlds = worlds
        self.host = f"127.0.0.1:{self.server_port}"
        self.url = f"http://{self.host}"

    def server_bind(self):
        if os.name == "nt":
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()
