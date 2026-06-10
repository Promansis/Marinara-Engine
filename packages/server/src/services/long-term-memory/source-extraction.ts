import {
  ltmExtractionResponseSchema,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage } from "../llm/base-provider.js";
import { stableJsonHash } from "./chunking.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
import { retrieveLongTermMemory, type RetrieveLongTermMemoryInput } from "./retrieval.js";
import { LongTermMemoryStorage } from "./storage.js";
import { validateLtmExtractionResponse, type LtmExtractionDiagnostic } from "./validation.js";

const SOURCE_EXTRACTION_MAX_TOKENS = 2400;
const MAX_SOURCE_CHARS = 24_000;
const MAX_CONTEXT_NOTE_CHARS = 12_000;

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

function evidenceFromSourceNote(note: LtmNote) {
  const sectionEvidence = [...(note.sections.source?.evidence ?? []), ...(note.sections.summary?.evidence ?? [])];
  return Array.from(new Set([`source_note:${note.id}`, ...sectionEvidence])).slice(0, 20);
}

function sourceMetadata(note: LtmNote): LtmExtractionDraft["source"] {
  const evidence = evidenceFromSourceNote(note);
  const chatId = evidence.find((item) => item.startsWith("chat:"))?.slice("chat:".length);
  const summaryEntryId = evidence.find((item) => item.startsWith("summary_entry:"))?.slice("summary_entry:".length);
  return {
    ...(chatId ? { chatId } : {}),
    sourceNoteId: note.id,
    ...(summaryEntryId ? { summaryEntryId } : {}),
    sourceHash: stableJsonHash({
      noteId: note.id,
      sections: {
        source: note.sections.source ?? null,
        summary: note.sections.summary ?? null,
      },
    }),
  };
}

function formatExistingNotes(notes: LtmNote[]) {
  let used = 0;
  const blocks: string[] = [];
  for (const note of notes) {
    const sections = Object.entries(note.sections)
      .map(([key, section]) => `${key}: ${section.text}`)
      .join("\n");
    const block = [
      `id: ${note.id}`,
      `type: ${note.type}`,
      `status: ${note.status}`,
      `tags: ${note.tags.join(", ") || "(none)"}`,
      `sections:\n${sections}`,
    ].join("\n");
    if (used + block.length > MAX_CONTEXT_NOTE_CHARS) break;
    used += block.length;
    blocks.push(block);
  }
  return blocks.length ? blocks.join("\n\n---\n\n") : "(no relevant typed notes)";
}

