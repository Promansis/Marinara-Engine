// ──────────────────────────────────────────────
// LTM Capture & Extraction Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { LongTermMemoryStorage } from "../storage.js";
import { isLtmSourceNote } from "../source-extraction.js";
import {
  withTempRoot,
  makeNote,
  sourceNote,
  worldNote,
  REFERENCE_TS,
} from "./fixtures/ltm-test-harness.js";

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
