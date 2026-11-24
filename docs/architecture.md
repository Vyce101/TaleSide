# TaleSide architecture

[`Start TaleSide.cmd`](../Start%20TaleSide.cmd) builds TypeScript and starts [`src/server/main.ts`](../src/server/main.ts). The local Node server opens a browser and uses [`http.ts`](../src/server/http.ts) to serve the app and dispatch same-origin requests. The browser starts in [`src/client/app.ts`](../src/client/app.ts), which coordinates navigation, drawers, and updates between features. Worlds and Tales each have browser and server folders. Graph indexing and search live on the server.

SQLite under `data/` is the shared source of truth for Worlds, books, indexing progress, and Tales. [`database.ts`](../src/server/database.ts) opens, backs up, and migrates it. Runtime queries use [`sqlite.ts`](../src/server/sqlite.ts). Node calls Gemini and starts the Python worker for book preparation and passage retrieval. A separate Node worker reads and builds the graph index files beside the database.

## Import a World

1. The [World editor](../src/client/worlds/editor.ts) submits settings and original files to the [World routes](../src/server/worlds/routes.ts).
2. The [World service](../src/server/worlds/worlds.ts) validates settings and uses [book preparation](../src/server/worlds/books.ts) to call the [Python worker](../taleside/node_worker.py). Python extracts and chunks the text. The World service stores the originals and prepared chunks before waking the indexing queue.
3. [World indexing](../src/server/worlds/indexing.ts) runs passage embedding and [graph extraction](../src/server/graph/jobs.ts) concurrently. A Tale can use the first completed passage immediately. Graph notes become available when the finished graph generation is published.

## Open a Tale and send a reply

1. The [Tale lists](../src/client/tales/lists.ts) manage Recent Tales, World history, and search. The [Tale workspace](../src/client/tales/workspace.ts) holds the open Tale and its unsent draft. The [browser reply controller](../src/client/tales/reply.ts) posts a turn and applies streamed events.
2. The [Tale routes](../src/server/tales/routes.ts) connect the [NDJSON response](../src/server/http-response.ts) to the [Tale service](../src/server/tales/tales.ts). Before accepting the turn, [reply context](../src/server/tales/reply-context.ts) opens a read snapshot and checks the current World revision. It also pins the published graph when retrieval uses one.
3. Python ranks passages from the snapshot and [builds the Gemini request](../taleside/chat_request.py). The [server reply stream](../src/server/tales/reply-stream.ts) handles provider retries and thought signatures. The Tale service saves the final reply or the partial reply received before Stop or disconnect.

## Pause and resume indexing

The World routes send pause and resume to [World indexing](../src/server/worlds/indexing.ts). Pause lets the work already in progress finish. Resume checks key assignments and picks up from the saved chunks and graph records. The browser polls while a World is creating or pausing, and paints progress in the World editor.

## Verify the flows

Run `npm test` and `python -B -m unittest discover -s tests -v` from the repository root. The Node tests exercise the local HTTP API with a temporary database and a fake provider.

| Behavior | Tests |
| --- | --- |
| Import, edit books, pause, and resume | [Worlds](../src/tests/worlds.test.ts) and [Python book preparation](../tests/test_books.py) |
| Publish a graph and reuse it after book edits | [Graph](../src/tests/graph.test.ts) |
| Find a Tale, hold a reply snapshot, and save a partial reply | [Search](../src/tests/search.test.ts) and [Tales](../src/tests/tales.test.ts) |
| Retry provider failures and reopen existing data | [Provider errors](../src/tests/provider-errors.test.ts) and [Migration](../src/tests/migration.test.ts) |
