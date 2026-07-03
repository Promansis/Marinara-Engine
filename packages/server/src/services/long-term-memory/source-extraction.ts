import {
  isLtmSourceLikeNote,
  isGlobalLtmScope,
  ltmScopesOverlap,
  DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE,
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  type LtmExtractionDroppedCandidate,
  type LtmExtractionDraft,
  type LtmExtractionOutcome,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmEvidenceUnit,
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
import { noteIdForEvidenceUnit } from "./evidence-unit-validation.js";
import { retrieveLongTermMemory, type RetrieveLongTermMemoryInput } from "./retrieval.js";
import { LongTermMemoryStorage } from "./storage.js";

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
    if (!scopeOverlaps(note.scope, options.scope)) return false;
    return true;
  });
}

async function getExistingTypedNotesForTargets(options: {
  storage: LongTermMemoryStorage;
  existingNotes: LtmNote[];
  targetNoteIds: string[];
  scope: LtmScope;
}): Promise<{
  notes: LtmNote[];
  diagnostics: LtmExtractionDiagnostic[];
  droppedTargetNoteIds: string[];
}> {
  const existingById = new Map(options.existingNotes.map((note) => [note.id, note]));
  const missingTargetIds = Array.from(new Set(options.targetNoteIds.filter((noteId) => !existingById.has(noteId))));
  const diagnostics: LtmExtractionDiagnostic[] = [];
  const droppedTargetNoteIds: string[] = [];
  if (missingTargetIds.length === 0) return { notes: options.existingNotes, diagnostics, droppedTargetNoteIds };

  const targetNotesById = await options.storage.getNotesByIds(missingTargetIds);
  const targetNotes = missingTargetIds.map((noteId) => targetNotesById.get(noteId)).filter(Boolean);
  for (const note of targetNotes) {
    if (!note) continue;
    if (isLtmSourceNote(note)) continue;
    if (!scopeOverlaps(note.scope, options.scope)) {
      diagnostics.push({
        severity: "warning",
        code: "target_note_scope_mismatch",
        noteId: note.id,
        message: `Evidence targets existing note ${note.id}, but that note belongs to a different scope.`,
      });
      droppedTargetNoteIds.push(note.id);
      continue;
    }
    existingById.set(note.id, note);
  }
  return {
    notes: Array.from(existingById.values()).sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
    droppedTargetNoteIds,
  };
}

