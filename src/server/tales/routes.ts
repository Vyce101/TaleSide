import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson } from "../http-body.js";
import { json, streamGeneration } from "../http-response.js";
import { identifier, RequestError, whole } from "../validation.js";
import type { Tales } from "./tales.js";

export async function handleTaleRoute(request: IncomingMessage, response: ServerResponse, path: string,
  searchParams: URLSearchParams, tales: Tales, isClosing: () => boolean) {
  const getRequest = request.method === "GET";
  if (getRequest) {
    if (path === "/api/tales") return json(response, tales.list());
    if (path === "/api/tales/search") {
      const query = searchParams.get("q") ?? "";
      if (query.length > 512) throw new RequestError("Use 512 characters or fewer to search Tales.");
      const world = searchParams.get("world");
      return json(response, tales.search(query, world === null ? null : identifier(world)));
    }
  }

  const tale = /^\/api\/worlds\/([a-f0-9]{32})\/tales\/([a-f0-9]{32})(?:\/([a-z-]+))?$/.exec(path);
  if (tale) {
    const [, worldId, id, action] = tale;
    if (getRequest && !action) return json(response, tales.detail(worldId, id));
    if (getRequest && action === "xray") {
      const message = whole(Number(searchParams.get("message")), 1, "Choose a reply.");
      const swipe = whole(Number(searchParams.get("swipe")), 0, "Choose a swipe.");
      return json(response, tales.messageContext(worldId, id, message, swipe));
    }
    if (!getRequest && action === "generate") {
      const input = await readJson(request);
      if (isClosing()) throw new RequestError("TaleSide is closing.", 503);
      const generationId = identifier(input.generation_id);
      return streamGeneration(response,
        emit => tales.begin(worldId, id, input, emit),
        () => tales.stop(worldId, id, generationId));
    }
    if (!getRequest && ["edit-message", "delete-message", "select-swipe", "branch", "persona"].includes(action)) {
      return json(response, tales.changeMessage(worldId, id, action, await readJson(request)));
    }
    if (!getRequest && ["rename", "pin", "delete", "stop"].includes(action)) {
      tales.change(worldId, id, action, await readJson(request));
      return json(response, { ok: true });
    }
  }
  return false;
}
