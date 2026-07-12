import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  longTermMemoryInjectionReceiptPath,
  longTermMemoryUsagePath,
  readLongTermMemoryInjectionReceipt,
  readLongTermMemoryUsage,
  recordLongTermMemoryInjection,
} from "../usage.js";
import type { LtmBudgetedChunk } from "../budget.js";

function budgetedChunk(id: string, tokens = 100): LtmBudgetedChunk {
  return {
    chunk: {
      id,
      noteId: "note_1",
      sectionKey: "sec",
      text: "text",
      sourceHash: "h",
      noteType: "character",
      status: "active",
      tags: [],
      keywords: [],
      scope: {},
      updatedAt: new Date().toISOString(),
    },
    score: 1,
    normalizedScore: 1,
    finalNormalizedScore: 1,
    reasons: [],
    lanes: [],
    tier: 1,
    estimatedTokens: tokens,
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

function record(chatId: string, chunks: LtmBudgetedChunk[], root: string, serializedTokenCount = 128) {
  return recordLongTermMemoryInjection({ chatId, chunks, serializedTokenCount }, root);
}

test("readLongTermMemoryUsage - empty/missing file returns chat-scoped empty state", async () => {
  await withTempRoot(async (root) => {
    const usage = await readLongTermMemoryUsage(root);
    assert.deepEqual(usage.chats, {});
  });
});

test("recordLongTermMemoryInjection - usage and receipt round-trip by chat", async () => {
  await withTempRoot(async (root) => {
    await record("chat_a", [budgetedChunk("chunk_a", 37)], root, 52);

    const usage = await readLongTermMemoryUsage(root);
    const entry = usage.chats.chat_a?.chunks.chunk_a;
    assert.ok(entry);
    assert.equal(entry.injectionCount, 1);
    assert.equal(entry.retrievalCount, 1);

    const receipt = await readLongTermMemoryInjectionReceipt("chat_a", root);
    assert.ok(receipt);
    assert.equal(receipt.serializedTokenCount, 52);
    assert.deepEqual(receipt.chunks, [
      { chunkId: "chunk_a", noteId: "note_1", sectionKey: "sec", tokenCount: 37 },
    ]);
  });
});

test("recordLongTermMemoryInjection - cooldown usage is keyed by chat and chunk", async () => {
  await withTempRoot(async (root) => {
    await record("chat_a", [budgetedChunk("chunk_shared", 10)], root);
    await record("chat_b", [budgetedChunk("chunk_shared", 20)], root);

    const usage = await readLongTermMemoryUsage(root);
    assert.equal(usage.chats.chat_a?.chunks.chunk_shared?.totalInjectedTokens, 10);
    assert.equal(usage.chats.chat_b?.chunks.chunk_shared?.totalInjectedTokens, 20);
  });
});

test("recordLongTermMemoryInjection - concurrent writes do not corrupt one chat", async () => {
  await withTempRoot(async (root) => {
    const ids = Array.from({ length: 10 }, (_, index) => `chunk_${index}`);
    await Promise.all(ids.map((id) => record("chat_a", [budgetedChunk(id, 50)], root)));
    const usage = await readLongTermMemoryUsage(root);
    assert.equal(Object.keys(usage.chats.chat_a?.chunks ?? {}).length, 10);
  });
});

test("readLongTermMemoryUsage - v1 records remain readable without becoming global cooldowns", async () => {
  await withTempRoot(async (root) => {
    await record("chat_seed", [budgetedChunk("chunk_seed")], root);
    const now = new Date().toISOString();
    const path = longTermMemoryUsagePath(root);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        chunks: {
          chunk_old: {
            chunkId: "chunk_old",
            noteId: "note_old",
            sectionKey: "sec",
            lastRetrievedAt: now,
            lastInjectedAt: now,
            retrievalCount: 1,
            injectionCount: 1,
            totalInjectedTokens: 11,
          },
        },
      }),
      "utf8",
    );

    const usage = await readLongTermMemoryUsage(root);
    assert.equal(usage.legacyChunks?.chunk_old?.chunkId, "chunk_old");
    assert.deepEqual(usage.chats, {});
  });
});

test("malformed usage and receipt files are quarantined without throwing", async () => {
  await withTempRoot(async (root) => {
    await record("chat_a", [budgetedChunk("chunk_seed")], root);
    await writeFile(longTermMemoryUsagePath(root), "{not-json", "utf8");
    const usage = await readLongTermMemoryUsage(root);
    assert.deepEqual(usage.chats, {});

    await writeFile(longTermMemoryInjectionReceiptPath("chat_a", root), "{not-json", "utf8");
    assert.equal(await readLongTermMemoryInjectionReceipt("chat_a", root), null);

    const quarantine = await readdir(join(root, "quarantine"), { withFileTypes: true });
    assert(quarantine.some((entry) => entry.name === "indexes"));
    assert(quarantine.some((entry) => entry.name === "receipts"));
  });
});

test("receipt chat ID mismatches are quarantined instead of being treated as another chat's receipt", async () => {
  await withTempRoot(async (root) => {
    await record("chat_a", [budgetedChunk("chunk_a")], root);
    const chatAReceipt = await readFile(longTermMemoryInjectionReceiptPath("chat_a", root), "utf8");
    await writeFile(longTermMemoryInjectionReceiptPath("chat_b", root), chatAReceipt, "utf8");

    assert.equal(await readLongTermMemoryInjectionReceipt("chat_b", root), null);
    const receipts = await readdir(join(root, "quarantine", "receipts"));
    assert.equal(receipts.length, 1);
  });
});
