// ──────────────────────────────────────────────
// LTM Draft & Reconciliation Contracts
// ──────────────────────────────────────────────
import assert from "node:assert/strict";
import test from "node:test";
import { ltmDraftReviewResponseSchema } from "@marinara-engine/shared";
import { LongTermMemoryStorage } from "../storage.js";
import { LongTermMemoryDraftStore } from "../draft-store.js";
import { projectLongTermMemoryDraftReview } from "../draft-review.js";
import {
  withTempRoot,
  sourceNote,
  REFERENCE_TS,
} from "./fixtures/ltm-test-harness.js";

function storage(root: string) { return new LongTermMemoryStorage(root); }
function drafts(root: string) { return new LongTermMemoryDraftStore(root); }

await test("create and read a draft", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_a", "Draft source text."));
    const created = await d.createDraft({
      scope: { chatId: "chat_draft" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_a", chatId: "chat_draft" },
      response: { summary: "One extraction draft.", mutations: [] },
    });
    const retrieved = await d.getDraft(created.id);
    assert.ok(retrieved);
    assert.equal(retrieved.id, created.id);
    assert.equal(retrieved.source.sourceNoteId, "source_draft_a");
    assert.equal(retrieved.status, "pending");
  });
});

await test("listDrafts returns created drafts", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_b", "List test."));
    await d.createDraft({
      scope: { chatId: "chat_list" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_b", chatId: "chat_list" },
      response: { summary: "List draft.", mutations: [] },
    });
    const list = await d.listDrafts({});
    assert.ok(list.length >= 1);
    assert.ok(list.some((dr) => dr.source.sourceNoteId === "source_draft_b"));
  });
});

await test("listDrafts filter by status", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_c", "Status filter."));
    const created = await d.createDraft({
      scope: { chatId: "chat_filter" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_c", chatId: "chat_filter" },
      response: { summary: "Status filter draft.", mutations: [] },
    });
    const pending = await d.listDrafts({ status: "pending" });
    assert.ok(pending.some((dr) => dr.id === created.id));
    const accepted = await d.listDrafts({ status: "accepted" });
    assert.ok(!accepted.some((dr) => dr.id === created.id));
  });
});

await test("delete a draft", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_d", "Delete test."));
    const created = await d.createDraft({
      scope: { chatId: "chat_delete" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_d", chatId: "chat_delete" },
      response: { summary: "Delete draft.", mutations: [] },
    });
    const deleted = await d.withDraftLock(created.id, () => d.deleteDraft(created.id));
    assert.equal(deleted, true);
    const retrieved = await d.getDraft(created.id);
    assert.equal(retrieved, null);
  });
});

await test("delete draft mutations skips non-pending drafts", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_e", "Skip delete test."));
    const created = await d.createDraft({
      scope: { chatId: "chat_skip" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_e", chatId: "chat_skip" },
      response: { summary: "Skip draft.", mutations: [] },
    });
    const result = await d.withDraftLock(created.id, () =>
      d.deleteDraftMutations(created.id, ["nonexistent-id"]),
    );
    assert.equal(result.deleted, false);
  });
});

await test("draft review projection returns valid schema", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    await s.createNote(sourceNote("source_draft_f", "Review projection test."));
    const created = await d.createDraft({
      scope: { chatId: "chat_review" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_draft_f", chatId: "chat_review" },
      response: { summary: "Review draft.", mutations: [] },
    });
    const review = await projectLongTermMemoryDraftReview({
      sourceNoteId: "source_draft_f",
    });
    const parsed = ltmDraftReviewResponseSchema.parse(review);
    assert.ok(parsed);
    assert.ok(parsed.sources.length >= 1);
    const sourceDrafts = parsed.sources.flatMap((s) => s.drafts);
    assert.ok(sourceDrafts.length >= 1);
    assert.ok(sourceDrafts.some((dr) => dr.draft.id === created.id));
  });
});

await test("draft from stale source is present in review with block reasons", async () => {
  await withTempRoot(async (root) => {
    const s = storage(root);
    const d = drafts(root);
    const src = sourceNote("source_stale_block", "First extraction source.");
    await s.createNote(src);

    // Create a draft normally — it gets the current source fingerprint.
    const created = await d.createDraft({
      scope: { chatId: "chat_stale" },
      modes: ["roleplay"],
      source: { sourceNoteId: "source_stale_block", chatId: "chat_stale" },
      response: { summary: "First draft.", mutations: [] },
    });
    assert.ok(created);

    // Mutate the source so the draft fingerprint goes stale.
    await s.updateNote("source_stale_block", {
      title: "Updated source title",
      sections: { source: { text: "Changed source content.", updatedAt: REFERENCE_TS } },
    });

    const review = await projectLongTermMemoryDraftReview({
      sourceNoteId: "source_stale_block",
    });
    const allDrafts = review.sources.flatMap((s) => s.drafts);
    const matching = allDrafts.filter((dr) => dr.draft.id === created.id);
    assert.equal(matching.length, 1);
    assert.ok(matching[0]!.blockReasons.length >= 1);
  });
});
