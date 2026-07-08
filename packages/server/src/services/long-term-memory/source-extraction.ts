import {
  isLtmSourceLikeNote,
  DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  type LtmExtractionDraft,
  type LtmExtractionOutcome,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import {
  compileEvidenceUnitExtraction,
  runLongTermMemoryEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
  summarizeCompiledEvidenceUnitExtraction,
  sourceMetadataForEvidenceUnitDraft,
} from "./evidence-unit-extraction.js";
import { getLtmExtractionConfig } from "./extraction-config.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";
import { LongTermMemoryDraftStore } from "./draft-store.js";
import { retrieveLongTermMemory, type RetrieveLongTermMemoryInput } from "./retrieval.js";
import { canUpdateLtmScopedTarget, resolveScopedEvidenceUnitTargets } from "./scoped-targets.js";
import { LongTermMemoryStorage } from "./storage.js";
import { normalizeStructuredSummaryEvidenceUnits } from "./structured-summary-normalizer.js";

const LTM_EXTRACTION_EXISTING_NOTE_CANDIDATE_CHUNKS = 100;

export type ExtractLongTermMemoryFromSourceNoteOptions = {
  noteId: string;
  provider: BaseLLMProvider;
  model: string;
  root?: string;
  scope?: LtmScope;
  modes?: LtmMode[];
  mode?: LtmMode;
  instruction?: string;
  signal?: AbortSignal;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
  operationId?: string;
};

export type ExtractLongTermMemoryFromSourceNoteResult = {
  sourceNote: LtmNote;
  response: LtmExtractionResponse;
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
};

export function isLtmSourceNote(note: LtmNote) {
  return isLtmSourceLikeNote(note);
}

export function getLtmSourceNoteText(note: LtmNote) {
  return (note.sections.source?.text ?? note.sections.summary?.text ?? "").trim();
}

async function getExistingTypedNotes(options: {
  storage: LongTermMemoryStorage;
  root?: string;
  sourceNoteId: string;
  sourceText: string;
  scope: LtmScope;
  maxChunks: number;
  maxTokens: number;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
}) {
  const retrieval = await retrieveLongTermMemory({
    root: options.root,
    queryText: options.sourceText,
    scope: options.scope,
    characterIds: options.scope.characterIds,
    includeSourceNotes: false,
    maxChunks: options.maxChunks,
    maxTokens: options.maxTokens,
    embeddingSource: options.embeddingSource,
  });
  const noteIds = Array.from(new Set(retrieval.chunks.map((chunk) => chunk.chunk.noteId)));
  const notesById = await options.storage.getNotesByIds(noteIds);
  return noteIds.map((noteId) => notesById.get(noteId)).filter((note): note is LtmNote => {
    if (!note) return false;
    if (isLtmSourceNote(note)) return false;
    if (!canUpdateLtmScopedTarget(note.scope, options.scope)) return false;
    return true;
  });
}

export async function extractLongTermMemoryFromSourceNote(
  options: ExtractLongTermMemoryFromSourceNoteOptions,
): Promise<ExtractLongTermMemoryFromSourceNoteResult> {
  return withLtmDebugOperation(
    {
      operationId: options.operationId,
      root: options.root,
      phase: "extraction",
      action: "extract_source_note",
      sourceNoteId: options.noteId,
      model: options.model,
      message: "Extract memory streams from source note",
    },
    async (operationId) => extractLongTermMemoryFromSourceNoteInner({ ...options, operationId }),
  );
}

async function extractLongTermMemoryFromSourceNoteInner(
  options: ExtractLongTermMemoryFromSourceNoteOptions & { operationId: string },
): Promise<ExtractLongTermMemoryFromSourceNoteResult> {
  const storage = new LongTermMemoryStorage(options.root);
  const sourceNote = await storage.getNote(options.noteId);
  if (!sourceNote) {
    logger.warn("[ltm] Source note not found: %s", options.noteId);
    throw new Error(`Long-term memory note not found: ${options.noteId}`);
  }
  if (!isLtmSourceNote(sourceNote)) {
    logger.warn("[ltm] Note %s is not a source note", options.noteId);
    throw new Error(`Long-term memory note is not a source note: ${options.noteId}`);
  }

  const sourceText = getLtmSourceNoteText(sourceNote);
  if (!sourceText) {
    logger.warn("[ltm] Source note %s has no source text", options.noteId);
    throw new Error(`Long-term memory source note has no source text: ${options.noteId}`);
  }

  const scope = options.scope ?? sourceNote.scope;
  const modes = options.modes?.length ? options.modes : sourceNote.modes;
  const resolvedMode = options.mode ?? modes[0] ?? "roleplay";
  const allowedBuckets = [...DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE[resolvedMode]];
  const extractionConfig = await getLtmExtractionConfig(options.root, resolvedMode);
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "source_note",
    action: "source_note_loaded",
    status: "ok",
    sourceNoteId: sourceNote.id,
    counts: {
      sourceChars: sourceText.length,
      sections: Object.keys(sourceNote.sections).length,
      modes: modes.length,
    },
    details: {
      scope,
      tags: sourceNote.tags,
      mode: resolvedMode,
      extractionSettings: {
        reasoningEffort: extractionConfig.reasoningEffort,
        verbosity: extractionConfig.verbosity,
        maxOutputTokens: extractionConfig.maxOutputTokens,
        temperature: extractionConfig.temperature,
        sourceTextPolicy: "full",
        maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
        existingNoteCandidateChunks: LTM_EXTRACTION_EXISTING_NOTE_CANDIDATE_CHUNKS,
        existingNoteMaxTokens: extractionConfig.existingNoteMaxTokens,
        activePromptTemplateId: extractionConfig.activePromptTemplateId,
        usesPromptTemplate: Boolean(extractionConfig.activePromptTemplateId),
        hasPromptOverride: extractionConfig.systemPrompt !== DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[resolvedMode],
        aiKeywordExtraction: extractionConfig.aiKeywordExtraction,
      },
    },
  });
  const existingNotes = await getExistingTypedNotes({
    storage,
    root: options.root,
    sourceNoteId: sourceNote.id,
    sourceText,
    scope,
    maxChunks: LTM_EXTRACTION_EXISTING_NOTE_CANDIDATE_CHUNKS,
    maxTokens: extractionConfig.existingNoteMaxTokens,
    embeddingSource: options.embeddingSource,
  });
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "retrieval",
    action: "existing_notes_loaded",
    status: "ok",
    sourceNoteId: sourceNote.id,
    counts: {
      existingNotes: existingNotes.length,
    },
    details: {
      noteIds: existingNotes.map((note) => note.id).slice(0, 80),
    },
  });
  const sourceHash = sourceHashForEvidenceUnitExtraction(sourceNote);
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "extraction",
    action: "source_hash_ready",
    status: "ok",
    sourceNoteId: sourceNote.id,
    details: { sourceHash },
  });

  const baseExtractionOptions = {
    sourceNote,
    sourceText,
    existingNotes,
    provider: options.provider,
    model: options.model,
    root: options.root,
    scope,
    modes,
    sourceHash,
    instruction: options.instruction,
    systemPrompt: extractionConfig.systemPrompt,
    reasoningEffort: extractionConfig.reasoningEffort,
    verbosity: extractionConfig.verbosity,
    maxOutputTokens: extractionConfig.maxOutputTokens,
    temperature: extractionConfig.temperature,
    maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
    signal: options.signal,
    operationId: options.operationId,
    allowedBuckets,
    mode: resolvedMode,
    aiKeywordExtraction: extractionConfig.aiKeywordExtraction,
  };

  const extractionPayload = await runLongTermMemoryEvidenceUnitExtraction(baseExtractionOptions);
  const normalizedExtraction = normalizeStructuredSummaryEvidenceUnits({
    units: extractionPayload.response.units,
    sourceText,
    sourceNote,
    sourceHash,
    allowedBuckets,
    mode: resolvedMode,
    modes,
  });
  const unitResponse = {
    ...extractionPayload.response,
    units: normalizedExtraction.units,
  };
  const totalCandidates = Math.max(
    extractionPayload.totalCandidates + normalizedExtraction.addedUnits,
    unitResponse.units.length + extractionPayload.droppedCandidates.length,
  );
  const targetResolution = await resolveScopedEvidenceUnitTargets({
    storage,
    existingNotes,
    units: unitResponse.units,
    scope,
  });
  const compilerExistingNotes = targetResolution.existingNotes;
  if (compilerExistingNotes.length !== existingNotes.length || targetResolution.remaps.size > 0) {
    await recordLtmDebugEvent({
      operationId: options.operationId,
      root: options.root,
      phase: "retrieval",
      action: "existing_target_notes_loaded",
      status: targetResolution.remaps.size > 0 ? "warning" : "ok",
      sourceNoteId: sourceNote.id,
      counts: {
        existingNotes: compilerExistingNotes.length,
        addedTargetNotes: compilerExistingNotes.length - existingNotes.length,
        scopedTargetRemaps: targetResolution.remaps.size,
      },
      details: {
        noteIds: compilerExistingNotes.map((note) => note.id).slice(0, 80),
        scopedTargetRemaps: Object.fromEntries(targetResolution.remaps),
      },
    });
  }
  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      ...unitResponse,
      units: targetResolution.units,
    },
    totalCandidates,
    parserDroppedCandidates: extractionPayload.droppedCandidates,
    sourceText,
    sourceNote,
    existingNotes: compilerExistingNotes,
    scope,
    modes: [resolvedMode],
    mode: resolvedMode,
    sourceHash,
    allowedBuckets,
  });
  compiled.diagnostics.push(...targetResolution.diagnostics);
  const compiledSummary = summarizeCompiledEvidenceUnitExtraction(compiled);
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "compiler",
    action: "evidence_units_compiled",
    status: compiledSummary.counts.blockingDiagnostics > 0 ? "warning" : "ok",
    sourceNoteId: sourceNote.id,
    counts: compiledSummary.counts,
    diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    details: {
      mutationKinds: compiledSummary.mutationKinds,
      targetNoteIds: compiledSummary.targetNoteIds,
      summary: compiled.compiledResponse.summary,
    },
  });

  const draft =
    compiled.compiledResponse.mutations.length > 0
      ? await new LongTermMemoryDraftStore(options.root).createDraft({
          scope,
          modes,
          source: sourceMetadataForEvidenceUnitDraft(sourceNote),
          response: compiled.compiledResponse,
        })
      : null;

  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "draft",
    action: draft ? "draft_created" : "draft_skipped",
    status: draft ? "ok" : compiled.outcome.droppedUnits > 0 ? "warning" : "skipped",
    sourceNoteId: sourceNote.id,
    draftId: draft?.id,
      counts: {
        mutations: compiled.compiledResponse.mutations.length,
        diagnostics: compiled.diagnostics.length,
        droppedUnits: compiled.outcome.droppedUnits,
        generatedMutations: compiled.suggestions.generated,
        returnedMutations: compiled.suggestions.returned,
      },
    diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    details: {
      reason: draft ? "created" : compiled.outcome.droppedUnits > 0 ? "dropped_candidates_only" : "no_mutations",
      extractionOutcome: compiled.outcome,
    },
  });
  return {
    sourceNote,
    response: compiled.compiledResponse,
    draft,
    diagnostics: compiled.diagnostics,
    outcome: compiled.outcome,
  };
}
