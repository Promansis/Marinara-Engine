import type { LtmExtractionDraft, LtmExtractionResponse, LtmMode, LtmNote, LtmScope } from "@marinara-engine/shared";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import {
  compileEvidenceUnitExtraction,
  LongTermMemoryEvidenceUnitDraftStore,
  runLongTermMemoryEvidenceUnitExtraction,
  sourceHashForEvidenceUnitExtraction,
  sourceMetadataForEvidenceUnitDraft,
} from "./evidence-unit-extraction.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
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
  includeExistingNotes?: boolean;
  signal?: AbortSignal;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
};

export type ExtractLongTermMemoryFromSourceNoteResult = {
  sourceNote: LtmNote;
  response: LtmExtractionResponse;
  draft: LtmExtractionDraft | null;
  diagnostics: LtmExtractionDiagnostic[];
};

export function isLtmSourceNote(note: LtmNote) {
  return note.type === "scene" && (note.tags.includes("source_summary") || note.tags.includes("chat_summary"));
}

export function getLtmSourceNoteText(note: LtmNote) {
  return (note.sections.source?.text ?? note.sections.summary?.text ?? "").trim();
}

async function getExistingTypedNotes(options: {
  storage: LongTermMemoryStorage;
  sourceText: string;
  scope: LtmScope;
  includeExistingNotes: boolean;
  embeddingSource?: RetrieveLongTermMemoryInput["embeddingSource"];
}) {
  if (!options.includeExistingNotes) return [];
  const retrieval = await retrieveLongTermMemory({
    queryText: options.sourceText,
    scope: options.scope,
    characterIds: options.scope.characterIds,
    includeSourceNotes: false,
    maxChunks: 12,
    maxTokens: 2400,
    embeddingSource: options.embeddingSource,
  });
  const noteIds = Array.from(new Set(retrieval.chunks.map((chunk) => chunk.chunk.noteId)));
  const notes = await Promise.all(noteIds.map((noteId) => options.storage.getNote(noteId)));
  return notes.filter((note): note is LtmNote => {
    if (!note) return false;
    return !isLtmSourceNote(note);
  });
}

export async function extractLongTermMemoryFromSourceNote(
  options: ExtractLongTermMemoryFromSourceNoteOptions,
): Promise<ExtractLongTermMemoryFromSourceNoteResult> {
  const storage = new LongTermMemoryStorage(options.root);
  const sourceNote = await storage.getNote(options.noteId);
  if (!sourceNote) throw new Error(`Long-term memory note not found: ${options.noteId}`);
  if (!isLtmSourceNote(sourceNote)) throw new Error(`Long-term memory note is not a source note: ${options.noteId}`);

  const sourceText = getLtmSourceNoteText(sourceNote);
  if (!sourceText) throw new Error(`Long-term memory source note has no source text: ${options.noteId}`);

  const scope = options.scope ?? sourceNote.scope;
  const modes = options.modes?.length ? options.modes : sourceNote.modes;
  const existingNotes = await getExistingTypedNotes({
    storage,
    sourceText,
    scope,
    includeExistingNotes: options.includeExistingNotes !== false,
    embeddingSource: options.embeddingSource,
  });
  const sourceHash = sourceHashForEvidenceUnitExtraction(sourceNote);

  const unitResponse = await runLongTermMemoryEvidenceUnitExtraction({
    sourceNote,
    sourceText,
    existingNotes,
    provider: options.provider,
    model: options.model,
    scope,
    modes,
    sourceHash,
    instruction: options.instruction,
    signal: options.signal,
  });
  const compiled = compileEvidenceUnitExtraction({
    unitResponse,
    sourceText,
    sourceNote,
    existingNotes,
    scope,
    modes,
    model: options.model,
    sourceHash,
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
  return { sourceNote, response: compiled.compiledResponse, draft, diagnostics: compiled.diagnostics };
}