function scopeOverlaps(noteScope: LtmScope, extractionScope: LtmScope) {
  if (isGlobalLtmScope(noteScope) || isGlobalLtmScope(extractionScope)) return true;
  return ltmScopesOverlap(noteScope, extractionScope);
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
        maxSourceTokens: extractionConfig.maxSourceTokens,
        maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
        existingNoteMaxChunks: extractionConfig.existingNoteMaxChunks,
        existingNoteMaxTokens: extractionConfig.existingNoteMaxTokens,
        activePromptTemplateId: extractionConfig.activePromptTemplateId,
        usesPromptTemplate: Boolean(extractionConfig.activePromptTemplateId),
        hasPromptOverride: extractionConfig.systemPrompt !== DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[resolvedMode],
        hasExtraInstruction: extractionConfig.extraInstruction.length > 0,
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
    maxChunks: extractionConfig.existingNoteMaxChunks,
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
    scope,
    modes,
    sourceHash,
    instruction: options.instruction,
    extraInstruction: extractionConfig.extraInstruction,
    systemPrompt: extractionConfig.systemPrompt,
    reasoningEffort: extractionConfig.reasoningEffort,
    verbosity: extractionConfig.verbosity,
    maxOutputTokens: extractionConfig.maxOutputTokens,
    temperature: extractionConfig.temperature,
    maxSourceTokens: extractionConfig.maxSourceTokens,
    maxExistingNoteTokens: extractionConfig.maxExistingNoteTokens,
    signal: options.signal,
    operationId: options.operationId,
    allowedBuckets,
    mode: resolvedMode,
    aiKeywordExtraction: extractionConfig.aiKeywordExtraction,
  };

  const extractionPayload = await runLongTermMemoryEvidenceUnitExtraction(baseExtractionOptions);
  const unitResponse = extractionPayload.response;
  const targetLookup = await getExistingTypedNotesForTargets({
    storage,
    existingNotes,
    targetNoteIds: unitResponse.units.map(noteIdForEvidenceUnit),
    scope,
  });
  const compilerExistingNotes = targetLookup.notes;
  if (compilerExistingNotes.length !== existingNotes.length) {
    await recordLtmDebugEvent({
      operationId: options.operationId,
      root: options.root,
      phase: "retrieval",
      action: "existing_target_notes_loaded",
      status: "ok",
      sourceNoteId: sourceNote.id,
      counts: {
        existingNotes: compilerExistingNotes.length,
        addedTargetNotes: compilerExistingNotes.length - existingNotes.length,
      },
      details: {
        noteIds: compilerExistingNotes.map((note) => note.id).slice(0, 80),
      },
    });
  }
  const scopedUnits = unitResponse.units.filter((unit) => !targetLookup.droppedTargetNoteIds.includes(noteIdForEvidenceUnit(unit)));
  const droppedScopeCandidates: LtmExtractionDroppedCandidate[] = unitResponse.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => targetLookup.droppedTargetNoteIds.includes(noteIdForEvidenceUnit(unit)))
    .map(({ unit, index }) => ({
      index,
      reason: "target_note_outside_scope" as const,
      message: "Dropped a candidate that targeted a memory outside this source's scope.",
      snippet: unit.text.length > 280 ? `${unit.text.slice(0, 277).trim()}...` : unit.text,
      recovery: {
        noteType:
          unit.bucket.startsWith("relationship_")
            ? "relationship"
            : unit.bucket === "timeline_event"
              ? "timeline_event"
              : unit.bucket === "thread"
                ? "thread"
                : unit.bucket === "world_fact"
                  ? "world"
                  : unit.bucket === "tone"
                    ? "tone"
                    : unit.bucket === "anchor"
                      ? noteIdForEvidenceUnit(unit).startsWith("tone_")
                        ? "tone"
                        : "world"
                      : "character",
        noteId: noteIdForEvidenceUnit(unit),
        sectionKey:
          unit.bucket === "timeline_event"
            ? unit.sectionKey || "event"
            : unit.bucket === "relationship_state"
                ? "state"
                : unit.bucket === "character_fact"
                    ? unit.sectionKey || "facts"
                    : unit.bucket === "tone"
                      ? "observations"
                      : unit.bucket === "thread" && unit.status === "resolved"
                        ? "summary"
                        : unit.sectionKey,
        status:
          unit.status === "archived"
            ? "archived"
            : unit.status === "resolved"
              ? "resolved"
              : "active",
      },
    }));
  const compiled = compileEvidenceUnitExtraction({
    unitResponse: {
      ...unitResponse,
      units: scopedUnits,
    },
    totalCandidates: extractionPayload.totalCandidates,
    parserDroppedCandidates: [...extractionPayload.droppedCandidates, ...droppedScopeCandidates],
    sourceText,
    sourceNote,
    existingNotes: compilerExistingNotes,
    scope,
    modes: [resolvedMode],
    mode: resolvedMode,
    sourceHash,
  });
  compiled.diagnostics.push(...targetLookup.diagnostics);
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
      suggestionCap: compiled.outcome.suggestionCap,
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
        generatedMutations: compiled.outcome.suggestionCap?.generated ?? compiled.compiledResponse.mutations.length,
        returnedMutations: compiled.outcome.suggestionCap?.returned ?? compiled.compiledResponse.mutations.length,
        cappedMutations: compiled.outcome.suggestionCap?.capped ?? 0,
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
