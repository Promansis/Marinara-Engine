import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LtmDraftMutation } from "@marinara-engine/shared";
import { LongTermMemoryDraftStore } from "../extraction.js";
import {
  applyLongTermMemoryDraft,
  isLowRiskSourceExtractionMutation,
  isLowRiskTurnMutation,
} from "../reconciliation.js";
import { LongTermMemoryStorage } from "../storage.js";

const timestamp = "2026-06-10T00:00:00.000Z";

function sceneAppendMutation(): Extract<LtmDraftMutation, { kind: "append_section" }> {
  return {
    id: randomUUID(),
    kind: "append_section",
    risk: "low",
    confidence: 0.95,
    summary: "Append source scene detail",
    evidence: ["source_note:scene_source_test"],
    noteId: "scene_source_test",
    sectionKey: "summary",
    text: "New scene detail that must stay pending.",
    salience: 0.6,
  };
}

test("source extraction low-risk policy blocks scene append auto-apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "marinara-ltm-reconciliation-"));
  try {
    const storage = new LongTermMemoryStorage(root);
    await storage.createNote(
      {
        id: "scene_source_test",
        type: "scene",
        status: "dormant",
        modes: ["roleplay"],
        scope: {},
        tags: ["source_summary"],
        links: [],
        sections: {
          source: {
            text: "Original source text.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
          summary: {
            text: "Original summary.",
            updatedAt: timestamp,
            evidence: ["chat:chat_test"],
          },
        },
      },
      { suppressEvent: true },
    );

    const mutation = sceneAppendMutation();
    assert.equal(isLowRiskTurnMutation(mutation), true);
    assert.equal(isLowRiskSourceExtractionMutation(mutation), false);

    const draft = await new LongTermMemoryDraftStore(root).createDraft({
      userMessage: "",
      assistantReply: "",
      scope: {},
      modes: ["roleplay"],
      source: { sourceNoteId: "scene_source_test" },
      response: {
        summary: "Scene append draft",
        mutations: [mutation],
      },
    });

    const result = await applyLongTermMemoryDraft(draft.id, {
      root,
      actor: "test",
      autoApplyLowRiskOnly: true,
      autoApplyPolicy: "source_extraction",
      rebuildIndexes: false,
    });

    assert.deepEqual(result.appliedMutationIds, []);
    assert.deepEqual(result.skippedMutationIds, [mutation.id]);
    assert.equal(result.draft.status, "pending");

    const sourceNote = await storage.getNote("scene_source_test");
    assert.equal(sourceNote?.sections.summary?.text, "Original summary.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
