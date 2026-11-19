"""Cancellable Gemini REST requests for a single Tale generation."""

import json
import socket
from http.client import HTTPSConnection, HTTPException
from threading import Event, Lock

from .embeddings import EmbeddingError

HOST = "generativelanguage.googleapis.com"


class GenerationCancelled(Exception):
    pass


class InputTooLarge(EmbeddingError):
    pass


class Generation:
    def __init__(self, world_id, generation_id):
        self.world_id = world_id
        self.id = generation_id
        self.cancelled = Event()
        self.user_stopped = False
        self.lock = Lock()
        self.socket = None
        self.reply = ""
        self.thinking = ""

    def check(self):
        if self.cancelled.is_set():
            raise GenerationCancelled()

    def attach_socket(self, upstream):
        with self.lock:
            self.check()
            self.socket = upstream

    def cancel(self, *, user_stopped=False):
        with self.lock:
            self.user_stopped |= user_stopped
            self.cancelled.set()
            if self.socket:
                try:
                    self.socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


def response_error(status, payload):
    try:
        message = json.loads(payload)["error"]["message"].lower()
    except (ValueError, KeyError, TypeError, AttributeError):
        message = ""
    if status in (400, 413) and (status == 413 or (
        any(term in message for term in ("token", "context", "input", "payload", "request size"))
        and any(term in message for term in ("exceed", "too large", "too long", "maximum", "max "))
    )):
        return InputTooLarge("Gemini's input limit was exceeded.")
    return EmbeddingError(f"Gemini returned HTTP {status}.")


class GeminiTale:
    def __init__(self, generation):
        self.generation = generation

    def packets(self, model, key, method, body, *, stream=False):
        generation = self.generation
        generation.check()
        connection = HTTPSConnection(HOST, timeout=30)
        response = None
        try:
            connection.connect()
            generation.attach_socket(connection.sock)
            path = f"/v1beta/models/{model}:{method}"
            if stream:
                path += "?alt=sse"
            connection.request("POST", path, json.dumps(body).encode(), {
                "Content-Type": "application/json", "x-goog-api-key": key,
            })
            response = connection.getresponse()
            if response.status != 200:
                raise response_error(response.status, response.read())
            if not stream:
                yield json.load(response)
                return
            data = []
            for line in response:
                generation.check()
                line = line.rstrip(b"\r\n")
                if line.startswith(b"data:"):
                    data.append(line[5:].lstrip())
                elif not line and data:
                    yield json.loads(b"\n".join(data))
                    data.clear()
            if data:
                yield json.loads(b"\n".join(data))
        except (HTTPException, OSError, ValueError):
            generation.check()
            raise EmbeddingError("Gemini's connection ended unexpectedly.") from None
        finally:
            with generation.lock:
                generation.socket = None
            if response is not None:
                response.close()
            connection.close()

    def embed(self, world, key, text):
        response, = self.packets(world["model"], key, "embedContent", {
            "content": {"parts": [{"text": text}]},
            "embedContentConfig": {"outputDimensionality": world["dimensions"], "autoTruncate": False},
        })
        return response["embedding"]["values"]

    def count(self, model, key, body):
        response, = self.packets(model, key, "countTokens", body)
        count = response["totalTokens"]
        if type(count) is not int or count < 1:
            raise EmbeddingError("Gemini returned an invalid token count.")
        return count

    def chat(self, model, key, body):
        finished = False
        for packet in self.packets(model, key, "streamGenerateContent", body, stream=True):
            if packet.get("error"):
                error = packet["error"]
                raise response_error(error.get("code"), json.dumps(packet))
            if packet.get("promptFeedback", {}).get("blockReason"):
                raise EmbeddingError("Gemini blocked the request.")
            for candidate in packet.get("candidates", []):
                for part in candidate.get("content", {}).get("parts", []):
                    yield part
                reason = candidate.get("finishReason")
                if reason in ("STOP", "MAX_TOKENS"):
                    finished = True
                elif reason and reason != "FINISH_REASON_UNSPECIFIED":
                    raise EmbeddingError("Gemini ended the response.")
        self.generation.check()
        if not finished:
            raise EmbeddingError("Gemini's response ended before completion.")
