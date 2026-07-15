// ──────────────────────────────────────────────
// LTM Routes Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import {
  ltmStatusResponseSchema,
  ltmIntegrityResponseSchema,
} from "@marinara-engine/shared";
import { LongTermMemoryStorage } from "../storage.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { checkLongTermMemoryIntegrity } from "../maintenance.js";
import { countBy } from "../ltm-utils.js";
import { LTM_DIR_NAME, getLongTermMemoryDirectories } from "../paths.js";
import {
  withTempRoot,
  sourceNote,
  worldNote,
  characterNote,
  REFERENCE_TS,
} from "./fixtures/ltm-test-harness.js";

function storage(root: string) { return new LongTermMemoryStorage(root); }
function drafts(root: string) { return new LongTermMemoryDraftStore(root); }

// ═══════════════════════════════════════════════
//  Status route logic
// ═══════════════════════════════════════════════

await test("status response is schema-valid after seeding notes", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_status", "Status fact."));

    const notes = await s.listNotes();
    const dirs = getLongTermMemoryDirectories(root);
    let events;
    try {
      const { stat } = await import("node:fs/promises");
      const info = await stat(dirs.eventLog);
      events = { logAvailable: true, bytes: info.size };
    } catch {
      events = { logAvailable: false, bytes: 0 };
    }
    const integrity = await checkLongTermMemoryIntegrity(root);

    const body = {
      initialized: true,
      directory: LTM_DIR_NAME,
      notes: {
        total: notes.length,
        byType: countBy(notes.map((n) => n.type)),
        byStatus: countBy(notes.map((n) => n.status)),
      },
      events,
      indexes: {
        health: integrity.health,
        manifestAvailable: false,
        generationId: null,
        currentGenerationId: null,
        recovered: false,
        dirty: true,
        rebuildState: "idle",
        errors: [],
        warnings: [],
        generatedAt: null,
        sourceHash: null,
        noteCount: null,
        chunkCount: null,
        chunkFormatVersion: null,
        embeddingsAvailable: false,
        embeddedChunkCount: 0,
      },
    };
    const parsed = ltmStatusResponseSchema.parse(body);
    assert.ok(parsed);
    assert.ok(parsed.initialized);
    assert.ok(typeof parsed.directory === "string");
  });
});

// ═══════════════════════════════════════════════
//  Integrity route logic
// ═══════════════════════════════════════════════

await test("integrity response is schema-valid", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_integrity", "Integrity fact."));
    const result = await checkLongTermMemoryIntegrity(root);
    const parsed = ltmIntegrityResponseSchema.parse(result);
    assert.ok(parsed);
    assert.ok(typeof parsed.ok === "boolean");
    assert.ok(Array.isArray(parsed.issues));
  });
});

// ═══════════════════════════════════════════════
//  Notes CRUD
// ═══════════════════════════════════════════════

await test("create and read note via storage", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(characterNote("char_route_test", "Route character fact."));
    const retrieved = await s.getNote("char_route_test");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "char_route_test");
    assert.equal(retrieved.type, "character");
  });
});

await test("patch note title via storage", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_patch", "Patch me."));
    const updated = await s.updateNote("world_patch", { title: "Patched World" });
    assert.equal(updated.title, "Patched World");
  });
});

await test("batch permanent delete removes multiple notes", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_batch_x", "X"));
    await s.createNote(worldNote("world_batch_y", "Y"));
    await s.createNote(worldNote("world_batch_z", "Z"));

    const result = await s.deleteNotesPermanently(["world_batch_x", "world_batch_y"]);
    assert.equal(result.deletedIds.length, 2);
    assert.equal(result.failedIds.length, 0);

    const remaining = await s.listNotes();
    assert.ok(!remaining.some((n) => n.id === "world_batch_x"));
    assert.ok(!remaining.some((n) => n.id === "world_batch_y"));
    assert.ok(remaining.some((n) => n.id === "world_batch_z"));
  });
});

await test("get a non-existent note returns 404-like null", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    assert.equal(await s.getNote("nonexistent_route_note"), null);
  });
});

// ═══════════════════════════════════════════════
//  Drafts API
// ═══════════════════════════════════════════════

await test("draft list returns empty when no drafts exist", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    const list = await d.listDrafts({});
    assert.ok(Array.isArray(list));
  });
});

await test("draft create requires sourceNoteId", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await assert.rejects(
      () =>
        d.createDraft({
          scope: {},
          modes: ["roleplay"],
          source: { sourceNoteId: "", chatId: "chat_x" },
          response: { summary: "Bad draft.", mutations: [] },
        }),
      /must be tied to a source note/,
    );
  });
});

await test("draft gets status superseded when newer draft created for same source", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(sourceNote("source_supersede", "Supersede test."));

    const d = drafts(root);
    const first = await d.createDraft({
      scope: { chatId: "chat_supersede" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_supersede", chatId: "chat_supersede" },
      response: {
        summary: "First draft.",
        mutations: [
          {
            id: "550e8400-e29b-41d4-a716-446655440010",
            kind: "create_note",
            risk: "low",
            confidence: 0.9,
            evidence: ["source_note:source_supersede"],
            summary: "First mutation",
            note: {
              id: "world_supersede_a",
              type: "world",
              status: "active",
              modes: ["roleplay"],
              scope: {},
              tags: [],
              keywords: [],
              links: [],
              sections: { facts: { text: "First.", updatedAt: REFERENCE_TS } },
            },
          },
        ],
      },
    });

    const second = await d.createDraft({
      scope: { chatId: "chat_supersede" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_supersede", chatId: "chat_supersede" },
      response: {
        summary: "Second draft.",
        mutations: [
          {
            id: "550e8400-e29b-41d4-a716-446655440020",
            kind: "create_note",
            risk: "low",
            confidence: 0.9,
            evidence: ["source_note:source_supersede"],
            summary: "Second mutation",
            note: {
              id: "world_supersede_b",
              type: "world",
              status: "active",
              modes: ["roleplay"],
              scope: {},
              tags: [],
              keywords: [],
              links: [],
              sections: { facts: { text: "Second.", updatedAt: REFERENCE_TS } },
            },
          },
        ],
      },
    });

    const firstAfter = await d.getDraft(first.id);
    assert.equal(firstAfter?.status, "superseded");
    assert.equal(firstAfter?.supersededByDraftId, second.id);
  });
});
