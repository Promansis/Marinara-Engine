// ──────────────────────────────────────────────
// LTM Capture & Extraction Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DB } from "../../../db/connection.js";
import { BaseLLMProvider, type ChatMessage, type ChatOptions } from "../../llm/base-provider.js";
import { readLtmDebugLog } from "../debug-log.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import {
  processLongTermMemorySource,
  processLongTermMemorySourceBatch,
} from "../source-processing.js";
import { LongTermMemoryStorage } from "../storage.js";
import { isLtmSourceNote } from "../source-extraction.js";
import {
  withTempRoot,
  makeNote,
  sourceNote,
  worldNote,
  REFERENCE_TS,
} from "./fixtures/ltm-test-harness.js";

class ExtractionProvider extends BaseLLMProvider {
  constructor(private readonly failSourceId?: string) {
    super("http://unused.invalid", "test-key");
  }

  async *chat(messages: ChatMessage[], _options: ChatOptions) {
    const payload = JSON.parse(messages.at(-1)?.content ?? "{}") as {
      sourceNote?: { id?: string };
      requiredEvidence?: string[];
    };
    if (payload.sourceNote?.id === this.failSourceId) throw new Error("Deterministic extraction failure.");
    yield JSON.stringify({
      summary: `Extracted ${payload.sourceNote?.id}`,
      units: [
        {
          id: randomUUID(),
          bucket: "world_fact",
          subjectId: payload.sourceNote?.id?.replace(/^source_/, "") ?? "test_subject",
          subjectNames: [],
          sectionKey: "facts",
          text: `Durable fact from ${payload.sourceNote?.id}.`,
          importance: "major",
          evidence: payload.requiredEvidence ?? [],
          confidence: 0.95,
          salience: 0.9,
          status: "active",
          links: [],
          sourceHash: "0".repeat(64),
          subjectKeys: [],
        },
      ],
    });
  }
}

const unusedDb = {} as DB;

// ═══════════════════════════════════════════════
//  Pure function tests (no temp root needed)
// ═══════════════════════════════════════════════

test("source note factory produces a valid source note", () => {
  const note = sourceNote("source_reaper", "Phase 11: The cobalt key opens the archive.");
  assert.ok(isLtmSourceNote(note));
  assert.equal(note.type, "source");
  assert.ok(note.tags.includes("source_summary"));
});

test("non-source note is not a source note", () => {
  const note = worldNote("world_gate", "The gate key is cobalt.");
  assert.equal(isLtmSourceNote(note), false);
});

// ═══════════════════════════════════════════════
//  Storage-backed tests
// ═══════════════════════════════════════════════

await test("persist and read a note through storage", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const note = worldNote("world_persist", "Persisted world fact.");
    await storage.createNote(note);

    const retrieved = await storage.getNote("world_persist");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "world_persist");
    assert.equal(retrieved.type, "world");

    const section = retrieved.sections["facts"];
    assert.ok(section);
    assert.ok("text" in section);
    assert.equal(section.text, "Persisted world fact.");
  });
});

await test("createNote rejects duplicate IDs", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const note = worldNote("world_dupe", "First.");
    await storage.createNote(note);
    await assert.rejects(() => storage.createNote(note), /already exists/);
  });
});

await test("listNotes returns created notes", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(worldNote("world_list_a", "A"));
    await storage.createNote(worldNote("world_list_b", "B"));

    const all = await storage.listNotes();
    assert.ok(all.length >= 2);

    const ids = new Set(all.map((n) => n.id));
    assert.ok(ids.has("world_list_a"));
    assert.ok(ids.has("world_list_b"));
  });
});

await test("listNotes filter by type", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(worldNote("world_type", "Filter test"));
    await storage.createNote(sourceNote("source_type", "Source filter test"));

    const worlds = await storage.listNotes({ type: "world" });
    assert.ok(worlds.every((n) => n.type === "world"));
    assert.ok(worlds.some((n) => n.id === "world_type"));

    const sources = await storage.listNotes({ type: "source" });
    assert.ok(sources.every((n) => n.type === "source"));
    assert.ok(sources.some((n) => n.id === "source_type"));
  });
});

await test("listNotes filter by status", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(worldNote("world_active", "Active", { status: "active" }));
    await storage.createNote(
      makeNote({ id: "world_resolved", type: "world", status: "resolved" }),
    );

    const active = await storage.listNotes({ status: "active" });
    assert.ok(active.every((n) => n.status === "active"));
    assert.ok(active.some((n) => n.id === "world_active"));

    const resolved = await storage.listNotes({ status: "resolved" });
    assert.ok(resolved.every((n) => n.status === "resolved"));
  });
});

