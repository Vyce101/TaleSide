"""Run local book preparation and passage retrieval for the Node server."""

import base64
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from threading import Event

from .books import BookSource, prepare_book
from .tale_retrieval import chat_request, passages


def read():
    return json.loads(sys.stdin.readline())


def send(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def prepare(request):
    prepared = []
    for book in request["books"]:
        source = BookSource(book["filename"], base64.b64decode(book["original"], validate=True), book["name"])
        working, encoding, bom_size, chunks = prepare_book(source, request["size"])
        prepared.append({
            "working": working,
            "encoding": encoding,
            "bomSize": bom_size,
            "chunks": [
                {"start": chunk.start, "end": chunk.end, "originalStart": chunk.original_start, "originalEnd": chunk.original_end}
                for chunk in chunks
            ],
        })
    send({"books": prepared})


def retrieve(request):
    path = Path(request["database"]).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(path, uri=True)) as database:
        database.row_factory = sqlite3.Row
        database.execute("BEGIN")
        world = database.execute("""
            SELECT id, name, status, model, dimensions, max_token_limit, max_chunk_size,
                   index_number, book_revision FROM worlds WHERE id = ? AND status != 'draft'
        """, (request["worldId"],)).fetchone()
        if world is None:
            send({"error": "This World could not be found.", "status": 404})
            return
        books = database.execute("SELECT number, name FROM books WHERE world_id = ? ORDER BY number", (world["id"],))
        books = [dict(book) for book in books]
        send({"world": dict(world)})
        query = read()
        settings = query["settings"]
        excerpts = passages(database, world, query["vector"], settings, Event())
        for message in query["history"]:
            if message.get("signed_parts"):
                message["signed_parts"] = json.loads(message["signed_parts"])
        send({"payload": chat_request(world, books, excerpts, query["history"], settings)})


def main():
    operation = sys.argv[1]
    try:
        request = read()
        if operation == "prepare":
            prepare(request)
        elif operation == "retrieve":
            retrieve(request)
        else:
            send({"error": "Unknown Python operation.", "status": 500})
    except (ValueError, KeyError) as error:
        if operation == "prepare":
            send({"error": str(error), "status": 400})
        else:
            send({"error": "Python could not retrieve passages.", "status": 500})
    except (OSError, sqlite3.Error):
        send({"error": "Python could not read the local World.", "status": 500})


if __name__ == "__main__":
    main()
