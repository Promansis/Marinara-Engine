import {
  getLtmScopeChatIds,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import {
  compileEvidenceUnitExtraction,
  DEFAULT_LTM_EXTRACTION_PROMPT,
  LongTermMemoryEvidenceUnitDraftStore,
  runLongTermMemoryEvidenceUnitExtraction,
  summarizeCompiledEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
  sourceMetadataForEvidenceUnitDraft,
} from "./evidence-unit-extraction.js";
import {
  LTM_BUCKET_GROUPS,
  mergeGroupedEvidenceUnitResults,
  runGroupedEvidenceUnitExtraction,
  type LtmBucketGroupConfig,
} from "./evidence-unit-groups.js";
import { getLtmExtractionConfig } from "./extraction-config.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
import { noteIdForEvidenceUnit } from "./evidence-unit-validation.js";
import { retrieveLongTermMemory, type RetrieveLongTermMemoryInput } from "./retrieval.js";
import { LongTermMemoryStorage } from "./storage.js";
import type { LtmExtractionDiagnostic } from "./validation.js";

export type ExtractLongTermMemoryFromSourceNoteOptions = {
  noteId: string;
  provider: BaseLLMProvider;
  model: string;
  root?: string;
  scope?: LtmScope;
  modes?: LtmMode[];
  instruction?: string;
  signal?: AbortSignal;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
  operationId?: string;
  useGroupedExtraction?: boolean;
  groupedExtractionGroups?: LtmBucketGroupConfig[];
};

export type ExtractLongTermMemoryFromSourceNoteResult = {
  sourceNote: LtmNote;
  response: LtmExtractionResponse;
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
};

export function isLtmSourceNote(note: LtmNote) {
  return (
    note.type === "source" ||
    (note.type === "scene" && (note.tags.includes("source_summary") || note.tags.includes("chat_summary")))
  );
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
  includeExistingNotes: boolean;
  maxChunks: number;
  maxTokens: number;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
}) {
  if (!options.includeExistingNotes) return [];
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
  const notes = await Promise.all(noteIds.map((noteId) => options.storage.getNote(noteId)));
  return notes.filter((note): note is LtmNote => {
    if (!note) return false;
    if (note.status === "archived") return false;
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
}): Promise<{ notes: LtmNote[]; diagnostics: LtmExtractionDiagnostic[] }> {
  const existingById = new Map(options.existingNotes.map((note) => [note.id, note]));
  const missingTargetIds = Array.from(new Set(options.targetNoteIds.filter((noteId) => !existingById.has(noteId))));
  const diagnostics: LtmExtractionDiagnostic[] = [];
  if (missingTargetIds.length === 0) return { notes: options.existingNotes, diagnostics };

  const targetNotes = await Promise.all(missingTargetIds.map((noteId) => options.storage.getNote(noteId)));
  for (const note of targetNotes) {
    if (!note) continue;
    if (note.status === "archived") continue;
    if (isLtmSourceNote(note)) continue;
    if (!scopeOverlaps(note.scope, options.scope)) {
      diagnostics.push({
        severity: "error",
        code: "target_note_scope_mismatch",
        noteId: note.id,
        message: `Evidence targets existing note ${note.id}, but that note belongs to a different scope.`,
      });
      continue;
    }
    existingById.set(note.id, note);
  }
  return { notes: Array.from(existingById.values()).sort((a, b) => a.id.localeCompare(b.id)), diagnostics };
}

function scopeOverlaps(noteScope: LtmScope, extractionScope: LtmScope) {
  if (scopeIsGlobal(noteScope) || scopeIsGlobal(extractionScope)) return true;
  const noteChatIds = new Set(getLtmScopeChatIds(noteScope));
  const extractionChatIds = getLtmScopeChatIds(extractionScope);
  if (extractionChatIds.some((chatId) => noteChatIds.has(chatId))) return true;

  const noteCharacters = new Set(noteScope.characterIds ?? []);
  if (extractionScope.characterIds?.some((characterId) => noteCharacters.has(characterId))) return true;

  return Boolean(
    (noteScope.groupId && noteScope.groupId === extractionScope.groupId),
  );
}

function scopeIsGlobal(scope: LtmScope) {
  return !(
    getLtmScopeChatIds(scope).length ||
    scope.groupId ||
    scope.rpId ||
    scope.universe ||
    scope.characterIds?.length
  );
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
      message: "Extract typed long-term memory from source note",
    },
    async (operationId) => extractLongTermMemoryFromSourceNoteInner({ ...options, operationId }),
  );
}