await test("re-reading the same note after storage persistence is stable", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const note = makeNote({
      id: "source_stable",
      type: "source",
      title: "Stable Source",
      tags: ["source_summary", "stable"],
      sections: { source: { text: "Stable content.", updatedAt: REFERENCE_TS } },
    });
    await storage.createNote(note);

    const read1 = await storage.getNote("source_stable");
    const read2 = await storage.getNote("source_stable");
    assert.ok(read1);
    assert.ok(read2);
    assert.equal(read1.id, read2.id);
    assert.equal(read1.type, "source");
  });
});

await test("scoped note is retained after create and list with matching scope", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const note = makeNote({
      id: "world_scoped_alpha",
      type: "world",
      scope: { chatId: "chat_alpha", chatIds: ["chat_alpha"] },
      sections: { facts: { text: "Scoped to alpha.", updatedAt: REFERENCE_TS } },
    });
    await storage.createNote(note);

    const scoped = await storage.listNotes({
      scope: { chatId: "chat_alpha", chatIds: ["chat_alpha"] },
    });
    assert.ok(scoped.some((n) => n.id === "world_scoped_alpha"));
  });
});

await test("source processing persists the draft and marks a completed extraction current", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const source = sourceNote("source_processing_single", "The copper archive is beneath the observatory.");
    await storage.createNote(source);

    const result = await processLongTermMemorySource({
      db: unusedDb,
      sourceNote: source,
      provider: new ExtractionProvider(),
      model: "test-model",
      operationId: randomUUID(),
      applyLowRisk: true,
      root,
    });

    assert.ok(result.draft);
    assert.equal(result.draft.source.sourceNoteId, source.id);
    assert.equal(result.response.mutations.length, 1);
    assert.equal(result.appliedMutationIds.length, 1);
    assert.deepEqual(result.skippedMutationIds, []);
    assert.ok(await storage.getNote("world_processing_single"));
    const currentSource = await storage.getNote(source.id);
    assert.deepEqual(currentSource?.extractionFingerprint, result.draft.source.extractionFingerprint);
  });
});

await test("batch source processing preserves order, retryability, and one batch rebuild", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const first = sourceNote("source_processing_first", "The east tower contains the chart room.");
    const failed = sourceNote("source_processing_failed", "The west tower contains the signal room.");
    const last = sourceNote("source_processing_last", "The north tower contains the archive room.");
    for (const note of [first, failed, last]) await storage.createNote(note);
    const operationId = randomUUID();

    const results = await processLongTermMemorySourceBatch({
      db: unusedDb,
      source: "chats",
      items: [first, failed, last].map((note) => ({
        sourceId: note.id,
        title: note.id,
        note,
        created: true,
      })),
      provider: new ExtractionProvider(failed.id),
      model: "test-model",
      operationId,
      signal: new AbortController().signal,
      concurrency: 3,
      root,
    });

    assert.deepEqual(
      results.map((result) => result.sourceId),
      [first.id, failed.id, last.id],
    );
    assert.deepEqual(
      results.map((result) => result.extractionStatus),
      ["succeeded", "failed", "succeeded"],
    );
    assert.equal(results[1]?.retryable, true);
    assert.equal(results[1]?.draft, null);
    const drafts = await new LongTermMemoryDraftStore(root).listDrafts();
    assert.equal(drafts.length, 2);
    const events = await readLtmDebugLog({ operationId, limit: 100 }, root);
    assert.equal(events.filter((event) => event.action === "import_batch_rebuild").length, 1);
  });
});

await test("batch source processing returns retryable cancellation outcomes for a pre-aborted request", async () => {
  await withTempRoot(async (root) => {
    const storage = new LongTermMemoryStorage(root);
    const first = sourceNote("source_cancelled_first", "First cancelled source.");
    const last = sourceNote("source_cancelled_last", "Last cancelled source.");
    for (const note of [first, last]) await storage.createNote(note);
    const controller = new AbortController();
    controller.abort();

    const results = await processLongTermMemorySourceBatch({
      db: unusedDb,
      source: "chats",
      items: [first, last].map((note) => ({ sourceId: note.id, title: note.id, note, created: true })),
      provider: new ExtractionProvider(),
      model: "test-model",
      operationId: randomUUID(),
      signal: controller.signal,
      concurrency: 2,
      root,
    });

    assert.deepEqual(
      results.map((result) => result.extractionStatus),
      ["cancelled", "cancelled"],
    );
    assert.ok(results.every((result) => result.retryable && result.error.code === "cancelled"));
    assert.equal((await new LongTermMemoryDraftStore(root).listDrafts()).length, 0);
  });
});
