import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readLongTermMemoryUsage, recordLongTermMemoryInjection } from "../usage.js";
import type { LtmBudgetedChunk } from "../budget.js";

function budgetedChunk(id: string, tokens = 100): LtmBudgetedChunk {
  return {
    chunk: { id, noteId: "note_1", sectionKey: "sec", text: "text", sourceHash: "h", noteType: "character", status: "active", tags: [], scope: {}, updatedAt: new Date().toISOString() },
    score: 1, normalizedScore: 1, finalNormalizedScore: 1, reasons: [], lanes: [],
    tier: 1, estimatedTokens: tokens,
  };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ltm-usage-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("readLongTermMemoryUsage — empty/missing file returns empty state", async () => {
  await withTempRoot(async (root) => {
    const usage = await readLongTermMemoryUsage(root);
    assert.deepEqual(usage.chunks, {});
  });
});

test("readLongTermMemoryUsage — write + read round-trip", async () => {
  await withTempRoot(async (root) => {
    await recordLongTermMemoryInjection([budgetedChunk("chunk_a")], root);
    const usage = await readLongTermMemoryUsage(root);
    const entry = usage.chunks.chunk_a;
    assert.ok(entry);
    assert.equal(entry.injectionCount, 1);
    assert.equal(entry.retrievalCount, 1);
  });
});

test("readLongTermMemoryUsage — concurrent writes don't corrupt", async () => {
  await withTempRoot(async (root) => {
    const ids = Array.from({ length: 10 }, (_, i) => `chunk_${i}`);
    await Promise.all(ids.map((id) => recordLongTermMemoryInjection([budgetedChunk(id, 50)], root)));
    const usage = await readLongTermMemoryUsage(root);
    assert.equal(Object.keys(usage.chunks).length, 10);
  });
});

test("readLongTermMemoryUsage — lastInjectedAt timestamp persists correctly", async () => {
  await withTempRoot(async (root) => {
    await recordLongTermMemoryInjection([budgetedChunk("chunk_a")], root);
    const usage = await readLongTermMemoryUsage(root);
    const entry = usage.chunks.chunk_a;
    assert.ok(entry);
    assert.ok(entry.lastInjectedAt);
    assert.ok(new Date(entry.lastInjectedAt).getTime() > 0);
  });
});

test("readLongTermMemoryUsage — old entries still readable", async () => {
  await withTempRoot(async (root) => {
    await recordLongTermMemoryInjection([budgetedChunk("chunk_old")], root);
    const usage = await readLongTermMemoryUsage(root);
    const entry = usage.chunks.chunk_old;
    assert.ok(entry);
    assert.equal(entry.chunkId, "chunk_old");
  });
});
