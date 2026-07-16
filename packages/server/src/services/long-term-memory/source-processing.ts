import type {
  LtmExtractionAccounting,
  LtmExtractionDiagnostic,
  LtmExtractionDraft,
  LtmExtractionOutcome,
  LtmExtractionResponse,
  LtmImportedSourceResult,
  LtmInteropSource,
  LtmMode,
  LtmNote,
  LtmScope,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { withConcurrency } from "../../lib/concurrency.js";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import { directIngestGameJournal } from "./direct-ingest.js";
import type { LtmInteropSourceNoteImport } from "./maintenance.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { applyLongTermMemoryDraft } from "./reconciliation.js";
import {
  extractLongTermMemoryFromSourceNote,
  finalizeLongTermMemoryExtractionDraft,
} from "./source-extraction.js";
import { LongTermMemoryStorage } from "./storage.js";
import { loadTrustedLtmSubjectCatalog } from "./subject-identity.js";

type PreparedSource = {
  extractionMethod: "llm" | "direct_ingest";
  sourceNote: LtmNote;
  extractionMode: LtmMode;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
  accounting: LtmExtractionAccounting;
  response: LtmExtractionResponse;
  draft: LtmExtractionDraft | null;
  appliedMutationIds: string[];
  skippedMutationIds: string[];
};

type ProcessSourceOptions = {
  db: DB;
  sourceNote: LtmNote;
  provider?: BaseLLMProvider | null;
  model?: string;
  scope?: LtmScope;
  modes?: LtmMode[];
  mode?: LtmMode;
  instruction?: string;
  operationId: string;
  signal?: AbortSignal;
  applyLowRisk?: boolean;
  root?: string;
};

type PrepareSourceOptions = ProcessSourceOptions & { persistDraft?: boolean };

function sourceProcessingAbortError() {
  const error = new Error("Long-term memory import was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfSourceProcessingAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw sourceProcessingAbortError();
}

function isSourceProcessingAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function extractionCanMarkSourceCurrent(input: {
  response: { mutations: unknown[] };
  diagnostics: Array<{ severity: "warning" | "error" }>;
  outcome: { state: string; droppedUnits: number };
}) {
  if (input.response.mutations.length > 0) return true;
  return input.outcome.state === "no_suggestions_created" && input.outcome.droppedUnits === 0 && input.diagnostics.length === 0;
}

async function markSourceExtractionCurrent(
  storage: LongTermMemoryStorage,
  note: LtmNote,
  fingerprint: NonNullable<LtmNote["extractionFingerprint"]> | undefined,
  summary: string,
) {
  if (!fingerprint) return note;
  return storage.updateNote(
    note.id,
    { extractionFingerprint: fingerprint },
    {
      actor: "maintenance_api",
      cause: "source_extraction.completed",
      summary,
    },
  );
}

async function prepareLongTermMemorySource(options: PrepareSourceOptions): Promise<PreparedSource> {
  throwIfSourceProcessingAborted(options.signal);
  if (options.sourceNote.tags.includes("imported_game_journal")) {
    const result = await directIngestGameJournal(options.db, options.sourceNote, options.root, options.operationId, {
      applyLowRisk: options.applyLowRisk,
      persistDraft: options.persistDraft,
      signal: options.signal,
    });
    throwIfSourceProcessingAborted(options.signal);
    return { ...result, extractionMethod: "direct_ingest" };
  }

  if (!options.provider) {
    throw new Error("No LLM provider available for non-game source note extraction");
  }
  const scope = options.scope ?? options.sourceNote.scope;
  const trustedSubjectCatalog = await loadTrustedLtmSubjectCatalog(options.db, scope, options.root);
  const result = await extractLongTermMemoryFromSourceNote({
    noteId: options.sourceNote.id,
    provider: options.provider,
    model: options.model ?? "",
    root: options.root,
    scope,
    modes: options.modes ?? options.sourceNote.modes,
    mode: options.mode,
    instruction: options.instruction,
    operationId: options.operationId,
    signal: options.signal,
    trustedSubjectCatalog,
    persistDraft: options.persistDraft,
  });
  throwIfSourceProcessingAborted(options.signal);
  return {
    ...result,
    extractionMethod: "llm",
    appliedMutationIds: [],
    skippedMutationIds: [],
  };
}

export async function processLongTermMemorySource(options: ProcessSourceOptions) {
  const prepared = await prepareLongTermMemorySource({ ...options, persistDraft: true });
  const applyResult =
    prepared.extractionMethod === "llm" &&
    options.applyLowRisk &&
    prepared.draft &&
    prepared.draft.mutations.length > 0
      ? await applyLongTermMemoryDraft(prepared.draft.id, {
          root: options.root,
          actor: "maintenance_api",
          autoApplyLowRiskOnly: true,
          operationId: options.operationId,
        })
      : null;
  const draft = applyResult?.draft ?? prepared.draft;
  const appliedMutationIds = applyResult?.appliedMutationIds ?? prepared.appliedMutationIds;
  const skippedMutationIds = applyResult?.skippedMutationIds ?? prepared.skippedMutationIds;
  if (extractionCanMarkSourceCurrent(prepared)) {
    await markSourceExtractionCurrent(
      new LongTermMemoryStorage(options.root),
      prepared.sourceNote,
      draft?.source.extractionFingerprint,
      `Completed extraction for ${prepared.sourceNote.title ?? prepared.sourceNote.id}`,
    );
  }
  await rebuildLongTermMemoryIndexes({
    root: options.root,
    scope: prepared.extractionMethod === "direct_ingest" && appliedMutationIds.length > 0 ? "all" : "source",
  });

  return {
    operationId: options.operationId,
    draft,
    diagnostics: prepared.diagnostics,
    outcome: prepared.outcome,
    accounting: prepared.accounting,
    response: prepared.response,
    appliedMutationIds,
    skippedMutationIds,
  };
}

type ProcessSourceBatchOptions = {
  db: DB;
  source: LtmInteropSource;
  items: LtmInteropSourceNoteImport[];
  provider?: BaseLLMProvider | null;
  model?: string;
  mode?: LtmMode;
  instruction?: string;
  operationId: string;
  signal: AbortSignal;
  applyLowRisk?: boolean;
  concurrency: number;
  root?: string;
};

function failedImportedSourceResult(
  item: LtmInteropSourceNoteImport,
  extractionMethod: "llm" | "direct_ingest",
  stage: "extract" | "finalize",
  error: unknown,
  cancelled: boolean,
  prepared?: PreparedSource,
): LtmImportedSourceResult {
  const message = error instanceof Error ? error.message : `Failed to ${stage} imported source`;
  const base = {
    sourceId: item.sourceId,
    title: item.title,
    note: item.note,
    created: item.created,
    sourceWriteStatus: item.created ? ("created" as const) : ("refreshed" as const),
    extractionMethod,
    retryable: true as const,
    draft: null,
    outcome: prepared?.outcome ?? {
      state: "no_suggestions_created" as const,
      totalCandidates: 0,
      keptUnits: 0,
      droppedUnits: 0,
      droppedCandidates: [],
    },
    accounting: prepared?.accounting ?? {
      providerCandidates: 0,
      normalizedAdditions: 0,
      parserRejections: 0,
      validationRejections: 0,
      deduplications: 0,
      keptUnits: 0,
    },
    appliedMutationIds: [],
    skippedMutationIds: [],
  };
  if (cancelled) {
    return {
      ...base,
      extractionStatus: "cancelled",
      error: { code: "cancelled", message },
      diagnostics: [...(prepared?.diagnostics ?? []), { severity: "warning", code: "cancelled", message }],
    };
  }
  const code = `${stage}_failed`;
  return {
    ...base,
    extractionStatus: "failed",
    error: { code, message },
    diagnostics: [...(prepared?.diagnostics ?? []), { severity: "error", code, message }],
  };
}

export async function processLongTermMemorySourceBatch(
  options: ProcessSourceBatchOptions,
): Promise<LtmImportedSourceResult[]> {
  const tasks = options.items.map((item) => async () => {
    try {
      const prepared = await prepareLongTermMemorySource({
        db: options.db,
        sourceNote: item.note,
        provider: options.provider,
        model: options.model,
        mode: options.mode,
        instruction: options.instruction,
        operationId: options.operationId,
        signal: options.signal,
        applyLowRisk: false,
        persistDraft: false,
        root: options.root,
      });
      return { state: "prepared" as const, item, prepared };
    } catch (error) {
      const cancelled = options.signal.aborted || isSourceProcessingAbortError(error);
      await recordLtmDebugEvent({
        root: options.root,
        operationId: options.operationId,
        phase: "extraction",
        action: "imported_source_extract",
        status: cancelled ? "warning" : "error",
        source: options.source,
        sourceId: item.sourceId,
        sourceNoteId: item.note.id,
        error,
      });
      return {
        state: "failed" as const,
        result: failedImportedSourceResult(
          item,
          item.note.tags.includes("imported_game_journal") ? "direct_ingest" : "llm",
          "extract",
          error,
          cancelled,
        ),
      };
    }
  });
  const preparedResults = await withConcurrency(tasks, Math.max(options.concurrency, 1));
  const storage = new LongTermMemoryStorage(options.root);
  const overlay = new Map<string, LtmNote>();
  const results: LtmImportedSourceResult[] = [];

  for (const preparedResult of preparedResults) {
    if (preparedResult.state === "failed") {
      results.push(preparedResult.result);
      continue;
    }
    const { item, prepared } = preparedResult;
    try {
      throwIfSourceProcessingAborted(options.signal);
      const draft = await finalizeLongTermMemoryExtractionDraft(
        {
          sourceNote: prepared.sourceNote,
          response: prepared.response,
          scope: prepared.sourceNote.scope,
          modes: prepared.sourceNote.modes,
          extractionMode: prepared.extractionMode,
          operationId: options.operationId,
          diagnostics: prepared.diagnostics,
          outcome: prepared.outcome,
          accounting: prepared.accounting,
        },
        { root: options.root, overlay },
      );
      await recordLtmDebugEvent({
        root: options.root,
        operationId: options.operationId,
        phase: "draft",
        action: "draft_created",
        status: "ok",
        source: options.source,
        sourceId: item.sourceId,
        sourceNoteId: prepared.sourceNote.id,
        draftId: draft.id,
        counts: {
          mutations: draft.mutations.length,
          diagnostics: prepared.diagnostics.length,
          droppedUnits: prepared.outcome.droppedUnits,
          generatedMutations: draft.mutations.length,
          returnedMutations: draft.mutations.length,
        },
        diagnostics: prepared.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        details: { reason: "created_for_batch_overlay", extractionOutcome: prepared.outcome },
      });
      const applyResult =
        options.applyLowRisk && draft.mutations.length > 0
          ? await applyLongTermMemoryDraft(draft.id, {
              root: options.root,
              actor: "maintenance_api",
              autoApplyLowRiskOnly: true,
              rebuildIndexes: false,
              operationId: options.operationId,
            })
          : null;
      const finalDraft = applyResult?.draft ?? draft;
      const extractedNote = extractionCanMarkSourceCurrent(prepared)
        ? await markSourceExtractionCurrent(
            storage,
            prepared.sourceNote,
            finalDraft.source.extractionFingerprint,
            `Completed extraction for ${item.title}`,
          )
        : prepared.sourceNote;
      results.push({
        sourceId: item.sourceId,
        title: item.title,
        note: extractedNote,
        created: item.created,
        sourceWriteStatus: item.created ? "created" : "refreshed",
        extractionStatus: "succeeded",
        extractionMethod: prepared.extractionMethod,
        retryable: false,
        draft: finalDraft,
        diagnostics: prepared.diagnostics,
        outcome: prepared.outcome,
        accounting: prepared.accounting,
        appliedMutationIds: applyResult?.appliedMutationIds ?? [],
        skippedMutationIds: applyResult?.skippedMutationIds ?? [],
      });
    } catch (error) {
      const cancelled = options.signal.aborted || isSourceProcessingAbortError(error);
      await recordLtmDebugEvent({
        root: options.root,
        operationId: options.operationId,
        phase: "draft",
        action: "imported_source_finalize",
        status: cancelled ? "warning" : "error",
        source: options.source,
        sourceId: item.sourceId,
        sourceNoteId: item.note.id,
        error,
      });
      results.push(
        failedImportedSourceResult(item, prepared.extractionMethod, "finalize", error, cancelled, prepared),
      );
    }
  }

  const totalApplied = results.reduce((sum, result) => sum + result.appliedMutationIds.length, 0);
  if (options.items.length > 0) {
    const scope = totalApplied > 0 ? "all" : "source";
    const rebuildResult = await rebuildLongTermMemoryIndexes({ root: options.root, scope });
    await recordLtmDebugEvent({
      root: options.root,
      operationId: options.operationId,
      phase: "rebuild",
      action: "import_batch_rebuild",
      status: "ok",
      counts: {
        sourceNotes: options.items.length,
        appliedMutations: totalApplied,
        notes: rebuildResult.noteCount,
        chunks: rebuildResult.chunkCount,
        sourceChunks: rebuildResult.sourceChunkCount,
      },
      details: { scope },
    });
  }
  return results;
}
