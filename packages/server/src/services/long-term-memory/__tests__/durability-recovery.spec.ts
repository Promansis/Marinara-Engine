// ──────────────────────────────────────────────
// LTM Durability & Recovery Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { LongTermMemoryStorage } from "../storage.js";
import {
  withTempRoot,
  sourceNote,
  worldNote,
  REFERENCE_TS,
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
