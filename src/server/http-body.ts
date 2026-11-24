import type { IncomingMessage } from "node:http";
import { fields, RequestError } from "./validation.js";

const MAX_BODY_BYTES = 256 * 1024 * 1024;

async function body(request: IncomingMessage, limit: number) {
  const length = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(length) || length < 0) throw new RequestError("The body needs a valid length.");
  if (length > limit) throw new RequestError("The upload is too large.", 413);
  const bytes: Buffer[] = [];
  let received = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > length) throw new RequestError("The upload is too large.", 413);
    bytes.push(chunk);
  }
  if (received !== length) throw new RequestError("The upload is incomplete.");
  return Buffer.concat(bytes, received);
}

export function parseJson(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new RequestError("The request contains invalid JSON."); }
  return fields(value);
}

export async function readJson(request: IncomingMessage) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new RequestError("Expected JSON.");
  return parseJson((await body(request, MAX_BODY_BYTES)).toString("utf8"));
}

export async function formData(request: IncomingMessage) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data;")) throw new RequestError("Send files and settings together.");
  const bytes = await body(request, MAX_BODY_BYTES);
  try {
    return await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new RequestError("The upload is incomplete.");
  }
}
