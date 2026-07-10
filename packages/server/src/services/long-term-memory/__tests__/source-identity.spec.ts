import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ltmDraftNoteInputSchema, ltmNoteSchema } from "@marinara-engine/shared";
import { sourceNoteIdForProvenance } from "../source-identity.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-07-10T00:00:00.000Z";

function noteInput(type: "scene" | "source") {
  return {
    id: "scene_summary_shared_id",
    type,
    status: "active" as const,
    modes: ["roleplay" as const],
    scope: {},
    tags: [],
    keywords: [],
    links: [],
    sections: { summary: { text: "Shared identity test.", updatedAt: timestamp } },
  };
}

test("imported source identity is independent of display titles", () => {
  const provenance = { kind: "character", sourceId: "character-123" } as const;
  assert.equal(sourceNoteIdForProvenance(provenance), sourceNoteIdForProvenance({ ...provenance }));
  assert.match(sourceNoteIdForProvenance(provenance), /^source_character_[a-f0-9]{16}$/);
});

test("chat summary entries have distinct stable source identities", () => {
  const first = sourceNoteIdForProvenance({ kind: "chat_summary", sourceId: "chat-1", entryId: "entry-1" });
  const second = sourceNoteIdForProvenance({ kind: "chat_summary", sourceId: "chat-1", entryId: "entry-2" });
  assert.notEqual(first, second);
});

test("import provenance belongs only to source notes", () => {
  const nonSource = {
    ...noteInput("scene"),
    provenance: { kind: "chat_summary", sourceId: "chat-1", entryId: "entry-1" },
  };
  assert.throws(() => ltmDraftNoteInputSchema.parse(nonSource), /Only source notes/);
  assert.throws(
    () => ltmNoteSchema.parse({ ...nonSource, createdAt: timestamp, updatedAt: timestamp, version: 1 }),
    /Only source notes/,
  );
});

test("concurrent cross-folder creation cannot persist duplicate note IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-source-id-lock-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    const results = await Promise.allSettled([
      storage.createNote(noteInput("scene")),
      storage.createNote(noteInput("source")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await storage.listNotes()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
