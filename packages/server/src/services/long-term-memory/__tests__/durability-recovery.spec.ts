// ──────────────────────────────────────────────
// LTM Durability & Recovery Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadLtmIndexGeneration, ltmIndexPointerPath } from "../index-generation.js";
import { rebuildLongTermMemoryIndexes } from "../rebuild.js";
import { retrieveLongTermMemory } from "../retrieval.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { LongTermMemoryStorage } from "../storage.js";
import {
  withTempRoot,
  sourceNote,
  worldNote,
  REFERENCE_TS,
  seedDraft,
} from "./fixtures/ltm-test-harness.js";

function storage(root: string) { return new LongTermMemoryStorage(root); }

await test("atomic persistence survives manual file re-read", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_atomic", "Atomic persistence fact."));
    const retrieved = await s.getNote("world_atomic");
    assert.ok(retrieved);
    assert.equal(retrieved.sections["facts"]?.text, "Atomic persistence fact.");
  });
});

await test("note updated after write returns the updated data", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_update", "Original."));
    const updated = await s.updateNote("world_update", {
      sections: { facts: { text: "Updated.", updatedAt: REFERENCE_TS } },
    });
    assert.equal(updated.sections["facts"]?.text, "Updated.");
    const retrieved = await s.getNote("world_update");
    assert.equal(retrieved?.sections["facts"]?.text, "Updated.");
  });
});

await test("permanent delete removes note and cannot be re-read", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_delete_perm", "Will be deleted."));
    await s.deleteNotesPermanently(["world_delete_perm"]);
    assert.equal(await s.getNote("world_delete_perm"), null);
  });
});

await test("single permanent delete removes the note", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_delete_single", "Single delete."));
    await s.deleteNote("world_delete_single");
    assert.equal(await s.getNote("world_delete_single"), null);
  });
});

await test("archive source note with derived archives both", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(sourceNote("source_archive", "Archive source."));
    await s.createNote(worldNote("world_derived_archive", "Derived fact.", {
      links: [{ target: "source_archive", relation: "extracted_from" }],
    }));
    const result = await s.archiveSourceNoteWithDerived("source_archive");
    assert.ok(result.length >= 1);
    assert.ok(result.some((n) => n.status === "archived"));
  });
});

await test("restart round trip: re-read after fresh storage instance", async () => {
  await withTempRoot(async (root) => {
    const sa = storage(root);
    await sa.createNote(worldNote("world_restart", "Survives restart."));
    const sb = new LongTermMemoryStorage(root);
    const retrieved = await sb.getNote("world_restart");
    assert.ok(retrieved);
    assert.equal(retrieved.sections["facts"]?.text, "Survives restart.");
  });
});

await test("listNotes returns only active by status filter", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_active_status", "Active"));
    await s.createNote(sourceNote("source_archived", "Archived", { status: "archived" }));
    const active = await s.listNotes({ status: "active" });
    assert.ok(active.every((n) => n.status === "active"));
    const archived = await s.listNotes({ status: "archived" });
    assert.ok(archived.every((n) => n.status === "archived"));
  });
});

await test("getNotesByIds returns multiple notes across vault folders", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_batch_a", "Batch A"));
    await s.createNote(sourceNote("source_batch_b", "Batch B source."));
    const batch = await s.getNotesByIds(["world_batch_a", "source_batch_b"]);
    assert.equal(batch.size, 2);
    assert.ok(batch.has("world_batch_a"));
    assert.ok(batch.has("source_batch_b"));
  });
});

await test("reading a non-existent note returns null", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    assert.equal(await s.getNote("nonexistent_note_id"), null);
  });
});

await test("dirty indexes do not serve stale content after an indexed note changes", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_dirty_content", "The original indexed content."));
    await rebuildLongTermMemoryIndexes({
      root,
      embeddingSource: { label: "test-disabled", embed: async () => null },
    });

    await s.updateNote("world_dirty_content", {
      sections: { facts: { text: "The replacement content.", updatedAt: REFERENCE_TS } },
    });
    const result = await retrieveLongTermMemory({
      root,
      noteIds: ["world_dirty_content"],
      semanticWeight: 0,
      lexicalWeight: 1,
      graphWeight: 0,
      keywordWeight: 0,
      queryText: "original indexed content",
    });

    assert.equal(result.chunks.some((candidate) => candidate.chunk.text === "The original indexed content."), false);
  });
});

await test("index loading recovers a valid generation when current pointer is malformed", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_pointer_recovery", "A recoverable index fact."));
    await rebuildLongTermMemoryIndexes({
      root,
      generatedAt: "2026-07-14T00:00:00.000Z",
      embeddingSource: { label: "test-disabled", embed: async () => null },
    });
    await rebuildLongTermMemoryIndexes({
      root,
      generatedAt: "2026-07-14T00:01:00.000Z",
      embeddingSource: { label: "test-disabled", embed: async () => null },
    });

    await writeFile(ltmIndexPointerPath(root), "{\"version\":1,\"generationId\":\"broken\"}", "utf8");
    const loaded = await loadLtmIndexGeneration(root);

    assert.equal(loaded.recovered, true);
    assert.ok(loaded.manifest);
    assert.equal(loaded.manifest.generatedAt, "2026-07-14T00:01:00.000Z");
    const recoveredPointer = JSON.parse(await readFile(ltmIndexPointerPath(root), "utf8")) as {
      generationId?: string;
    };
    assert.equal(recoveredPointer.generationId, loaded.manifest.generationId);
  });
});

await test("note rename moves the note, inbound links, and draft references together", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(sourceNote("source_rename_before", "Rename source content."));
    await s.createNote(
      worldNote("world_rename_reference", "References the source.", {
        links: [{ target: "source_rename_before", relation: "extracted_from" }],
      }),
    );
    const draft = await seedDraft(root, { sourceNoteId: "source_rename_before", mutations: [] });

    await s.renameNoteId("source_rename_before", "source_rename_after");

    assert.equal(await s.getNote("source_rename_before"), null);
    assert.ok(await s.getNote("source_rename_after"));
    assert.equal((await s.getNote("world_rename_reference"))?.links[0]?.target, "source_rename_after");
    assert.equal(
      (await new LongTermMemoryDraftStore(root).getDraft(draft.id))?.source.sourceNoteId,
      "source_rename_after",
    );
  });
});

await test("note type change moves the note and rewrites inbound links together", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    await s.createNote(worldNote("world_type_move", "Move this note."));
    await s.createNote(
      worldNote("world_type_reference", "References the moved note.", {
        links: [{ target: "world_type_move", relation: "involves" }],
      }),
    );

    const moved = await s.updateNote("world_type_move", { type: "character" });

    assert.equal(moved.id, "char_type_move");
    assert.equal(moved.type, "character");
    assert.equal(await s.getNote("world_type_move"), null);
    assert.equal((await s.getNote("world_type_reference"))?.links[0]?.target, "char_type_move");
  });
});