async function extractLongTermMemoryFromSourceNoteInner(
  options: ExtractLongTermMemoryFromSourceNoteOptions & { operationId: string },
): Promise<ExtractLongTermMemoryFromSourceNoteResult> {
  const storage = new LongTermMemoryStorage(options.root);
  const sourceNote = await storage.getNote(options.noteId);
  if (!sourceNote) throw new Error(`Long-term memory note not found: ${options.noteId}`);
  if (!isLtmSourceNote(sourceNote)) throw new Error(`Long-term memory note is not a source note: ${options.noteId}`);

  const sourceText = getLtmSourceNoteText(sourceNote);
  if (!sourceText) throw new Error(`Long-term memory source note has no source text: ${options.noteId}`);

  const scope = options.scope ?? sourceNote.scope;
  const modes = options.modes?.length ? options.modes : sourceNote.modes;
  const extractionConfig = await getLtmExtractionConfig(options.root);
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
      extractionSettings: {
        reasoningEffort: extractionConfig.reasoningEffort,
        verbosity: extractionConfig.verbosity,
        maxOutputTokens: extractionConfig.maxOutputTokens,
        temperature: extractionConfig.temperature,
        maxSourceChars: extractionConfig.maxSourceChars,
        maxExistingNoteChars: extractionConfig.maxExistingNoteChars,
        existingNoteMaxChunks: extractionConfig.existingNoteMaxChunks,
        existingNoteMaxTokens: extractionConfig.existingNoteMaxTokens,
        rejectPlaceholderOutput: extractionConfig.rejectPlaceholderOutput,
        hasPromptOverride: extractionConfig.systemPrompt !== DEFAULT_LTM_EXTRACTION_PROMPT,
        hasExtraInstruction: extractionConfig.extraInstruction.length > 0,
      },
    },
  });
  const existingNotes = await getExistingTypedNotes({
    storage,
    root: options.root,
    sourceNoteId: sourceNote.id,
    sourceText,
    scope,
    includeExistingNotes: true,
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
    maxSourceChars: extractionConfig.maxSourceChars,
    maxExistingNoteChars: extractionConfig.maxExistingNoteChars,
    signal: options.signal,
    operationId: options.operationId,
  };

  const unitResponse = options.useGroupedExtraction
    ? mergeGroupedEvidenceUnitResults(
        await runGroupedEvidenceUnitExtraction({
          ...baseExtractionOptions,
          groupedExtractionGroups: options.groupedExtractionGroups,
        }),
      )
    : await runLongTermMemoryEvidenceUnitExtraction(baseExtractionOptions);
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
  const compiled = compileEvidenceUnitExtraction({
    unitResponse,
    sourceText,
    sourceNote,
    existingNotes: compilerExistingNotes,
    scope,
    modes,
    model: options.model,
    sourceHash,
    rejectPlaceholderOutput: extractionConfig.rejectPlaceholderOutput,
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
    },
  });

  const artifactStore = new LongTermMemoryEvidenceUnitDraftStore(options.root);
  const artifact = await artifactStore.createArtifact(compiled.artifact);
  const hasBlockingDiagnostic = compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const draft =
    compiled.compiledResponse.mutations.length > 0 && !hasBlockingDiagnostic
      ? await new LongTermMemoryDraftStore(options.root).createDraft({
          userMessage: sourceText,
          assistantReply: "",
          scope,
          modes,
          source: sourceMetadataForEvidenceUnitDraft(sourceNote),
          response: compiled.compiledResponse,
        })
      : null;

  if (draft) await artifactStore.updateArtifact(artifact.id, { compiledDraftId: draft.id });
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "draft",
    action: draft ? "draft_created" : "draft_skipped",
    status: draft ? "ok" : hasBlockingDiagnostic ? "warning" : "skipped",
    sourceNoteId: sourceNote.id,
    draftId: draft?.id,
    counts: {
      mutations: compiled.compiledResponse.mutations.length,
      diagnostics: compiled.diagnostics.length,
      blockingDiagnostics: compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    },
    diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    details: {
      artifactId: artifact.id,
      reason: draft ? "created" : hasBlockingDiagnostic ? "blocking_diagnostics" : "no_mutations",
    },
  });
  return { sourceNote, response: compiled.compiledResponse, draft, diagnostics: compiled.diagnostics };
}
