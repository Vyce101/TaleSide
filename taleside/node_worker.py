"""Run local book preparation and passage retrieval for the Node server."""

import base64
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from threading import Event

from .books import BookSource, prepare_book
from .chat_request import chat_request
from .tale_retrieval import passage_prompt_parts, passages


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


def read_graph_sources(database, world, graph):
    if not graph:
        return {}
    labels = dict.fromkeys(
        match.group() for note in graph["trace"]
        for match in re.finditer(r"\bB[1-9][0-9]{0,8}:C[1-9][0-9]{0,8}\b", note["description"])
    )
    sources = {}
    for label in labels:
        book, chunk = map(int, label[1:].split(":C"))
        row = database.execute("""
            SELECT substr(b.working, c.start + 1, c.end - c.start)
            FROM books b JOIN chunks c ON c.book_id = b.id
            WHERE b.world_id = ? AND b.number = ? AND c.index_number = ? AND c.number = ?
        """, (world["id"], book, world["index_number"], chunk)).fetchone()
        if row:
            sources[label] = row[0]
    return sources


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
        included, skipped, below_minimum, other_skipped = (
            passages(database, world, query["vector"], settings, Event()) if query["vector"] else ([], [], 0, 0)
        )
        graph = query.get("graph")
        retrieval_trace = dict(chunks=included + skipped, graph=graph["trace"] if graph else [],
                         endpoints=graph["endpoints"] if graph else [], sources=read_graph_sources(database, world, graph),
                         below_minimum=below_minimum, other_skipped_chunks=other_skipped,
                         other_skipped_graph=graph["other_skipped"] if graph else 0)
        passage_parts = passage_prompt_parts(included)
        for message in query["history"]:
            if message.get("signed_parts"):
                message["signed_parts"] = json.loads(message["signed_parts"])
        send(chat_request(world, books, passage_parts, query["history"], settings, query["context"],
                          graph, query["gemma"], retrieval_trace))


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
