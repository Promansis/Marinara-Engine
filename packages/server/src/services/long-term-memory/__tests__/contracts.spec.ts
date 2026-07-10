import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LTM_GLOBAL_SETTINGS,
  ltmAgentSettingsSchema,
  ltmExtractSourceNoteRequestSchema,
  ltmExtractSourceNoteResponseSchema,
  ltmImportSourceNotesResponseSchema,
  ltmImportSourceNotesRequestSchema,
  ltmInteropPreviewRequestSchema,
  ltmInteropPreviewResponseSchema,
  ltmRepairRequestSchema,
  ltmRepairResponseSchema,
  ltmGlobalSettingsSchema,
  ltmResolvedGlobalSettingsSchema,
  ltmStatusResponseSchema,
} from "@marinara-engine/shared";

const checkedAt = "2026-07-10T00:00:00.000Z";

test("LTM transport contracts - status preserves index recovery state and rejects invalid health", () => {
  const payload = {
    initialized: true,
    directory: "long-term-memory",
    notes: {
      total: 2,
      byType: { source: 1, world: 1 },
      byStatus: { active: 2 },
    },
    events: { logAvailable: true, bytes: 128 },
    indexes: {
      health: "stale",
      manifestAvailable: true,
      generationId: "53d1ac5f-fdde-4563-a8ea-06ce0c658c37",
      currentGenerationId: "53d1ac5f-fdde-4563-a8ea-06ce0c658c37",
      recovered: false,
      dirty: true,
      rebuildState: "failed",
      errors: [],
      warnings: ["The active generation is stale."],
      generatedAt: checkedAt,
      sourceHash: "a".repeat(64),
      noteCount: 2,
      chunkCount: 4,
      chunkFormatVersion: 3,
      embeddingsAvailable: true,
      embeddedChunkCount: 4,
    },
  };

  assert.deepEqual(ltmStatusResponseSchema.parse(payload), payload);
  assert.equal(
    ltmStatusResponseSchema.safeParse({
      ...payload,
      indexes: { ...payload.indexes, health: "ready" },
    }).success,
    false,
  );
});

test("LTM transport contracts - import preserves partial failures and retryability", () => {
  const sourceNote = {
    id: "source_chat_summary_a",
    title: "Chapter one",
    type: "source",
    status: "active",
    modes: ["roleplay"],
    scope: { chatIds: ["chat_a"] },
    tags: ["imported_chat"],
    keywords: [],
    createdAt: checkedAt,
    updatedAt: checkedAt,
    links: [],
    sections: {
      source: {
        text: "A summary to import.",
        updatedAt: checkedAt,
        evidence: ["chat:chat_a"],
      },
    },
    version: 1,
    extracted: false,
  };
  const payload = {
    operationId: "8da1df57-ad4e-41f2-afaf-e91676daf329",
    batchStatus: "partial_success",
    source: "chats",
    imported: [
      {
        sourceId: "chat_a:summary_a",
        title: "Chapter one",
        note: sourceNote,
        created: true,
        sourceWriteStatus: "created",
        extractionStatus: "failed",
        extractionMethod: "llm",
        retryable: true,
        error: { code: "extract_failed", message: "Provider unavailable" },
        draft: null,
        diagnostics: [
          {
            severity: "error",
            code: "extract_failed",
            message: "Provider unavailable",
          },
        ],
        outcome: {
          state: "no_suggestions_created",
          totalCandidates: 0,
          keptUnits: 0,
          droppedUnits: 0,
          droppedCandidates: [],
        },
        appliedMutationIds: [],
        skippedMutationIds: [],
      },
      {
        sourceId: "chat_c:summary_c",
        title: "Chapter three",
        note: {
          ...sourceNote,
          id: "source_chat_summary_c",
          title: "Chapter three",
          extracted: true,
        },
        created: true,
        sourceWriteStatus: "created",
        extractionStatus: "succeeded",
        extractionMethod: "llm",
        retryable: false,
        draft: null,
        diagnostics: [],
        outcome: {
          state: "no_suggestions_created",
          totalCandidates: 0,
          keptUnits: 0,
          droppedUnits: 0,
          droppedCandidates: [],
        },
        appliedMutationIds: [],
        skippedMutationIds: [],
      },
    ],
    writeFailures: [
      {
        sourceId: "chat_b:summary_b",
        title: "Chapter two",
        sourceWriteStatus: "failed",
        extractionStatus: "not_started",
        retryable: true,
        error: { code: "source_write_failed", message: "Disk full" },
      },
    ],
    missingSourceIds: [],
    counts: {
      requested: 3,
      sourceNotesWritten: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      missing: 0,
      sourceWriteFailed: 1,
    },
  };

  const parsed = ltmImportSourceNotesResponseSchema.parse(payload);
  assert.equal(parsed.imported[0]?.retryable, true);
  assert.equal(parsed.writeFailures[0]?.extractionStatus, "not_started");
  assert.equal(
    ltmImportSourceNotesResponseSchema.safeParse({
      ...payload,
      imported: [{ ...payload.imported[0], error: undefined }],
    }).success,
    false,
  );
  assert.equal(
    ltmImportSourceNotesResponseSchema.safeParse({ ...payload, batchStatus: "success" }).success,
    false,
  );
  assert.equal(
    ltmImportSourceNotesResponseSchema.safeParse({
      ...payload,
      imported: payload.imported.map((item) =>
        item.extractionStatus === "succeeded"
          ? { ...item, note: { ...item.note, extracted: false } }
          : item,
      ),
    }).success,
    false,
  );
});

