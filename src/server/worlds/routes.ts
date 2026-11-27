import type { IncomingMessage, ServerResponse } from "node:http";
import { readArtwork } from "../artwork.js";
import { formData, parseJson, readJson } from "../http-body.js";
import { json } from "../http-response.js";
import { fields, RequestError, requiredText } from "../validation.js";
import type { WorldInspector } from "./inspector.js";
import type { WorldIndexing } from "./indexing.js";
import type { Worlds } from "./worlds.js";

export async function handleWorldRoute(request: IncomingMessage, response: ServerResponse, path: string,
  params: URLSearchParams, worlds: Worlds, indexing: WorldIndexing, inspector: WorldInspector, onDiscard: (id: string) => void) {
  const getRequest = request.method === "GET";
  if (getRequest && path === "/api/worlds") return json(response, worlds.list());

  const world = /^\/api\/worlds\/([a-f0-9]{32})(?:\/([a-z-]+))?$/.exec(path);
  if (world) {
    const [, id, action] = world;
    if (getRequest && !action) return json(response, worlds.detail(id));
    if (getRequest && action.startsWith("inspector")) return json(response, inspector.route(id, action, params));
    if (getRequest && action === "artwork") {
      const artwork = worlds.artwork(id);
      if (!artwork) throw new RequestError("Artwork not found.", 404);
      response.writeHead(200, { "Content-Type": artwork.content_type, "Cache-Control": "no-cache",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
      response.end(artwork.image);
      return true;
    }
    if (!getRequest) {
      if (["create", "add-books"].includes(action)) {
        const { input, books, artwork } = await upload(request);
        return json(response, action === "create" ? await worlds.create(id, input, books, artwork) : await worlds.append(id, input.book_revision, books));
      }
      if (action === "artwork") {
        const artwork = await readArtwork((await formData(request)).get("artwork"));
        if (!artwork) throw new RequestError("Choose a World image.");
        worlds.storeArtwork(id, artwork);
        return json(response, worlds.detail(id));
      }
      const input = await readJson(request);
      switch (action) {
        case "story": return json(response, worlds.saveStory(id, input));
        case "start-index": return json(response, await worlds.saveSettings(id, input, true));
        case "index-settings": return json(response, await worlds.saveSettings(id, input, false));
        case "clear-index": return json(response, worlds.clearIndex(id));
        case "extraction-key": worlds.setKeys(id, "extraction", input.key_ids); break;
        case "book-order":
        case "rename-book":
        case "remove-book": return json(response, worlds.editBooks(id, action, input));
        case "rename": worlds.rename(id, input.name); break;
        case "embedding-key": worlds.setKeys(id, "embedding", input.key_ids); break;
        case "retrieval-key": worlds.setKeys(id, "retrieval", input.key_ids); break;
        case "pause": indexing.pause(id); break;
        case "resume": indexing.resume(id); break;
        case "discard":
          worlds.discard(id);
          indexing.activity.discard(id);
          onDiscard(id);
          return json(response, { ok: true });
        default: throw new RequestError("Action not found.", 404);
      }
      return json(response, worlds.detail(id));
    }
  }
  return false;
}

async function upload(request: IncomingMessage) {
  const form = await formData(request);
  const value = form.get("settings");
  if (typeof value !== "string") throw new RequestError("The upload is missing World settings.");
  const input = parseJson(value);
  const files = form.getAll("book");
  const bookDetails = input.books ?? [];
  if (!Array.isArray(bookDetails) || bookDetails.length !== files.length) throw new RequestError("The book list does not match the upload.");
  const books = await Promise.all(files.map(async (file, index) => {
    if (typeof file === "string" || !file.size) throw new RequestError("Select nonempty TXT files.");
    const item = fields(bookDetails[index]);
    const filename = item.filename;
    if (typeof filename !== "string" || filename !== file.name) throw new RequestError("The book filenames do not match the upload.");
    const name = requiredText(item.name, "Enter a book name up to 100 characters.", 100);
    return { filename, name, original: new Uint8Array(await file.arrayBuffer()) };
  }));
  return { input, books, artwork: await readArtwork(form.get("artwork")) };
}