function extractionMessages({
  sourceNote,
  sourceText,
  existingNotes,
  scope,
  modes,
  instruction,
}: {
  sourceNote: LtmNote;
  sourceText: string;
  existingNotes: LtmNote[];
  scope: LtmScope;
  modes: LtmMode[];
  instruction?: string;
}): ChatMessage[] {
  const timestamp = new Date().toISOString();
  return [
    {
      role: "system",
      content: [
        "You extract typed long-term memory draft mutations from editable source notes.",
        "Return only strict JSON matching the supplied shape. Do not explain.",
        "Source notes are evidence, not active memory. Never copy or summarize the full source into a typed note.",
        "Extract only durable continuity useful for future generation.",
        "Use lowercase snake_case section keys accepted by the schema.",
        "Prefer updating existing typed notes over creating duplicates.",
        "Separate current state, character facts, relationships, threads, callbacks, world, voice, and tone.",
        "Callbacks are planted setups with expected payoff. Threads are unresolved situations, questions, goals, or tensions.",
        "Mark spoilers, character secrets, private knowledge, and NSFW content with gates.",
        "Every mutation must include evidence references from the supplied evidence list.",
        "Allowed mutation kinds: create_note, append_section, update_section, add_link, set_status, flag_conflict.",
        "Each mutation kind has different required fields. Follow requiredMutationShapes exactly.",
        "Do not emit placeholders or omit required fields. If you cannot fill every required field for a mutation kind, omit that mutation.",
        "Low risk is only a non-conflicting scene append, neutral link, or high-confidence callback setup. Stable facts and secrets are medium/high risk.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        outputShape: {
          summary: "short human-readable summary of proposed memory updates",
          mutations: [
            {
              id: "uuid",
              kind: "create_note|append_section|update_section|add_link|set_status|flag_conflict",
              risk: "low|medium|high",
              confidence: 0.0,
              summary: "what changes",
              evidence: evidenceFromSourceNote(sourceNote),
            },
          ],
        },
        requiredMutationShapes: {
          create_note: {
            id: "uuid",
            kind: "create_note",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            note: {
              id: "char_name|rel_name_name|scene_name|thread_name|cb_name|world_name|voice_name|tone_name",
              type: "character|relationship|scene|thread|callback|world|voice|tone",
              status: "active|resolved|archived|dormant",
              modes,
              scope,
              tags: ["lowercase_snake_case"],
              links: [{ target: "target_note_id", relation: "lowercase_snake_case" }],
              sections: {
                section_key: {
                  text: "durable memory text",
                  updatedAt: timestamp,
                  salience: 0.5,
                  confidence: 0.5,
                  evidence: evidenceFromSourceNote(sourceNote),
                  gates: ["spoiler|character_secret|private|nsfw"],
                },
              },
            },
          },
          append_section: {
            id: "uuid",
            kind: "append_section",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            noteId: "existing_note_id",
            sectionKey: "lowercase_snake_case",
            text: "text to append",
            salience: 0.5,
            gates: ["spoiler|character_secret|private|nsfw"],
          },
          update_section: {
            id: "uuid",
            kind: "update_section",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            noteId: "existing_note_id",
            sectionKey: "lowercase_snake_case",
            section: {
              text: "replacement section text",
              updatedAt: timestamp,
              salience: 0.5,
              confidence: 0.5,
              evidence: evidenceFromSourceNote(sourceNote),
              gates: ["spoiler|character_secret|private|nsfw"],
            },
          },
          add_link: {
            id: "uuid",
            kind: "add_link",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            noteId: "existing_note_id",
            link: { target: "target_note_id", relation: "lowercase_snake_case" },
          },
          set_status: {
            id: "uuid",
            kind: "set_status",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            noteId: "existing_note_id",
            status: "active|resolved|archived|dormant",
          },
          flag_conflict: {
            id: "uuid",
            kind: "flag_conflict",
            risk: "low|medium|high",
            confidence: 0.0,
            summary: "what changes",
            evidence: evidenceFromSourceNote(sourceNote),
            noteId: "existing_note_id",
            conflict: {
              field: "section_key_or_field",
              existing: "existing value",
              proposed: "proposed value",
              resolution: "pending",
              policy: "manual_review",
            },
          },
        },
        allowedSectionKeysByBucket: {
          CURRENT: ["current_state", "current", "scene_current"],
          CHARACTERS: ["core", "history", "current_state"],
          RELATIONSHIPS: ["state", "history", "recent_shift"],
          THREADS: ["state", "open_questions", "next_steps"],
          CALLBACKS: ["setup", "expected_payoff", "status"],
          WORLD: ["facts", "rules", "places", "objects"],
          VOICE: ["style", "phrases", "mannerisms"],
          TONE: ["current", "durable"],
          SCENE_SOURCE: ["source"],
        },
        sourceNote: {
          id: sourceNote.id,
          type: sourceNote.type,
          status: sourceNote.status,
          tags: sourceNote.tags,
          scope: sourceNote.scope,
          evidence: evidenceFromSourceNote(sourceNote),
        },
        scope,
        modes,
        userInstruction: instruction?.trim() || undefined,
        existingTypedNotes: formatExistingNotes(existingNotes),
        sourceText: sourceText.slice(0, MAX_SOURCE_CHARS),
      }),
    },
  ];
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

async function getExistingTypedNotes(options: {
  storage: LongTermMemoryStorage;
  sourceNote: LtmNote;
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
    sourceNote,
    sourceText,
    scope,
    includeExistingNotes: options.includeExistingNotes !== false,
    embeddingSource: options.embeddingSource,
  });

  const result = await options.provider.chatComplete(
    extractionMessages({
      sourceNote,
      sourceText,
      existingNotes,
      scope,
      modes,
      instruction: options.instruction,
    }),
    {
      model: options.model,
      temperature: 0,
      maxTokens: options.provider.maxTokensOverrideValue ?? SOURCE_EXTRACTION_MAX_TOKENS,
      stream: false,
      signal: options.signal,
    },
  );

  const content = result.content?.trim() ?? "";
  const response = content
    ? ltmExtractionResponseSchema.parse(JSON.parse(extractJsonObject(content)))
    : ltmExtractionResponseSchema.parse({ summary: "", mutations: [] });
  const diagnostics = validateLtmExtractionResponse({ response, sourceText, existingNotes });
  const hasBlockingDiagnostic = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const draft =
    response.mutations.length > 0 && !hasBlockingDiagnostic
      ? await new LongTermMemoryDraftStore(options.root).createDraft({
          userMessage: sourceText,
          assistantReply: "",
          scope,
          modes,
          source: sourceMetadata(sourceNote),
          response,
        })
      : null;

  return { sourceNote, response, draft, diagnostics };
}