test("LTM transport contracts - repair preserves action results and remaining integrity issues", () => {
  const payload = {
    repairedAt: checkedAt,
    actions: [
      { action: "quarantine_malformed_notes", result: "quarantined", count: 1 },
      { action: "backfill_imported_source_titles", result: "no_titles_to_backfill", count: 0 },
      { action: "rebuild_indexes", result: "rebuilt", count: 3 },
    ],
    integrity: {
      ok: false,
      health: "degraded",
      checkedAt,
      noteCount: 2,
      eventCount: 4,
      issues: [
        {
          severity: "warning",
          code: "missing_link_target",
          noteId: "world_harbour",
          message: "Link target scene_missing does not exist.",
        },
      ],
    },
  };

  assert.deepEqual(ltmRepairResponseSchema.parse(payload), payload);
  assert.equal(
    ltmRepairResponseSchema.safeParse({
      ...payload,
      integrity: { ...payload.integrity, health: "ready" },
    }).success,
    false,
  );
  assert.equal(
    ltmRepairRequestSchema.safeParse({ actions: ["rebuild_indexes", "rebuild_indexes"] }).success,
    false,
  );
});

test("LTM transport contracts - import preview validates source, scope, and row status", () => {
  const request = {
    source: "chats",
    limit: 100,
    scope: { chatIds: ["chat_a"] },
  };
  const response = {
    source: "chats",
    scanned: 1,
    draftable: 1,
    importedCount: 0,
    samples: [
      {
        sourceId: "chat_a:summary_a",
        title: "Chapter one",
        mutationCount: 1,
        summary: "Import chapter one",
        snippet: "A short source preview.",
        status: "pending",
      },
    ],
  };

  assert.deepEqual(ltmInteropPreviewRequestSchema.parse(request), request);
  assert.deepEqual(ltmInteropPreviewResponseSchema.parse(response), response);
  assert.equal(
    ltmInteropPreviewRequestSchema.safeParse({ ...request, source: "files" }).success,
    false,
  );
  assert.equal(
    ltmInteropPreviewResponseSchema.safeParse({
      ...response,
      samples: [{ ...response.samples[0], status: "failed" }],
    }).success,
    false,
  );
});

test("LTM transport contracts - source import request rejects duplicate and invalid selections", () => {
  const request = {
    source: "chats",
    sourceIds: ["chat_a:summary_a"],
    limit: 1,
    scope: { chatIds: ["chat_a"] },
    connectionId: "connection_a",
    model: "model-a",
    instruction: "Keep durable facts only.",
    applyLowRisk: true,
    importConcurrency: 2,
    mode: "roleplay",
  };

  assert.deepEqual(ltmImportSourceNotesRequestSchema.parse(request), request);
  assert.equal(
    ltmImportSourceNotesRequestSchema.safeParse({
      ...request,
      sourceIds: ["chat_a:summary_a", "chat_a:summary_a"],
      limit: 2,
    }).success,
    false,
  );
  assert.equal(
    ltmImportSourceNotesRequestSchema.safeParse({ ...request, mode: "visual_novel" }).success,
    false,
  );
});

test("LTM transport contracts - extraction response rejects a missing response shape", () => {
  const request = {
    chatId: "chat_a",
    connectionId: "connection_a",
    model: "model-a",
    instruction: "Keep durable facts only.",
    applyLowRisk: false,
    mode: "conversation",
  };
  const response = {
    draft: null,
    diagnostics: [],
    outcome: {
      state: "no_suggestions_created",
      totalCandidates: 0,
      keptUnits: 0,
      droppedUnits: 0,
      droppedCandidates: [],
    },
    response: { summary: "", mutations: [] },
    appliedMutationIds: [],
    skippedMutationIds: [],
  };

  assert.deepEqual(ltmExtractSourceNoteRequestSchema.parse(request), request);
  assert.deepEqual(ltmExtractSourceNoteResponseSchema.parse(response), response);
  assert.equal(
    ltmExtractSourceNoteResponseSchema.safeParse({ ...response, response: {} }).success,
    false,
  );
});

test("LTM settings contracts - legacy unused fields are stripped and import source is enumerated", () => {
  const globalSettings = ltmGlobalSettingsSchema.parse({
    ...DEFAULT_LTM_GLOBAL_SETTINGS,
    longTermMemoryMetadataWeight: 1.5,
  });
  assert.equal("longTermMemoryMetadataWeight" in globalSettings, false);
  assert.equal(ltmResolvedGlobalSettingsSchema.safeParse(globalSettings).success, true);

  const agentSettings = ltmAgentSettingsSchema.parse({
    importSource: "chats",
    importLimit: 5_000,
  });
  assert.deepEqual(agentSettings, { importSource: "chats" });
  assert.equal(ltmAgentSettingsSchema.safeParse({ importSource: "files" }).success, false);
});
