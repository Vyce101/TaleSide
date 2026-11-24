import { readArtwork } from "./artwork.js";
import { formData, parseJson, readJson } from "./http-body.js";
import { Personas } from "./personas.js";
import { get, run } from "./sqlite.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { openDatabase } from "./database.js";
import { gemini, type GeminiClient } from "./gemini.js";
import { ProviderKeys, dpapi } from "./keys.js";
import { Profiles } from "./profiles.js";
import { GraphIndexes } from "./graph/indexes.js";
import { json } from "./http-response.js";
import { handleTaleRoute } from "./tales/routes.js";
import { Tales } from "./tales/tales.js";
import { fields, identifier, RequestError, requiredText } from "./validation.js";
import { WorldIndexing } from "./worlds/indexing.js";
import { Worlds } from "./worlds/worlds.js";

const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const distRoot = fileURLToPath(new URL("../", import.meta.url));
const types: Record<string, string> = {
  svg: "image/svg+xml", html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", png: "image/png", ico: "image/x-icon", woff2: "font/woff2", ttf: "font/ttf",
  webmanifest: "application/manifest+json", txt: "text/plain; charset=utf-8",
};
type Options = { provider?: GeminiClient; protect?: typeof dpapi; onBackup?: () => void };

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

async function staticFile(response: ServerResponse, path: string) {
  const browserModule = /^\/(client|shared)\/[a-z0-9/-]+\.js$/i.test(path);
  if (path !== "/" && !browserModule && path !== "/styles.css" && !path.startsWith("/assets/")) {
    throw new RequestError("Page not found.", 404);
  }
  const root = resolve(browserModule ? distRoot : publicRoot);
  const filename = resolve(root, "." + (path === "/" ? "/index.html" : path));
  if (!filename.startsWith(root + sep) || !await stat(filename).then(info => info.isFile(), () => false)) {
    throw new RequestError("File not found.", 404);
  }
  const contentType = types[filename.split(".").at(-1)!] ?? "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  response.end(await readFile(filename));
}

