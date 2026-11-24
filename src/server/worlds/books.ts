import { pythonWorker } from "../python.js";

export type BookInput = { filename: string; name: string; original: Uint8Array };
type Chunk = { start: number; end: number; originalStart: number; originalEnd: number };
type PreparedText = { working: string; encoding: string; bomSize: number; chunks: Chunk[] };
export type StoredBook = BookInput & { id: string; number: number; working: string; encoding: string; bom_size: number };
export type PreparedBook = BookInput & PreparedText;

export const DEFAULT_CHUNK_SIZE = 8000;

export function normalizeLines(text: string) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function decode(bytes: Uint8Array, encoding: string) {
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function prepareBooks(books: BookInput[], size: number): Promise<PreparedBook[]> {
  if (!books.length) return [];
  const worker = pythonWorker("prepare");
  try {
    await worker.send({ size, books: books.map(({ filename, name, original }) => ({
      filename, name, original: Buffer.from(original).toString("base64"),
    })) });
    const result = await worker.receive<{ books: PreparedText[] }>();
    return books.map((book, index) => ({ ...book, ...result.books[index] }));
  } finally { worker.close(); }
}
