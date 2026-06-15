import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  ltmEvidenceUnitBucketSchema,
  ltmEvidenceUnitExtractionResponseSchema,
  ltmEvidenceUnitStatusSchema,
  type LtmEvidenceUnit,
  type LtmEvidenceUnitExtractionResponse,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage, ChatOptions } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { stableJsonHash } from "./chunking.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import { compileLtmEvidenceUnits } from "./evidence-unit-compiler.js";
import { validateLtmEvidenceUnits } from "./evidence-unit-validation.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import type { LtmExtractionDiagnostic } from "./validation.js";

export const DEFAULT_LTM_EXTRACTION_PROMPT = [
  "You extract structured long-term memory evidence units from a source note.",
  "Return strict JSON only. Do not explain.",
  "Source notes are audit evidence, not active recall memory.",
  "Do not output source summaries, transcript summaries, or final write operations.",
  "Extract every distinct durable memory unit supported by the source.",
  "Emit zero or more units per bucket. Do not stop after the first valid unit.",
  "Prefer several compact units over one blended paragraph.",
  "Scan bucket groups explicitly: timeline beats (timeline_event); relationships (relationship_event, relationship_state, relationship_conflict); open loops (thread); character and world facts (character_fact, character_state, world_fact); style and motifs (tone, anchor).",
  "Each unit must be compact, typed, and useful for future continuity.",
  "Every unit must include at least one supplied evidence string, including source_note:<id>.",
  "Use real lowercase snake_case subjectId and sectionKey values derived from the source.",
  "Never output placeholder values such as lowercase_snake_case_scope_id, lowercase_snake_case, target_note_id, or copied schema/example text.",
  "Do not copy schema/example placeholder values.",
  "Omit optional fields unless they are real and evidence-backed.",
  "Use timeline_event for historical source-summary scenes or beats; never call those current_scene.",
  "Typed memories may link to timeline_event notes using occurred_in, triggered_by, resolved_in, or evidenced_by.",
  "Keep source-note provenance as source_note evidence; timeline links describe story structure, not source provenance.",
  "Use sourceHash exactly as supplied.",
  "Set confidence and salience from 0 to 1.",
  "For voice/tone quotes, quote only exact text present in the source.",
  "Do not emit current scene, relationship arc, boundary, or preference memories from source-summary extraction.",
  "For enum fields, choose exactly one string from the allowed arrays. Do not join multiple values with |.",
].join("\n");
export const DEFAULT_LTM_EXTRACTION_REASONING_EFFORT = "low" satisfies NonNullable<ChatOptions["reasoningEffort"]>;
export const DEFAULT_LTM_EXTRACTION_VERBOSITY = "low" satisfies NonNullable<ChatOptions["verbosity"]>;
export const DEFAULT_LTM_EXTRACTION_MAX_TOKENS = 8192;
export const DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS = 24_000;
export const DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS = 12_000;
const LTM_EXTRACTION_BUCKET_SCAN_ORDER = [
  "timeline_event",
  "relationship_event",
  "relationship_state",
  "relationship_conflict",
  "thread",
  "character_fact",
  "character_state",
  "world_fact",
  "tone",
  "anchor",
] as const;

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
  extraInstruction?: string;
  systemPrompt?: string;
  reasoningEffort?: NonNullable<ChatOptions["reasoningEffort"]>;
  verbosity?: NonNullable<ChatOptions["verbosity"]>;
  maxOutputTokens?: number;
  temperature?: number;
  maxSourceChars?: number;
  maxExistingNoteChars?: number;
  signal?: AbortSignal;
  operationId?: string;
  allowedBuckets?: LtmEvidenceUnit["bucket"][];
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

function repairTruncatedJson(raw: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  const depth: Array<"object" | "array"> = [];

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    out += ch;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth.push("object");
    } else if (ch === "[") {
      depth.push("array");
    } else if (ch === "}") {
      if (depth.length > 0 && depth[depth.length - 1] === "object") depth.pop();
    } else if (ch === "]") {
      if (depth.length > 0 && depth[depth.length - 1] === "array") depth.pop();
    }
  }

  if (inString) out += '"';
  for (let i = depth.length - 1; i >= 0; i -= 1) {
    out += depth[i] === "object" ? "}" : "]";
  }
  return out;
}

function extractPartialUnits(raw: string): Array<Record<string, unknown>> {
  const units: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            units.push(parsed as Record<string, unknown>);
          }
        } catch {
          // skip unparseable fragments
        }
        start = -1;
      }
    }
  }

  return units;
}

function normalizeEvidenceUnitResponse(raw: unknown, expectedSourceHash: string): unknown {
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
        sourceHash: expectedSourceHash,
      };
    }),
  };
}

function formatExistingNotes(notes: LtmNote[], maxChars = DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS) {
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
    if (used + block.length > maxChars) break;
    used += block.length;
    blocks.push(block);
  }
  return blocks.length ? blocks.join("\n\n---\n\n") : "(no relevant typed notes)";
}

