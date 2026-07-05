import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LtmNote } from "@marinara-engine/shared";
import { applyLtmNoteTransfer, previewLtmNoteTransfer } from "../note-transfer.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-06-20T00:00:00.000Z";

type TestChat = {
  id: string;
  groupId?: string;
  characterIds: string[];
};

const DESTINATION_CHAT: TestChat = {
  id: "branch_destination",
  groupId: "thread_destination",
  characterIds: ["char_destination"],
};

function baseNote(input: Partial<LtmNote> & Pick<LtmNote, "id" | "type">): LtmNote {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    status: input.status ?? "active",
    modes: input.modes ?? ["roleplay"],
    scope: input.scope ?? {},
    tags: input.tags ?? ["typed_memory"],
    keywords: input.keywords ?? [],
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    links: input.links ?? [],
    sections:
      input.sections ??
      ({
        summary: {
          text: `${input.id} summary`,
          updatedAt: timestamp,
        },
      } satisfies LtmNote["sections"]),
    conflicts: input.conflicts,
    version: input.version ?? 1,
    extracted: input.extracted,
  };
}

async function withStorage(run: (storage: LongTermMemoryStorage, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-transfer-"));
  try {
    await run(new LongTermMemoryStorage(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("copy to another branch adds destination branch scope without changing the original groupId", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "world_transfer_copy_scope",
        type: "world",
        scope: {
          chatId: "branch_source",
          chatIds: ["branch_source"],
          groupId: "thread_source",
          characterIds: ["char_source"],
        },
        sections: {
          summary: {
            text: "The lantern stays with Mara in the ruined watchtower.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );

    await applyLtmNoteTransfer(
      {
        noteIds: ["world_transfer_copy_scope"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    const updated = await storage.getNote("world_transfer_copy_scope");
    assert.ok(updated);
    assert.equal(updated.scope.groupId, "thread_source");
    assert.deepEqual(updated.scope.chatIds, ["branch_source", DESTINATION_CHAT.id]);
    assert.deepEqual(updated.scope.characterIds, ["char_source", "char_destination"]);
  });
});

test("copy and move preserve scoped variant note ids", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "char_damo_d1cc804891",
        type: "character",
        scope: {
          chatId: "branch_source",
          chatIds: ["branch_source"],
          characterIds: ["char_source"],
        },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "rel_damo_lisa_d1cc804891",
        type: "relationship",
        scope: {
          chatId: "branch_source",
          chatIds: ["branch_source"],
          characterIds: ["char_source"],
        },
      }),
      { suppressEvent: true },
    );

    await applyLtmNoteTransfer(
      {
        noteIds: ["char_damo_d1cc804891"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );
    await applyLtmNoteTransfer(
      {
        noteIds: ["rel_damo_lisa_d1cc804891"],
        mode: "move",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    const copied = await storage.getNote("char_damo_d1cc804891");
    const moved = await storage.getNote("rel_damo_lisa_d1cc804891");
    assert.ok(copied);
    assert.ok(moved);
    assert.deepEqual(copied.scope.chatIds, ["branch_source", DESTINATION_CHAT.id]);
    assert.deepEqual(moved.scope, {
      chatId: DESTINATION_CHAT.id,
      chatIds: [DESTINATION_CHAT.id],
      groupId: DESTINATION_CHAT.groupId,
      characterIds: DESTINATION_CHAT.characterIds,
    });
    assert.equal(await storage.getNote("char_damo"), null);
    assert.equal(await storage.getNote("rel_damo_lisa"), null);
  });
});

test("move replaces full scope with destination branch scope", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "thread_transfer_move_scope",
        type: "thread",
        scope: {
          chatId: "branch_source",
          chatIds: ["branch_source", "branch_elsewhere"],
          groupId: "thread_source",
          characterIds: ["char_source", "char_elsewhere"],
        },
        sections: {
          summary: {
            text: "The investigation now points toward the collapsed observatory.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );

    await applyLtmNoteTransfer(
      {
        noteIds: ["thread_transfer_move_scope"],
        mode: "move",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    const updated = await storage.getNote("thread_transfer_move_scope");
    assert.ok(updated);
    assert.deepEqual(updated.scope, {
      chatId: DESTINATION_CHAT.id,
      chatIds: [DESTINATION_CHAT.id],
      groupId: DESTINATION_CHAT.groupId,
      characterIds: DESTINATION_CHAT.characterIds,
    });
  });
});

test("preview marks global notes and already-destination-visible notes as no-op for copy", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "world_transfer_global_noop",
        type: "world",
        scope: {},
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "scene_transfer_visible_noop",
        type: "scene",
        scope: {
          chatId: DESTINATION_CHAT.id,
          chatIds: [DESTINATION_CHAT.id],
          groupId: DESTINATION_CHAT.groupId,
          characterIds: DESTINATION_CHAT.characterIds,
        },
      }),
      { suppressEvent: true },
    );

    const preview = await previewLtmNoteTransfer(
      {
        noteIds: ["world_transfer_global_noop", "scene_transfer_visible_noop"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    assert.deepEqual(preview.buckets.noOp, ["world_transfer_global_noop", "scene_transfer_visible_noop"]);
    assert.equal(preview.buckets.ready.length, 0);
    assert.equal(preview.buckets.conflict.length, 0);
  });
});

test("preview flags exact duplicate text in destination", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "world_transfer_exact_source",
        type: "world",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
        sections: {
          summary: {
            text: "Mara hid the silver key beneath the bell tower stairs.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "world_transfer_exact_target",
        type: "world",
        scope: {
          chatId: DESTINATION_CHAT.id,
          chatIds: [DESTINATION_CHAT.id],
          groupId: DESTINATION_CHAT.groupId,
        },
        sections: {
          summary: {
            text: "Mara hid the silver key beneath the bell tower stairs.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );

    const preview = await previewLtmNoteTransfer(
      {
        noteIds: ["world_transfer_exact_source"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    assert.deepEqual(preview.buckets.conflict, ["world_transfer_exact_source"]);
    assert.equal(preview.items[0]?.conflicts[0]?.reason, "exact_text");
    assert.equal(preview.items[0]?.conflicts[0]?.severity, "hard");
  });
});

test("preview flags same-source extracted notes in destination", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "source_transfer_same_source",
        type: "source",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "rel_transfer_same_source_source",
        type: "relationship",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
        links: [{ target: "source_transfer_same_source", relation: "extracted_from" }],
        sections: {
          summary: {
            text: "Mara no longer trusts Jules after the false signal.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "rel_transfer_same_source_target",
        type: "relationship",
        scope: {
          chatId: DESTINATION_CHAT.id,
          chatIds: [DESTINATION_CHAT.id],
          groupId: DESTINATION_CHAT.groupId,
        },
        links: [{ target: "source_transfer_same_source", relation: "extracted_from" }],
        sections: {
          summary: {
            text: "Jules and Mara still circle the radio lie whenever they argue.",
            updatedAt: timestamp,
          },
        },
      }),
      { suppressEvent: true },
    );

    const preview = await previewLtmNoteTransfer(
      {
        noteIds: ["rel_transfer_same_source_source"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    assert.deepEqual(preview.buckets.conflict, ["rel_transfer_same_source_source"]);
    assert.equal(preview.items[0]?.conflicts[0]?.reason, "same_source_type");
    assert.equal(preview.items[0]?.conflicts[0]?.severity, "hard");
  });
});

test("source-memory cascade includes or excludes extracted children based on includeDerived", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "source_transfer_parent",
        type: "source",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "char_transfer_child",
        type: "character",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
        links: [{ target: "source_transfer_parent", relation: "extracted_from" }],
        extracted: true,
      }),
      { suppressEvent: true },
    );

    const excluded = await previewLtmNoteTransfer(
      {
        noteIds: ["source_transfer_parent"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );
    const included = await previewLtmNoteTransfer(
      {
        noteIds: ["source_transfer_parent"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: true,
      },
      DESTINATION_CHAT,
      { storage },
    );

    assert.deepEqual(excluded.selection.derivedNoteIds, []);
    assert.equal(excluded.selection.availableDerivedCount, 1);
    assert.deepEqual(included.selection.derivedNoteIds, ["char_transfer_child"]);
    assert.equal(included.selection.includedDerivedCount, 1);
  });
});

test("apply respects the curated final note set when includeDerived is false", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "source_transfer_curated_parent",
        type: "source",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "char_transfer_curated_child",
        type: "character",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
        links: [{ target: "source_transfer_curated_parent", relation: "extracted_from" }],
        extracted: true,
      }),
      { suppressEvent: true },
    );

    const result = await applyLtmNoteTransfer(
      {
        noteIds: ["source_transfer_curated_parent"],
        mode: "copy",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      { storage },
    );

    const parent = await storage.getNote("source_transfer_curated_parent");
    const child = await storage.getNote("char_transfer_curated_child");
    assert.ok(parent);
    assert.ok(child);
    assert.deepEqual(result.updatedNoteIds, ["source_transfer_curated_parent"]);
    assert.deepEqual(result.derivedNoteIdsTouched, []);
    assert.deepEqual(parent.scope.chatIds, ["branch_source", DESTINATION_CHAT.id]);
    assert.deepEqual(child.scope.chatIds, ["branch_source"]);
  });
});

test("batch apply rebuilds indexes once after all note updates", async () => {
  await withStorage(async (storage) => {
    await storage.createNote(
      baseNote({
        id: "world_transfer_rebuild_one",
        type: "world",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
      }),
      { suppressEvent: true },
    );
    await storage.createNote(
      baseNote({
        id: "thread_transfer_rebuild_two",
        type: "thread",
        scope: { chatId: "branch_source", chatIds: ["branch_source"] },
      }),
      { suppressEvent: true },
    );

    let rebuildCalls = 0;
    const result = await applyLtmNoteTransfer(
      {
        noteIds: ["world_transfer_rebuild_one", "thread_transfer_rebuild_two"],
        mode: "move",
        destinationChatId: DESTINATION_CHAT.id,
        includeDerived: false,
      },
      DESTINATION_CHAT,
      {
        storage,
        rebuild: async () => {
          rebuildCalls += 1;
          return { ok: true };
        },
      },
    );

    assert.equal(rebuildCalls, 1);
    assert.deepEqual(result.updatedNoteIds, ["world_transfer_rebuild_one", "thread_transfer_rebuild_two"]);
    assert.deepEqual(result.skippedNoteIds, []);
    assert.deepEqual(result.rebuild, { ok: true });
  });
});
