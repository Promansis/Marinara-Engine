import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  ltmEvidenceUnitBucketSchema,
  ltmEvidenceUnitExtractionResponseSchema,
  ltmEvidenceUnitStatusSchema,
  ltmGateSchema,
  type LtmEvidenceUnit,
  type LtmEvidenceUnitExtractionResponse,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { stableJsonHash } from "./chunking.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import { compileLtmEvidenceUnits } from "./evidence-unit-compiler.js";
import { validateLtmEvidenceUnits } from "./evidence-unit-validation.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import type { LtmExtractionDiagnostic } from "./validation.js";

const EVIDENCE_UNIT_EXTRACTION_MAX_TOKENS = 3200;
const MAX_SOURCE_CHARS = 24_000;
const MAX_CONTEXT_NOTE_CHARS = 12_000;

export interface RunLongTermMemoryEvidenceUnitExtractionOptions {
  sourceNote: LtmNote;
  sourceText: string;
  existingNotes: LtmNote[];
  provider: BaseLLMProvider;
  model: string;
  scope: LtmScope;
  modes: LtmMode[];
  sourceHash: string;
  instruction?: string;
  signal?: AbortSignal;
  operationId?: string;
}

export interface LtmEvidenceUnitDraftArtifact {
  id: string;
  sourceNoteId: string;
  sourceHash: string;
  createdAt: string;
  model: string;
  summary: string;
  units: LtmEvidenceUnit[];
  diagnostics: LtmExtractionDiagnostic[];
  compiledDraftId?: string;
}

export interface CompileEvidenceUnitExtractionResult {
  unitResponse: LtmEvidenceUnitExtractionResponse;
  compiledResponse: LtmExtractionResponse;
  diagnostics: LtmExtractionDiagnostic[];
  artifact: LtmEvidenceUnitDraftArtifact;
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function evidenceFromSourceNote(note: LtmNote) {
  const sectionEvidence = [...(note.sections.source?.evidence ?? []), ...(note.sections.summary?.evidence ?? [])];
  return Array.from(new Set([`source_note:${note.id}`, ...sectionEvidence])).slice(0, 20);
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

function normalizeEvidenceUnitResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const parsed = raw as Record<string, unknown>;
  const units = Array.isArray(parsed.units) ? parsed.units : [];
  return {
    ...parsed,
    units: units.map((unit) => {
      if (!unit || typeof unit !== "object" || Array.isArray(unit)) return unit;
      const record = unit as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : randomUUID();
      return {
        ...record,
        id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : randomUUID(),
      };
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

function evidenceUnitMessages(options: RunLongTermMemoryEvidenceUnitExtractionOptions): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You extract structured long-term memory evidence units from a dormant source note.",
        "Return only strict JSON matching outputShape. Do not explain.",
        "Source notes are audit evidence, not active recall memory.",
        "Do not output source summaries, transcript summaries, or final write operations.",
        "Each unit must be compact, typed, and useful for future continuity.",
        "Every unit must include at least one supplied evidence string, including source_note:<id>.",
        "Use lowercase snake_case subjectId and sectionKey.",
        "Use sourceHash exactly as supplied.",
        "Set confidence and salience from 0 to 1.",
        "Mark spoilers, character secrets, private knowledge, and NSFW content with gates.",
        "For voice/tone quotes, quote only exact text present in the source.",
        "Use current_scene only for the current transient scene state, not the source note.",
        "For enum fields, choose exactly one string from the allowed arrays. Do not join multiple values with |.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        outputShape: {
          summary: "short summary of extracted evidence units",
          units: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              bucket: "relationship_event",
              subjectId: "lowercase_snake_case_scope_id",
              sectionKey: "lowercase_snake_case",
              text: "compact typed memory text",
              evidence: evidenceFromSourceNote(options.sourceNote),
              confidence: 0.8,
              salience: 0.6,
              status: "active",
              gates: ["private"],
              links: [{ target: "target_note_id", relation: "lowercase_snake_case" }],
              mergeHint: "optional note for deterministic compiler",
              sourceHash: options.sourceHash,
            },
          ],
        },
        allowedBuckets: ltmEvidenceUnitBucketSchema.options,
        allowedStatuses: ltmEvidenceUnitStatusSchema.options,
        allowedGates: ltmGateSchema.options,
        buckets: {
          character_fact: "stable character fact",
          character_state: "current character condition, aim, mood, capability, or position",
          relationship_event: "evidence-backed relationship history item",
          relationship_state: "current reduced relationship state",
          relationship_arc: "compressed trajectory across events",
          relationship_conflict: "unresolved contradiction or instability",
          world_fact: "stable world/lore fact",
          thread: "unresolved situation, question, tension, or goal",
          callback: "setup expected to pay off later",
          current_scene: "current transient scene state",
          voice: "speaker style, phrases, mannerisms",
          tone: "durable tone or scene tone",
          anchor: "recurring motif/anchor",
          boundary: "hard user/character boundary",
          preference: "preference useful for future generation",
        },
        sourceNote: {
          id: options.sourceNote.id,
          status: options.sourceNote.status,
          tags: options.sourceNote.tags,
          scope: options.sourceNote.scope,
          evidence: evidenceFromSourceNote(options.sourceNote),
          sourceHash: options.sourceHash,
        },
        scope: options.scope,
        modes: options.modes,
        userInstruction: options.instruction?.trim() || undefined,
        existingTypedNotes: formatExistingNotes(options.existingNotes),
        sourceText: options.sourceText.slice(0, MAX_SOURCE_CHARS),
      }),
    },
  ];
}

