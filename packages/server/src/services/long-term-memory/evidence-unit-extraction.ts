import { randomUUID } from "node:crypto";
import {
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE,
  DEFAULT_LTM_STREAM_DESCRIPTIONS_BY_MODE,
  DEFAULT_LTM_EXTRACTION_PROMPT_GAME_REFINE,
  LTM_DRAFT_MUTATION_LIMIT,
  RELATIONSHIP_DIMENSIONS,
  ltmEvidenceUnitExtractionResponseSchema,
  ltmEvidenceUnitSchema,
  type LtmEvidenceUnit,
  type LtmEvidenceUnitExtractionResponse,
  type LtmExtractionDroppedCandidate,
  type LtmExtractionOutcome,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage, ChatOptions } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import { countBy, safeSnippet } from "./ltm-utils.js";
import { DEFAULT_LTM_EXTRACTION_PROMPT } from "@marinara-engine/shared";
import { stableJsonHash } from "./chunking.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";
import { deduplicateUnits } from "./dedup.js";
import { compileLtmEvidenceUnits } from "./evidence-unit-compiler.js";
import type { LtmSuggestionCapMetadata } from "./evidence-unit-compiler.js";
import { validateLtmEvidenceUnits } from "./evidence-unit-validation.js";
import { normalizeStructuredSummaryEvidenceUnits } from "./structured-summary-normalizer.js";

const LTM_EXTRACTION_BUCKET_SCAN_ORDER = [
  "timeline_event",
  "relationship_state",
  "thread",
  "character_fact",
  "world_fact",
  "tone",
  "anchor",
] as const;
export const DEFAULT_LTM_EVIDENCE_UNIT_ALLOWED_BUCKETS = [
  "timeline_event",
  "character_fact",
  "relationship_state",
  "world_fact",
  "thread",
  "tone",
  "anchor",
] as const satisfies LtmEvidenceUnit["bucket"][];

const LTM_EXTRACTION_IMPORTANCE_VALUES = ["critical", "major", "moderate", "minor"] as const;
const LTM_EXTRACTION_LINK_RELATIONS = [
  "occurred_in",
  "triggered_by",
  "resolved_in",
  "evidenced_by",
  "affects_relationship",
  "affects_character",
  "caused_by",
  "involves",
  "blocks",
  "planted_in",
  "paid_off_in",
  "extracted_from",
] as const;

export interface RunLongTermMemoryEvidenceUnitExtractionOptions {
  sourceNote: LtmNote;
  sourceText: string;
  existingNotes: LtmNote[];
  candidateUnits?: LtmEvidenceUnit[];
  provider: BaseLLMProvider;
  model: string;
  root?: string;
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
  maxSourceTokens?: number;
  maxExistingNoteTokens?: number;
  signal?: AbortSignal;
  operationId?: string;
  allowedBuckets?: LtmEvidenceUnit["bucket"][];
  mode?: LtmMode;
  aiKeywordExtraction?: boolean;
  refinePass?: boolean;
}

export interface CompileEvidenceUnitExtractionResult {
  unitResponse: LtmEvidenceUnitExtractionResponse;
  compiledResponse: LtmExtractionResponse;
  diagnostics: LtmExtractionDiagnostic[];
  outcome: LtmExtractionOutcome;
  suggestionCap: LtmSuggestionCapMetadata;
}

type ParsedEvidenceUnitPayload = {
  response: LtmEvidenceUnitExtractionResponse;
  totalCandidates: number;
  droppedCandidates: LtmExtractionDroppedCandidate[];
};

type LtmEvidenceUnitChatOptions = ChatOptions & { reasoningEffort: NonNullable<ChatOptions["reasoningEffort"]> };

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
  const objectStarts: number[] = [];
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
      objectStarts.push(i);
    } else if (ch === "}") {
      const start = objectStarts.pop();
      if (start !== undefined) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            units.push(parsed as Record<string, unknown>);
          }
        } catch {
          // skip unparseable fragments
        }
      }
    }
  }

  return units;
}

function isReasoningNoneUnsupportedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:reasoning|reasoning_effort|effort|thinking|enable_thinking)\b/i.test(message) &&
    /\b(?:none|unsupported|invalid|unrecognized|not supported|bad request|400)\b/i.test(message)
  );
}

function isResponseFormatUnsupportedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:response_format|response format|json_schema|json schema|structured output|schema)\b/i.test(message) &&
    /\b(?:unsupported|invalid|unrecognized|not supported|bad request|400)\b/i.test(message)
  );
}

function relationshipDimensionSchema(minimum: number, maximum: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      RELATIONSHIP_DIMENSIONS.map((dimension) => [
        dimension,
        { type: "integer", minimum, maximum },
      ]),
    ),
  };
}

export function evidenceUnitResponseFormat(options: {
  allowedBuckets: readonly LtmEvidenceUnit["bucket"][];
  sourceHash: string;
}): NonNullable<ChatOptions["responseFormat"]> {
  return {
    type: "json_schema",
    json_schema: {
      name: "ltm_evidence_unit_extraction",
      strict: false,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "units"],
        properties: {
          summary: { type: "string", maxLength: 2_000 },
          units: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "bucket",
                "subjectId",
                "sectionKey",
                "text",
                "importance",
                "evidence",
                "confidence",
                "salience",
                "status",
                "links",
                "sourceHash",
              ],
              properties: {
                id: { type: "string", format: "uuid" },
                bucket: { type: "string", enum: options.allowedBuckets },
                subjectId: { type: "string", pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$", maxLength: 120 },
                sectionKey: { type: "string", pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$", maxLength: 80 },
                text: { type: "string", minLength: 1, maxLength: 2_000 },
                importance: { type: "string", enum: LTM_EXTRACTION_IMPORTANCE_VALUES },
                keywords: {
                  type: "array",
                  maxItems: 20,
                  items: { type: "string", minLength: 1, maxLength: 80 },
                },
                evidence: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  items: { type: "string", minLength: 1, maxLength: 240 },
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                salience: { type: "number", minimum: 0, maximum: 1 },
                status: { type: "string", enum: ["active", "resolved"] },
                links: {
                  type: "array",
                  maxItems: 50,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["target", "relation"],
                    properties: {
                      target: { type: "string", pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$", maxLength: 120 },
                      relation: { type: "string", enum: LTM_EXTRACTION_LINK_RELATIONS },
                      aspect: { type: "string", maxLength: 50 },
                    },
                  },
                },
                mergeHint: { type: "string", minLength: 1, maxLength: 240 },
                sourceHash: { type: "string", enum: [options.sourceHash] },
                dimensions: relationshipDimensionSchema(0, 100),
                dimensionChanges: relationshipDimensionSchema(-100, 100),
              },
            },
          },
        },
      },
    },
  };
}

async function chatCompleteWithReasoningFallback({
  messages,
  chatOptions,
  extractionOptions,
}: {
  messages: ChatMessage[];
  chatOptions: LtmEvidenceUnitChatOptions;
  extractionOptions: RunLongTermMemoryEvidenceUnitExtractionOptions;
}) {
  try {
    return await extractionOptions.provider.chatComplete(messages, chatOptions);
  } catch (err) {
    if (chatOptions.responseFormat && isResponseFormatUnsupportedError(err)) {
      await recordLtmDebugEvent({
        operationId: extractionOptions.operationId,
        root: extractionOptions.root,
        phase: "llm",
        action: "evidence_unit_response_format_fallback",
        status: "warning",
        sourceNoteId: extractionOptions.sourceNote.id,
        provider: extractionOptions.provider.constructor.name,
        model: extractionOptions.model,
        error: err,
        details: {
          requestedResponseFormat: chatOptions.responseFormat.type,
          appliedResponseFormat: "none",
        },
      });
      return chatCompleteWithReasoningFallback({
        messages,
        chatOptions: { ...chatOptions, responseFormat: undefined },
        extractionOptions,
      });
    }

    if (chatOptions.reasoningEffort !== "none" || !isReasoningNoneUnsupportedError(err)) {
      logger.warn(err, "[ltm] LLM chat complete failed for evidence unit extraction");
      throw err;
    }
    await recordLtmDebugEvent({
      operationId: extractionOptions.operationId,
      root: extractionOptions.root,
      phase: "llm",
      action: "evidence_unit_reasoning_fallback",
      status: "warning",
      sourceNoteId: extractionOptions.sourceNote.id,
      provider: extractionOptions.provider.constructor.name,
      model: extractionOptions.model,
      error: err,
      details: {
        requestedReasoningEffort: "none",
        appliedReasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
      },
    });
    return chatCompleteWithReasoningFallback({
      messages,
      chatOptions: {
        ...chatOptions,
        reasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
      },
      extractionOptions,
    });
  }
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



function extractCandidateSnippet(candidate: unknown) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const text = (candidate as Record<string, unknown>).text;
  return typeof text === "string" ? safeSnippet(text) : undefined;
}