function evidenceUnitMessages(options: RunLongTermMemoryEvidenceUnitExtractionOptions): ChatMessage[] {
  const allowedBuckets = options.allowedBuckets ?? ltmEvidenceUnitBucketSchema.options;
  const filteredScanOrder = LTM_EXTRACTION_BUCKET_SCAN_ORDER.filter((bucket) => allowedBuckets.includes(bucket));
  const allBucketDescriptions: Record<string, string> = {
    timeline_event: "historical source-summary scene or beat; not the live current scene",
    character_fact: "stable character fact",
    character_state: "current character condition, aim, mood, capability, or position",
    relationship_event: "evidence-backed relationship history item",
    relationship_state: "current reduced relationship state",
    relationship_conflict: "unresolved contradiction or instability",
    world_fact: "stable world/lore fact",
    thread: "unresolved situation, question, tension, or goal",
    tone: "durable tone or scene tone",
    anchor: "recurring motif/anchor",
  };
  const filteredBucketDescriptions: Record<string, string> = {};
  for (const bucket of allowedBuckets) {
    const desc = allBucketDescriptions[bucket];
    if (desc) {
      filteredBucketDescriptions[bucket] = desc;
    }
  }

  return [
    {
      role: "system",
      content: options.systemPrompt?.trim() || DEFAULT_LTM_EXTRACTION_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify({
        responseContract: {
          summary: "string, short",
          units: "array of 0..40 evidence unit objects",
        },
        unitFields: {
          id: "uuid",
          bucket: "one allowedBuckets value",
          subjectId: "real lowercase_snake_case subject",
          sectionKey: "real lowercase_snake_case section",
          text: "compact memory text, not transcript summary",
          evidence: "array containing supplied source_note evidence",
          confidence: "0..1",
          salience: "0..1",
          status: "one allowedStatuses value",
          links: "real links only, otherwise []",
          mergeHint: "optional evidence-backed compiler note only",
          sourceHash: options.sourceHash,
        },
        allowedBuckets,
        allowedStatuses: ["active", "resolved"],
        bucketScanOrder: filteredScanOrder,
        allowedTimelineRelations: ["occurred_in", "triggered_by", "resolved_in", "evidenced_by"],
        buckets: filteredBucketDescriptions,
        sourceNote: {
          id: options.sourceNote.id,
          status: options.sourceNote.status,
          tags: options.sourceNote.tags,
          scope: options.sourceNote.scope,
          evidence: evidenceFromSourceNote(options.sourceNote),
          sourceHash: options.sourceHash,
        },
        requiredEvidence: evidenceFromSourceNote(options.sourceNote),
        scope: options.scope,
        modes: options.modes,
        userInstruction: options.instruction?.trim() || undefined,
        extraInstruction: options.extraInstruction?.trim() || undefined,
        existingTypedNotes: formatExistingNotes(options.existingNotes, options.maxExistingNoteChars),
        sourceText: options.sourceText.slice(0, options.maxSourceChars ?? DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS),
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
        maxSourceChars: options.maxSourceChars ?? DEFAULT_LTM_EXTRACTION_MAX_SOURCE_CHARS,
        maxExistingNoteChars: options.maxExistingNoteChars ?? DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_CHARS,
      },
      details: {
        reasoningEffort: options.reasoningEffort ?? DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
        verbosity: options.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY,
        maxOutputTokens: options.maxOutputTokens ?? options.provider.maxTokensOverrideValue ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
        temperature: options.temperature ?? 0,
      },
    });
  try {
    const result = await options.provider.chatComplete(messages, {
      model: options.model,
      temperature: options.temperature ?? 0,
      maxTokens: options.maxOutputTokens ?? options.provider.maxTokensOverrideValue ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
      reasoningEffort: options.reasoningEffort ?? DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
      verbosity: options.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY,
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
        completionReasoningTokens: result.usage?.completionReasoningTokens ?? 0,
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
        normalizeEvidenceUnitResponse(JSON.parse(extractJsonObject(content)), options.sourceHash),
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
    } catch (parseErr) {
      try {
        const repaired = repairTruncatedJson(extractJsonObject(content));
        const parsed = ltmEvidenceUnitExtractionResponseSchema.parse(
          normalizeEvidenceUnitResponse(JSON.parse(repaired), options.sourceHash),
        );
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "llm",
          action: "evidence_unit_json_parse",
          status: "ok",
          sourceNoteId: options.sourceNote.id,
          counts: { units: parsed.units.length, responseChars: content.length },
          details: { recovered: "repaired" },
        });
        return parsed;
      } catch {
        // continue to partial extraction
      }

      const partialObjects = extractPartialUnits(content);
      const rawUnits = partialObjects.flatMap((obj) => {
        if (Array.isArray(obj.units)) return obj.units as Array<Record<string, unknown>>;
        if (typeof obj.bucket === "string") return [obj];
        return [];
      });
      if (rawUnits.length > 0) {
        const syntheticResponse = normalizeEvidenceUnitResponse(
          { summary: "", units: rawUnits },
          options.sourceHash,
        );
        try {
          const parsed = ltmEvidenceUnitExtractionResponseSchema.parse(syntheticResponse);
          await recordLtmDebugEvent({
            operationId: options.operationId,
            phase: "llm",
            action: "evidence_unit_json_parse",
            status: "ok",
            sourceNoteId: options.sourceNote.id,
            counts: { units: parsed.units.length, responseChars: content.length },
            details: { recovered: "partial" },
          });
          return parsed;
        } catch {
          // fall through to final throw
        }
      }

      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "llm",
        action: "evidence_unit_json_parse",
        status: "error",
        sourceNoteId: options.sourceNote.id,
        counts: { responseChars: content.length },
        error: parseErr,
        details: { responseSnippet: content.slice(0, 1_500) },
      });
      throw parseErr;
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
  rejectPlaceholderOutput?: boolean;
}): CompileEvidenceUnitExtractionResult {
  const diagnostics = validateLtmEvidenceUnits({
    units: options.unitResponse.units,
    sourceText: options.sourceText,
    sourceNote: options.sourceNote,
    existingNotes: options.existingNotes,
    expectedSourceHash: options.sourceHash,
    rejectPlaceholderOutput: options.rejectPlaceholderOutput,
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
