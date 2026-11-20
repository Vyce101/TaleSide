import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { prepareBooks } from "../server/books.js";

test("TXT chunks preserve CRLF, Unicode character positions and original bytes", async () => {
  const original = Buffer.from("\uFEFFaé\r\n📕b\r\nc", "utf8");
  const [book] = await prepareBooks([{ name: "Book", filename: "book.TXT", original }], 3, 2);
  equal(book.working, "aé\n📕b\nc");
  equal(book.bomSize, 3);
  equal(book.original, original);
  deepEqual(book.chunks, [
    { start: 0, end: 3, originalStart: 3, originalEnd: 8 },
    { start: 3, end: 6, originalStart: 8, originalEnd: 15 },
    { start: 6, end: 7, originalStart: 15, originalEnd: 16 },
  ]);
});

test("chunking prefers paragraphs over nearer punctuation and rejects malformed TXT", async () => {
  const [book] = await prepareBooks([{ name: "Book", filename: "book.txt", original: Buffer.from("A.\n\nB. C. D.") }], 10, 7);
  equal(book.chunks[0].end, 4);
  for (const original of [Buffer.from(" \n"), Buffer.from([0xf5]), Buffer.from([0, 65])]) {
    await rejects(prepareBooks([{ name: "Book", filename: "book.txt", original }], 10, 1), /book.txt/);
  }
  await rejects(prepareBooks([{ name: "Book", filename: "../book.txt", original: Buffer.from("text") }], 10, 1), /without a directory/);
});
