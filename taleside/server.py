"""Serve the TaleSide pages, static assets, and local World API."""

import json
import mimetypes
import os
import socket
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

WEB_ROOT = Path(__file__).resolve().parent / "web"
MIME_TYPES = {".js": "text/javascript", ".woff2": "font/woff2"}
PAGE_ROUTES = {"/": "/pages/home/index.html", "/create": "/pages/create/index.html"}
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
        try:
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            # A browser may cancel an image request when switching previews.
            pass

    def send_json(self, value, status=HTTPStatus.OK):
        self.send_bytes(json.dumps(value).encode(), "application/json", status)

    def do_GET(self):
        if not self.local_request():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        path = unquote(urlsplit(self.path).path)
        if path == INSTANCE_PATH:
            self.send_json(INSTANCE)
            return
        if path == "/api/worlds":
            self.send_json(self.server.worlds.list())
            return
        path = PAGE_ROUTES.get(path, path)
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

    def do_POST(self):
        if not self.local_request() or self.headers.get("Origin") != self.server.url:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        parts = urlsplit(self.path).path.strip("/").split("/")
        if len(parts) != 4 or parts[:2] != ["api", "worlds"] or parts[3] not in ("pause", "resume"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        _, _, world_id, action = parts
        update = self.server.worlds.pause if action == "pause" else self.server.worlds.resume
        if update(world_id):
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "This World has already changed state."}, HTTPStatus.CONFLICT)

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