export async function runLongTermMemoryEvidenceUnitExtraction(
  options: RunLongTermMemoryEvidenceUnitExtractionOptions,
): Promise<LtmEvidenceUnitExtractionResponse> {
  const messages = evidenceUnitMessages(options);
  const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
  const started = Date.now();
  await recordLtmDebugEvent({
    operationId: options.operationId,
    phase: "llm",
    action: "evidence_unit_request",
    status: "started",
    sourceNoteId: options.sourceNote.id,
    provider: options.provider.constructor.name,
    model: options.model,
    counts: {
      messages: messages.length,
      promptChars,
      sourceChars: options.sourceText.length,
      existingNotes: options.existingNotes.length,
    },
  });
  try {
    const result = await options.provider.chatComplete(messages, {
      model: options.model,
      temperature: 0,
      maxTokens: options.provider.maxTokensOverrideValue ?? EVIDENCE_UNIT_EXTRACTION_MAX_TOKENS,
      stream: false,
      signal: options.signal,
    });

    const content = result.content?.trim() ?? "";
    await recordLtmDebugEvent({
      operationId: options.operationId,
      phase: "llm",
      action: "evidence_unit_response",
      status: content ? "ok" : "skipped",
      sourceNoteId: options.sourceNote.id,
      provider: options.provider.constructor.name,
      model: options.model,
      durationMs: Date.now() - started,
      counts: {
        responseChars: content.length,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
      },
      details: {
        finishReason: result.finishReason,
        responseSnippet: content.slice(0, 1_500),
      },
    });
    if (!content) return ltmEvidenceUnitExtractionResponseSchema.parse({ summary: "", units: [] });
    try {
      const parsed = ltmEvidenceUnitExtractionResponseSchema.parse(
        normalizeEvidenceUnitResponse(JSON.parse(extractJsonObject(content))),
      );
      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "llm",
        action: "evidence_unit_json_parse",
        status: "ok",
        sourceNoteId: options.sourceNote.id,
        counts: { units: parsed.units.length, responseChars: content.length },
      });
      return parsed;
    } catch (err) {
      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "llm",
        action: "evidence_unit_json_parse",
        status: "error",
        sourceNoteId: options.sourceNote.id,
        counts: { responseChars: content.length },
        error: err,
        details: { responseSnippet: content.slice(0, 1_500) },
      });
      throw err;
    }
  } catch (err) {
    await recordLtmDebugEvent({
      operationId: options.operationId,
      phase: "llm",
      action: "evidence_unit_request",
      status: "error",
      sourceNoteId: options.sourceNote.id,
      provider: options.provider.constructor.name,
      model: options.model,
      durationMs: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export function compileEvidenceUnitExtraction(options: {
  unitResponse: LtmEvidenceUnitExtractionResponse;
  sourceText: string;
  sourceNote: LtmNote;
  existingNotes: LtmNote[];
  scope: LtmScope;
  modes: LtmMode[];
  model: string;
  sourceHash: string;
}): CompileEvidenceUnitExtractionResult {
  const diagnostics = validateLtmEvidenceUnits({
    units: options.unitResponse.units,
    sourceText: options.sourceText,
    sourceNote: options.sourceNote,
    existingNotes: options.existingNotes,
    expectedSourceHash: options.sourceHash,
  });
  const hasBlockingDiagnostic = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const compiledResponse = hasBlockingDiagnostic
    ? { summary: options.unitResponse.summary, mutations: [] }
    : compileLtmEvidenceUnits({
        units: options.unitResponse.units,
        existingNotes: options.existingNotes,
        scope: options.scope,
        modes: options.modes,
        summary: options.unitResponse.summary,
      });
  return {
    unitResponse: options.unitResponse,
    compiledResponse,
    diagnostics,
    artifact: {
      id: randomUUID(),
      sourceNoteId: options.sourceNote.id,
      sourceHash: options.sourceHash,
      createdAt: new Date().toISOString(),
      model: options.model,
      summary: options.unitResponse.summary,
      units: options.unitResponse.units,
      diagnostics,
    },
  };
}

export function summarizeCompiledEvidenceUnitExtraction(result: CompileEvidenceUnitExtractionResult) {
  const targetNoteIds = result.compiledResponse.mutations.flatMap((mutation) =>
    mutation.kind === "create_note" ? [mutation.note.id] : [mutation.noteId],
  );
  return {
    counts: {
      units: result.unitResponse.units.length,
      diagnostics: result.diagnostics.length,
      blockingDiagnostics: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
      mutations: result.compiledResponse.mutations.length,
      targetNotes: new Set(targetNoteIds).size,
    },
    mutationKinds: countBy(result.compiledResponse.mutations.map((mutation) => mutation.kind)),
    targetNoteIds: Array.from(new Set(targetNoteIds)).slice(0, 80),
  };
}

export class LongTermMemoryEvidenceUnitDraftStore {
  readonly root: string;

  constructor(root = getLongTermMemoryRoot()) {
    this.root = root;
  }

  private get dirs() {
    return getLongTermMemoryDirectories(this.root);
  }

  async createArtifact(artifact: LtmEvidenceUnitDraftArtifact) {
    await writeJsonAtomic(safeJoin(this.dirs.evidenceUnitDrafts, `${artifact.id}.json`), artifact);
    logger.info("[ltm] Stored evidence unit draft %s with %d unit(s)", artifact.id, artifact.units.length);
    return artifact;
  }

  async updateArtifact(id: string, patch: Partial<LtmEvidenceUnitDraftArtifact>) {
    const existing = await this.getArtifact(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    await writeJsonAtomic(safeJoin(this.dirs.evidenceUnitDrafts, `${id}.json`), next);
    return next;
  }

  async getArtifact(id: string) {
    return readJsonFile(safeJoin(this.dirs.evidenceUnitDrafts, `${id}.json`), null).then((value) =>
      value ? (value as LtmEvidenceUnitDraftArtifact) : null,
    );
  }

  async listArtifacts() {
    const entries = await readdir(this.dirs.evidenceUnitDrafts, { withFileTypes: true }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    });
    const artifacts: LtmEvidenceUnitDraftArtifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      artifacts.push(JSON.parse(await readFile(safeJoin(this.dirs.evidenceUnitDrafts, entry.name), "utf8")));
    }
    return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
}

export function sourceHashForEvidenceUnitExtraction(note: LtmNote) {
  return stableJsonHash({
    noteId: note.id,
    sections: {
      source: note.sections.source ?? null,
      summary: note.sections.summary ?? null,
    },
  });
}

export function sourceMetadataForEvidenceUnitDraft(note: LtmNote): LtmExtractionDraft["source"] {
  const evidence = evidenceFromSourceNote(note);
  const chatId = evidence.find((item) => item.startsWith("chat:"))?.slice("chat:".length);
  const summaryEntryId = evidence.find((item) => item.startsWith("summary_entry:"))?.slice("summary_entry:".length);
  return {
    ...(chatId ? { chatId } : {}),
    sourceNoteId: note.id,
    ...(summaryEntryId ? { summaryEntryId } : {}),
    sourceHash: sourceHashForEvidenceUnitExtraction(note),
  };
}