export async function createApplication(databasePath: string, options: Options = {}) {
  const db = await openDatabase(databasePath, options.onBackup);
  try {
    const provider = options.provider ?? gemini;
    const keys = new ProviderKeys(db, options.protect);
    const graphIndexes = new GraphIndexes(db, databasePath);
    const indexing = new WorldIndexing(db, keys, provider, graphIndexes);
    const worlds = new Worlds(db, keys, graphIndexes, indexing);
    const profiles = new Profiles(db, keys);
    const personas = new Personas(db);
    const tales = new Tales(db, worlds, profiles, keys, provider, graphIndexes, databasePath, personas);

    async function handle(request: IncomingMessage, response: ServerResponse, origin: string) {
      response.setHeader("X-Content-Type-Options", "nosniff");
      const host = new URL(origin).host;
      const requestOrigin = request.headers.origin;
      if (request.headers.host !== host || (requestOrigin && requestOrigin !== origin)
        || (request.method === "POST" && requestOrigin !== origin)) throw new RequestError("This request must come from TaleSide.", 403);
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new RequestError("Invalid request URL.", 400);
      let path: string;
      try { path = decodeURIComponent(url.pathname); }
      catch { throw new RequestError("Invalid request URL."); }
      if (path.includes("\\") || path.includes("\0")) throw new RequestError("Invalid request URL.");
      const getRequest = request.method === "GET";
      if (!getRequest && request.method !== "POST") throw new RequestError("Method not allowed.", 405);

      if (getRequest) {
        if (path === "/api/instance") return json(response, { app: "TaleSide", runtime: "node" });
        if (path === "/api/worlds") return json(response, worlds.list());
        if (path === "/api/settings") return json(response, keys.settings());
        if (path === "/api/tale-settings") return json(response, profiles.view());
        if (path === "/api/app-settings") {
          return json(response, { warn_signatures: get<{ warn_signatures: number }>(db,
            "SELECT warn_signatures FROM app_settings WHERE id = 1")?.warn_signatures !== 0 });
        }
        if (path === "/api/personas") {
          const world = url.searchParams.get("world");
          return json(response, personas.view(world === null ? null : identifier(world)));
        }
        if (path === "/create" || path.startsWith("/worlds/")) {
          response.writeHead(302, { Location: "/" });
          return response.end();
        }
        if (!path.startsWith("/api/")) return staticFile(response, path);
      }

      if (!getRequest && path === "/api/app-settings") {
        const { warn_signatures } = await readJson(request);
        if (typeof warn_signatures !== "boolean") throw new RequestError("Choose whether to warn before clearing signatures.");
        run(db, "INSERT OR REPLACE INTO app_settings (id, warn_signatures) VALUES (1, ?)", Number(warn_signatures));
        return json(response, { warn_signatures });
      }
      const portrait = /^\/api\/(personas|persona-artwork)\/([a-f0-9]{32})(?:\/artwork)?$/.exec(path);
      if (getRequest && portrait?.[1] === "persona-artwork") {
        const artwork = personas.artwork(portrait[2]);
        if (!artwork) throw new RequestError("Artwork not found.", 404);
        response.writeHead(200, { "Content-Type": artwork.content_type, "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Security-Policy": "sandbox; default-src 'none'" });
        return response.end(artwork.image);
      }
      if (!getRequest && portrait?.[1] === "personas" && path.endsWith("/artwork")) {
        const artwork = await readArtwork((await formData(request)).get("artwork"));
        if (!artwork) throw new RequestError("Choose a Persona image.");
        return json(response, personas.portrait(portrait[2], artwork));
      }
      const personaAction = /^\/api\/personas\/(create|save|default|delete)$/.exec(path);
      if (!getRequest && personaAction) return json(response, personas.change(personaAction[1], await readJson(request)));

      if (await handleTaleRoute(request, response, path, url.searchParams, tales, () => closing)) return;

      const world = /^\/api\/worlds\/([a-f0-9]{32})(?:\/([a-z-]+))?$/.exec(path);
      if (world) {
        const [, id, action] = world;
        if (getRequest && !action) return json(response, worlds.detail(id));
        if (getRequest && action === "artwork") {
          const artwork = worlds.artwork(id);
          if (!artwork) throw new RequestError("Artwork not found.", 404);
          response.writeHead(200, { "Content-Type": artwork.content_type, "Cache-Control": "no-cache",
            "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
          return response.end(artwork.image);
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
              tales.discardWorld(id);
              return json(response, { ok: true });
            default: throw new RequestError("Action not found.", 404);
          }
          return json(response, worlds.detail(id));
        }
      }

      const profile = /^\/api\/chat-profiles\/(select|create|save|rename|delete)$/.exec(path);
      if (!getRequest && profile) return json(response, profiles.change(profile[1], await readJson(request)));
      if (!getRequest && path === "/api/provider-keys") {
        const input = await readJson(request);
        return json(response, keys.add(input.nickname, input.secret), 201);
      }
      const key = /^\/api\/provider-keys\/([a-f0-9]{32})\/(delete-impact|rename|replace|delete)$/.exec(path);
      if (key) {
        const [, id, action] = key;
        if (getRequest && action === "delete-impact") return json(response, keys.impact(id));
        if (!getRequest && action !== "delete-impact") {
          const input = await readJson(request);
          if (action === "rename") keys.rename(id, input.nickname);
          else if (action === "replace") keys.replace(id, input.secret);
          else keys.delete(id, input.impact);
          return json(response, { ok: true });
        }
      }
      throw new RequestError("Page not found.", 404);
    }

    const inFlight = new Set<Promise<void>>();
    let closing = false;
    return {
      handle(request: IncomingMessage, response: ServerResponse, origin: string) {
        if (closing) { json(response, { error: "TaleSide is closing." }, 503); return; }
        const pending = handle(request, response, origin).then(() => {}).catch(error => {
          if (response.destroyed) return;
          if (response.headersSent) { response.end(); return; }
          if (error instanceof RequestError) json(response, { error: error.message }, error.status);
          else {
            json(response, { error: "Could not complete the local request." }, 500);
          }
        }).finally(() => inFlight.delete(pending));
        inFlight.add(pending);
      },
      async close() {
        closing = true;
        await Promise.all([indexing.close(), tales.close()]);
        await Promise.allSettled(inFlight);
        await graphIndexes.close();
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function listen(port: number) {
  const server = createServer();
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      ready();
    });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin };
}