function formatZodIssue(issue: { path: Array<string | number>; message: string }) {
  const path = issue.path.length ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

export function parseEvidenceUnitPayload(raw: unknown, expectedSourceHash: string): ParsedEvidenceUnitPayload {
  const normalized = normalizeEvidenceUnitResponse(raw, expectedSourceHash);
  const record = normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : {};
  const summary = typeof record.summary === "string" ? record.summary : "";
  const rawUnits = Array.isArray(record.units) ? record.units : [];
  const units: LtmEvidenceUnit[] = [];
  const droppedCandidates: LtmExtractionDroppedCandidate[] = [];

  for (const [index, candidate] of rawUnits.entries()) {
    const parsed = ltmEvidenceUnitSchema.safeParse(candidate);
    if (parsed.success) {
      units.push(parsed.data);
      continue;
    }
    droppedCandidates.push({
      index,
      reason: "invalid_format",
      message: "Dropped a malformed candidate.",
      ...(extractCandidateSnippet(candidate) ? { snippet: extractCandidateSnippet(candidate) } : {}),
      issues: parsed.error.issues.map(formatZodIssue).slice(0, 8),
    });
  }

  return {
    response: ltmEvidenceUnitExtractionResponseSchema.parse({ summary, units }),
    totalCandidates: rawUnits.length,
    droppedCandidates,
  };
}

function estimateLtmPromptTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateToEstimatedTokens(text: string, maxTokens = DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS) {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateLtmPromptTokens(text) <= budget) return text;
  let end = Math.min(text.length, budget * 4);
  while (end > 0 && estimateLtmPromptTokens(text.slice(0, end)) > budget) end--;
  return text.slice(0, end);
}

function formatExistingNotes(notes: LtmNote[], maxTokens = DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS) {
  let usedTokens = 0;
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
    const blockTokens = estimateLtmPromptTokens(block);
    if (usedTokens + blockTokens > maxTokens) break;
    usedTokens += blockTokens;
    blocks.push(block);
  }
  return blocks.length ? blocks.join("\n\n---\n\n") : "(no relevant memory streams)";
}

