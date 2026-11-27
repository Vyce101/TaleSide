import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { MessageContext, RequestCaptureTrace } from "../../shared/inspectors.js";
import { all, get, run } from "../sqlite.js";

export const requestCaptureSchema = `
  ALTER TABLE tale_messages ADD COLUMN xray_id INTEGER;
  CREATE TABLE xray_captures (
    id INTEGER PRIMARY KEY, model TEXT NOT NULL, input_tokens INTEGER, characters INTEGER NOT NULL,
    body BLOB NOT NULL, trace BLOB NOT NULL
  );
  CREATE TABLE xray_owners (
    message_id INTEGER NOT NULL REFERENCES tale_messages ON DELETE CASCADE,
    capture_id INTEGER NOT NULL REFERENCES xray_captures ON DELETE CASCADE,
    PRIMARY KEY (message_id, capture_id)
  );
  CREATE INDEX xray_owners_capture ON xray_owners(capture_id);
  CREATE TABLE xray_blobs (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, content BLOB NOT NULL);
  CREATE TABLE xray_blob_refs (
    capture_id INTEGER NOT NULL REFERENCES xray_captures ON DELETE CASCADE,
    blob_id INTEGER NOT NULL REFERENCES xray_blobs,
    PRIMARY KEY (capture_id, blob_id)
  );
  CREATE INDEX xray_refs_blob ON xray_blob_refs(blob_id);
  CREATE TRIGGER xray_remove_capture AFTER DELETE ON xray_owners BEGIN
    DELETE FROM xray_captures WHERE id = OLD.capture_id
      AND NOT EXISTS (SELECT 1 FROM xray_owners WHERE capture_id = OLD.capture_id);
  END;
  CREATE TRIGGER xray_remove_blob AFTER DELETE ON xray_blob_refs BEGIN
    DELETE FROM xray_blobs WHERE id = OLD.blob_id
      AND NOT EXISTS (SELECT 1 FROM xray_blob_refs WHERE blob_id = OLD.blob_id);
  END;
`;

type RequestCapture = {
  model: string;
  inputTokens: number | null;
  characters: number;
  payload: object;
  trace: RequestCaptureTrace;
};

export function trySaveRequestCapture(db: DatabaseSync, capture: RequestCapture): number | undefined {
  // Capture is optional. If it fails, roll back its blobs without rolling back the reply.
  db.exec("SAVEPOINT reply_xray");
  try {
    return saveRequestCapture(db, capture);
  } catch {
    db.exec("ROLLBACK TO reply_xray");
    return undefined;
  } finally {
    db.exec("RELEASE reply_xray");
  }
}

function saveRequestCapture(db: DatabaseSync, { model, inputTokens, characters, payload, trace }: RequestCapture) {
  const { retrieved_parts: retrievedParts, ...savedTrace } = trace;
  const retrievedText = retrievedParts.join("");
  const blobReferences = new Set<number>();
  const blobIdsByText = new Map<string, number>();
  function storeText(value: string) {
    const known = blobIdsByText.get(value);
    if (known !== undefined) return known;
    // Encode the JSON string so even a lone surrogate can round-trip exactly.
    const encoded = Buffer.from(JSON.stringify(value));
    const hash = createHash("sha256").update(encoded).digest("hex");
    const existing = get<{ id: number }>(db, "SELECT id FROM xray_blobs WHERE hash = ?", hash);
    const id = existing?.id ?? Number(run(db, "INSERT INTO xray_blobs (hash, content) VALUES (?, ?)", hash,
      deflateRawSync(encoded)).lastInsertRowid);
    blobReferences.add(id);
    blobIdsByText.set(value, id);
    return id;
  }

  function encodeTextReferences(key: string, value: unknown) {
    if (typeof value !== "string" || !value || !["text", "preceding", "thinking", "description", "thoughtSignature"].includes(key)) return value;
    const isRetrievedContext = key === "text" && retrievedParts.length > 1 && value === retrievedText;
    const textParts = isRetrievedContext ? retrievedParts : [value];
    return { blob_ids: textParts.map(storeText) };
  }
  const sources = Object.fromEntries(Object.entries(savedTrace.sources).map(([label, text]) =>
    [label, { blob_ids: [storeText(text)] }]));
  const bodyManifest = deflateRawSync(JSON.stringify(payload, encodeTextReferences));
  const traceManifest = deflateRawSync(JSON.stringify({ ...savedTrace, sources }, encodeTextReferences));
  const insert = run(db, "INSERT INTO xray_captures (model, input_tokens, characters, body, trace) VALUES (?, ?, ?, ?, ?)",
    model, inputTokens, characters, bodyManifest, traceManifest);
  const captureId = Number(insert.lastInsertRowid);
  const reference = db.prepare("INSERT INTO xray_blob_refs VALUES (?, ?)");
  for (const blobId of blobReferences) reference.run(captureId, blobId);
  return captureId;
}

export function syncMessageCaptures(db: DatabaseSync, messageId: number, captures: (number | null | undefined)[]) {
  const add = db.prepare("INSERT OR IGNORE INTO xray_owners VALUES (?, ?)");
  const keep = captures.filter((id): id is number => id != null);
  for (const id of keep) add.run(messageId, id);
  run(db, "DELETE FROM xray_owners WHERE message_id = ? AND capture_id NOT IN (SELECT value FROM json_each(?))",
    messageId, JSON.stringify(keep));
}

function unpackManifest(value: Uint8Array | string, decode?: (key: string, value: unknown) => unknown) {
  return JSON.parse(typeof value === "string" ? value : inflateRawSync(value).toString("utf8"), decode);
}

export function removeReplacedGraphPreview(db: DatabaseSync, captureId: number, messageId: number) {
  // An unshared capture is deleted by the owner trigger when this swipe is replaced.
  const row = get<{ trace: Uint8Array | string }>(db, `
    SELECT trace FROM xray_captures WHERE id = ? AND EXISTS (
      SELECT 1 FROM xray_owners WHERE capture_id = ? AND message_id <> ?
    )
  `, captureId, captureId, messageId);
  if (!row) return;
  const trace = unpackManifest(row.trace);
  if (trace.graph_preview?.message_id !== messageId) return;
  delete trace.graph_preview;
  run(db, "UPDATE xray_captures SET trace = ? WHERE id = ?", deflateRawSync(JSON.stringify(trace)), captureId);
}

export function readRequestCapture(db: DatabaseSync, id: number): MessageContext | undefined {
  const row = get<{ model: string; input_tokens: number | null; characters: number; body: Uint8Array | string; trace: Uint8Array | string }>(
    db, "SELECT model, input_tokens, characters, body, trace FROM xray_captures WHERE id = ?", id);
  if (!row) return;
  const blobs = new Map(all<{ id: number; content: Uint8Array }>(db, `
    SELECT b.id, b.content FROM xray_blob_refs r JOIN xray_blobs b ON b.id = r.blob_id WHERE r.capture_id = ?
  `, id).map(blob => [blob.id, JSON.parse(inflateRawSync(blob.content).toString("utf8")) as string]));
  const decode = (_key: string, value: unknown) => {
    if (!value || typeof value !== "object" || !("blob_ids" in value)) return value;
    return (value.blob_ids as number[]).map(blobId => {
      const content = blobs.get(blobId);
      if (content === undefined) throw new Error("The saved request is incomplete.");
      return content;
    }).join("");
  };
  return {
    model: row.model, input_tokens: row.input_tokens, characters: row.characters,
    raw: JSON.stringify(unpackManifest(row.body, decode)),
    trace: unpackManifest(row.trace, decode),
  };
}
