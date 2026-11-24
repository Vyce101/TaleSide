import type { ServerResponse } from "node:http";
import type { GenerationEvent } from "../shared/types.js";

export function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
  return true;
}

export async function streamGeneration(response: ServerResponse,
  generate: (emit: (event: GenerationEvent) => void) => Promise<void>, stop: () => void) {
  response.once("close", () => {
    if (!response.writableEnded) stop();
  });
  await generate(event => {
    if (response.destroyed) {
      stop();
      return;
    }
    if (!response.headersSent) response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    response.write(JSON.stringify(event) + "\n");
  });
  response.end();
  return true;
}