export function evidenceUnitMessages(options: RunLongTermMemoryEvidenceUnitExtractionOptions): ChatMessage[] {
  const allowedBuckets = options.allowedBuckets ?? DEFAULT_LTM_EVIDENCE_UNIT_ALLOWED_BUCKETS;
  const filteredScanOrder = LTM_EXTRACTION_BUCKET_SCAN_ORDER.filter((bucket) => allowedBuckets.includes(bucket));
  const modeDescs = options.mode
    ? DEFAULT_LTM_STREAM_DESCRIPTIONS_BY_MODE[options.mode]
    : undefined;
  const allBucketDescriptions: Record<string, string> = {
    timeline_event: modeDescs?.timeline_event ?? "source-summary scene/plot pivot, decision, action, discovery, fight outcome, promise, arrival, or departure; not the live current scene",
    character_fact: modeDescs?.character_fact ?? "durable character identity/trait/role/affiliation/backstory/belief/permanent status/development/ability/item/exact voice quote; not ordinary scene action or transient condition",
    relationship_state: modeDescs?.relationship_state ?? "relationship state or dimension change backed by a caused_by event link or existing relationship note",
    world_fact: modeDescs?.world_fact ?? "stable world/lore fact",
    thread: modeDescs?.thread ?? "unresolved situation, question, tension, or goal with a clear future resolver",
    tone: modeDescs?.tone ?? "durable world/session atmospheric register or recurring style only",
    anchor: modeDescs?.anchor ?? "recurring motif, planted callback, or continuity anchor",
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
      content:
        options.systemPrompt?.trim() ||
        (options.refinePass && options.mode === "game"
          ? DEFAULT_LTM_EXTRACTION_PROMPT_GAME_REFINE
          : DEFAULT_LTM_EXTRACTION_PROMPT),
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
          bucket: "one allowed stream value from allowedStreams",
          subjectId: "real lowercase_snake_case subject",
          sectionKey: "real lowercase_snake_case section",
          text: "compact memory text, not transcript summary",
          importance: "one of critical, major, moderate, minor",
          ...(options.aiKeywordExtraction ? { keywords: "array of 3..5 concise keyword strings" } : {}),
          evidence: "array containing supplied source_note evidence",
          confidence: "0..1",
          salience: "0..1",
          status: "one allowedStatuses value",
          links: "real links only, otherwise []",
          mergeHint: "optional evidence-backed compiler note only",
          dimensions: "relationship_state only: optional object with allowedRelationshipDimensions keys and 0..100 integer values",
          dimensionChanges: "relationship_state only: optional object with allowedRelationshipDimensions keys and -100..100 integer deltas",
          sourceHash: options.sourceHash,
        },
        allowedStreams: allowedBuckets,
        allowedStatuses: ["active", "resolved"],
        allowedImportance: LTM_EXTRACTION_IMPORTANCE_VALUES,
        allowedRelationshipDimensions: RELATIONSHIP_DIMENSIONS,
        streamAllowedStatuses: Object.fromEntries(
          allowedBuckets.map((bucket) => [bucket, bucket === "thread" ? ["active", "resolved"] : ["active"]]),
        ),
        streamScanOrder: filteredScanOrder,
        allowedTimelineRelations: ["occurred_in", "triggered_by", "resolved_in", "evidenced_by", "caused_by", "affects_relationship", "affects_character"],
        streamDescriptions: filteredBucketDescriptions,
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
        targetNoteRules: [
          "The compiler derives the target note id from bucket + subjectId: timeline_event -> timeline_<subjectId>, character_fact -> char_<subjectId>, relationship_state -> rel_<subjectId>, world_fact or anchor -> world_<subjectId> unless anchor sectionKey starts with tone, thread -> thread_<subjectId>, tone -> tone_<subjectId>.",
          "For timeline_event, subjectId must name the specific event or beat, not just a person, character, place, or broad entity. Use damo_arrival or lisa_minimizing_damo instead of damo_korvak.",
          "Do not intentionally target an existing note id unless that exact note appears in existingTypedNotes. If a broad note is not listed, use a source-specific subjectId for a new in-scope note.",
          "relationship_state dimension keys must come only from allowedRelationshipDimensions. Put professional curiosity, reputation, gossip, or attention as text/thread/world/timeline facts, not dimensions.",
        ],
        userInstruction: options.instruction?.trim() || undefined,
        extraInstruction: options.extraInstruction?.trim() || undefined,
        ...(options.candidateUnits?.length
          ? { candidateUnits: options.candidateUnits }
          : {}),
        ...(options.aiKeywordExtraction
          ? {
              keywordInstruction:
                "For each unit, include 3-5 concise keywords or short phrases in keywords. Prefer concrete recall terms and multi-word entities when relevant.",
            }
          : {}),
        existingTypedNotes: formatExistingNotes(options.existingNotes, options.maxExistingNoteTokens),
        sourceText: truncateToEstimatedTokens(options.sourceText, options.maxSourceTokens),
        refinePass: options.refinePass === true,
      }),
    },
  ];
}

