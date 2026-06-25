import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeLtmText, buildLtmBm25Index, searchLtmBm25 } from "../bm25.js";
import type { LtmMemoryChunk } from "../chunking.js";

function chunk(text: string, id = "test"): LtmMemoryChunk {
  return { id, noteId: "note_1", sectionKey: "section", text, sourceHash: "hash", noteType: "character", status: "active", tags: [], keywords: [], scope: {}, updatedAt: new Date().toISOString() };
}

test("tokenizeLtmText — lowercases, filters length-1 tokens", () => {
  const tokens = tokenizeLtmText("The quick brown fox jumps");
  assert.ok(tokens.every((t) => t.length > 1));
  assert.ok(tokens.includes("the"));
  assert.ok(tokens.includes("quick"));
});

test("tokenizeLtmText — handles Unicode word chars", () => {
  const tokens = tokenizeLtmText("café déjà vu");
  assert.ok(tokens.includes("café"));
  assert.ok(tokens.includes("déjà"));
});

test("buildLtmBm25Index — computes correct avgDocLength", () => {
  const index = buildLtmBm25Index([chunk("hello world", "a"), chunk("hello there world", "b")]);
  assert.equal(index.chunkCount, 2);
  assert.equal(index.avgDocLength, 2.5);
  const helloTerm = index.terms.hello!;
  assert.equal(helloTerm.documentFrequency, 2);
});

test("searchLtmBm25 — rare term scores higher than common term", () => {
  const chunks = [
    chunk("apple banana apple banana apple", "c1"),
    chunk("banana fruit", "c2"),
    chunk("rare zebra", "c3"),
  ];
  const index = buildLtmBm25Index(chunks);
  const results = searchLtmBm25(index, "zebra");
  assert.ok(results.length > 0);
  assert.equal(results[0]!.chunkId, "c3");
});

test("searchLtmBm25 — empty index returns []", () => {
  const index = buildLtmBm25Index([]);
  assert.deepEqual(searchLtmBm25(index, "query"), []);
});

test("searchLtmBm25 — no matching terms returns []", () => {
  const index = buildLtmBm25Index([chunk("hello world")]);
  assert.deepEqual(searchLtmBm25(index, "zzzmissing"), []);
});

test("searchLtmBm25 — topK truncation", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => chunk(`word ${i}`, `c${i}`));
  const index = buildLtmBm25Index(chunks);
  const results = searchLtmBm25(index, "word", { topK: 3 });
  assert.equal(results.length, 3);
});

test("searchLtmBm25 — tie-breaking by chunkId", () => {
  const chunks = [chunk("the same text", "b"), chunk("the same text", "a")];
  const index = buildLtmBm25Index(chunks);
  const results = searchLtmBm25(index, "same");
  assert.equal(results[0]!.chunkId, "a");
  assert.equal(results[1]!.chunkId, "b");
});

test("searchLtmBm25 — BM25 saturation with K1=1.2, B=0.75", () => {
  const short = chunk("word word word word word word word word word word", "short");
  const long = chunk("word " + "padding ".repeat(100) + "word", "long");
  const index = buildLtmBm25Index([short, long]);
  const results = searchLtmBm25(index, "word");
  const shortResult = results.find((r) => r.chunkId === "short");
  const longResult = results.find((r) => r.chunkId === "long");
  assert.ok(shortResult);
  assert.ok(longResult);
  assert.ok(shortResult!.score > longResult!.score, "Short doc with higher term density should score higher");
});