export async function runLongTermMemoryEvidenceUnitExtraction(
  options: RunLongTermMemoryEvidenceUnitExtractionOptions,
): Promise<ParsedEvidenceUnitPayload> {
  const messages = evidenceUnitMessages(options);
  const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
  const started = Date.now();
  const requestedReasoningEffort = options.reasoningEffort ?? DEFAULT_LTM_EXTRACTION_REASONING_EFFORT;
  const chatOptions: LtmEvidenceUnitChatOptions = {
    model: options.model,
    temperature: options.temperature ?? 0,
    maxTokens: options.maxOutputTokens ?? options.provider.maxTokensOverrideValue ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
    reasoningEffort: requestedReasoningEffort,
    verbosity: options.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY,
    stream: true,
    signal: options.signal,
    responseFormat: evidenceUnitResponseFormat({
      allowedBuckets: options.allowedBuckets ?? DEFAULT_LTM_EVIDENCE_UNIT_ALLOWED_BUCKETS,
      sourceHash: options.sourceHash,
    }),
  };
  await recordLtmDebugEvent({
    operationId: options.operationId,
    root: options.root,
    phase: "llm",
    action: "evidence_unit_request",
    status: "started",
    sourceNoteId: options.sourceNote.id,
    provider: options.provider.constructor.name,
    model: options.model,
      counts: {
        messages: messages.length,
        promptChars,
        promptTokens: estimateLtmPromptTokens(messages.map((message) => message.content).join("\n")),
        sourceChars: options.sourceText.length,
        existingNotes: options.existingNotes.length,
        maxSourceTokens: options.maxSourceTokens ?? DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
        maxExistingNoteTokens: options.maxExistingNoteTokens ?? DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
      },
      details: {
        reasoningEffort: requestedReasoningEffort,
        verbosity: options.verbosity ?? DEFAULT_LTM_EXTRACTION_VERBOSITY,
        maxOutputTokens: options.maxOutputTokens ?? options.provider.maxTokensOverrideValue ?? DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
        temperature: options.temperature ?? 0,
        aiKeywordExtraction: options.aiKeywordExtraction === true,
        responseFormat: chatOptions.responseFormat?.type,
      },
    });
  try {
    const result = await chatCompleteWithReasoningFallback({
      messages,
      chatOptions,
      extractionOptions: options,
    });

    const content = result.content?.trim() ?? "";
    await recordLtmDebugEvent({
      operationId: options.operationId,
      root: options.root,
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
    if (!content) {
      return {
        response: ltmEvidenceUnitExtractionResponseSchema.parse({ summary: "", units: [] }),
        totalCandidates: 0,
        droppedCandidates: [],
      };
    }
    try {
      const parsed = parseEvidenceUnitPayload(JSON.parse(extractJsonObject(content)), options.sourceHash);
      await recordLtmDebugEvent({
        operationId: options.operationId,
        root: options.root,
        phase: "llm",
        action: "evidence_unit_json_parse",
        status: "ok",
        sourceNoteId: options.sourceNote.id,
        counts: {
          units: parsed.response.units.length,
          totalCandidates: parsed.totalCandidates,
          droppedCandidates: parsed.droppedCandidates.length,
          responseChars: content.length,
        },
      });
      return parsed;
    } catch (parseErr) {
      try {
        const repaired = repairTruncatedJson(extractJsonObject(content));
        const parsed = parseEvidenceUnitPayload(JSON.parse(repaired), options.sourceHash);
        await recordLtmDebugEvent({
          operationId: options.operationId,
          root: options.root,
          phase: "llm",
          action: "evidence_unit_json_parse",
          status: "ok",
          sourceNoteId: options.sourceNote.id,
          counts: {
            units: parsed.response.units.length,
            totalCandidates: parsed.totalCandidates,
            droppedCandidates: parsed.droppedCandidates.length,
            responseChars: content.length,
          },
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
          const parsed = parseEvidenceUnitPayload(syntheticResponse, options.sourceHash);
          await recordLtmDebugEvent({
            operationId: options.operationId,
            root: options.root,
            phase: "llm",
            action: "evidence_unit_json_parse",
            status: "ok",
            sourceNoteId: options.sourceNote.id,
            counts: {
              units: parsed.response.units.length,
              totalCandidates: parsed.totalCandidates,
              droppedCandidates: parsed.droppedCandidates.length,
              responseChars: content.length,
            },
            details: { recovered: "partial" },
          });
          return parsed;
        } catch {
          // fall through to final throw
        }
      }

      await recordLtmDebugEvent({
        operationId: options.operationId,
        root: options.root,
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
    logger.error(err, "[ltm] Evidence unit extraction failed for note %s", options.sourceNote.id);
    await recordLtmDebugEvent({
      operationId: options.operationId,
      root: options.root,
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
  totalCandidates?: number;
  parserDroppedCandidates?: LtmExtractionDroppedCandidate[];
  sourceText: string;
  sourceNote: LtmNote;
  existingNotes: LtmNote[];
  scope: LtmScope;
  modes: LtmMode[];
  mode?: LtmMode;
  sourceHash: string;
  allowedBuckets?: readonly LtmEvidenceUnit["bucket"][];
}): CompileEvidenceUnitExtractionResult {
  const normalized = normalizeStructuredSummaryEvidenceUnits({
    units: options.unitResponse.units,
    sourceText: options.sourceText,
    sourceNote: options.sourceNote,
    sourceHash: options.sourceHash,
    allowedBuckets:
      options.allowedBuckets ??
      DEFAULT_LTM_ALLOWED_STREAMS_BY_MODE[options.mode ?? options.modes[0] ?? "roleplay"],
    mode: options.mode,
    modes: options.modes,
  });
  const validated = validateLtmEvidenceUnits({
    units: normalized.units,
    sourceText: options.sourceText,
    sourceNote: options.sourceNote,
    existingNotes: options.existingNotes,
    expectedSourceHash: options.sourceHash,
  });
  const keptUnits = validated.keptUnits;
  const dedupResult = deduplicateUnits({
    units: keptUnits,
    existingNotes: options.existingNotes,
    options: { withinExtraction: true },
  });
  const droppedCandidates = [...(options.parserDroppedCandidates ?? []), ...validated.droppedCandidates];
  const compiled = dedupResult.deduplicated.length
    ? compileLtmEvidenceUnits({
        units: dedupResult.deduplicated,
        existingNotes: options.existingNotes,
        scope: options.scope,
        modes: options.modes,
        mode: options.mode,
        summary: options.unitResponse.summary,
      })
    : {
        summary: options.unitResponse.summary,
        mutations: [],
        suggestionCap: { limit: LTM_DRAFT_MUTATION_LIMIT, generated: 0, returned: 0, capped: 0 },
      };
  const { suggestionCap, ...compiledResponse } = compiled;
  const diagnostics = [...validated.diagnostics, ...dedupResult.diagnostics];
  if (suggestionCap.capped > 0) {
    diagnostics.push({
      severity: "warning",
      code: "suggestions_capped",
      message: `Created ${suggestionCap.returned} of ${suggestionCap.generated} suggested changes. Extract again on a smaller source or split the source note to review more.`,
    });
  }
  const totalCandidates = Math.max(
    options.totalCandidates ?? 0,
    normalized.units.length + droppedCandidates.length,
  );
  const outcome = summarizeExtractionOutcome({
    totalCandidates,
    keptUnits: dedupResult.deduplicated.length,
    droppedCandidates,
    mutations: compiledResponse.mutations.length,
    suggestionCap,
  });
  return {
    unitResponse: { ...options.unitResponse, units: normalized.units },
    compiledResponse,
    diagnostics,
    outcome,
    suggestionCap,
  };
}

export function summarizeCompiledEvidenceUnitExtraction(result: CompileEvidenceUnitExtractionResult) {
  const targetNoteIds = result.compiledResponse.mutations.flatMap((mutation) =>
    mutation.kind === "create_note" ? [mutation.note.id] : [mutation.noteId],
  );
  return {
    counts: {
      units: result.outcome.keptUnits,
      totalCandidates: result.outcome.totalCandidates,
      droppedUnits: result.outcome.droppedUnits,
      diagnostics: result.diagnostics.length,
      blockingDiagnostics: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
      mutations: result.compiledResponse.mutations.length,
      generatedMutations: result.suggestionCap.generated,
      returnedMutations: result.suggestionCap.returned,
      cappedMutations: result.suggestionCap.capped,
      targetNotes: new Set(targetNoteIds).size,
    },
    mutationKinds: countBy(result.compiledResponse.mutations.map((mutation) => mutation.kind)),
    targetNoteIds: Array.from(new Set(targetNoteIds)).slice(0, 80),
  };
}

function summarizeExtractionOutcome(input: {
  totalCandidates: number;
  keptUnits: number;
  droppedCandidates: LtmExtractionDroppedCandidate[];
  mutations: number;
  suggestionCap?: LtmSuggestionCapMetadata;
}): LtmExtractionOutcome {
  const droppedUnits = input.droppedCandidates.length;
  const state =
    input.keptUnits > 0
      ? droppedUnits > 0
        ? "partial_success"
        : "success"
      : "no_suggestions_created";
  return {
    state,
    totalCandidates: input.totalCandidates,
    keptUnits: input.keptUnits,
    droppedUnits,
    droppedCandidates: input.droppedCandidates,
    ...(input.suggestionCap && input.suggestionCap.capped > 0 ? { suggestionCap: input.suggestionCap } : {}),
  };
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
