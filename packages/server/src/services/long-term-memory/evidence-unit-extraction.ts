import { randomUUID } from "node:crypto";
import {
  DEFAULT_LTM_EXTRACTION_MAX_EXISTING_NOTE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_SOURCE_TOKENS,
  DEFAULT_LTM_EXTRACTION_MAX_TOKENS,
  DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
  DEFAULT_LTM_EXTRACTION_VERBOSITY,
  LTM_DRAFT_MUTATION_LIMIT,
  ltmEvidenceUnitExtractionResponseSchema,
  ltmEvidenceUnitSchema,
  ltmEvidenceUnitStatusSchema,
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
import { stableJsonHash } from "./chunking.js";
import { recordLtmDebugEvent } from "./debug-log.js";
import type { LtmExtractionDiagnostic } from "./diagnostics.js";
import { compileLtmEvidenceUnits } from "./evidence-unit-compiler.js";
import type { LtmSuggestionCapMetadata } from "./evidence-unit-compiler.js";
import { validateLtmEvidenceUnits } from "./evidence-unit-validation.js";

export const DEFAULT_LTM_EXTRACTION_PROMPT = [
  "You extract structured long-term memory evidence units from a source note.",
  "Return strict JSON only. Do not explain.",
  "Do not include thinking, analysis, markdown, or <think> tags. Output JSON object only.",
  "Source notes are audit evidence, not active recall memory.",
  "Do not output source summaries, transcript summaries, or final write operations.",
  "Extract every distinct durable memory stream supported by the source.",
  "Emit zero or more units per stream. Prefer a few substantial units that capture the complete fact over many fragmentary observations.",
  "Scan stream groups explicitly: timeline beats (timeline_event); relationships (relationship_event, relationship_state, relationship_conflict); open loops (thread); character facts (character_fact); world facts (world_fact); style and motifs (tone, anchor).",
  "Use one best stream per fact. If a detail fits both a timeline and character/relationship stream, emit the plot-changing action as timeline_event or relationship_event and reserve character_fact for durable identity, backstory, permanent development, ability, item, or exact voice evidence.",
  "Do not duplicate the same fact across streams or sections.",
  "Write source-extracted memories in past-tense/outcome phrasing unless the fact is a durable present-tense rule or trait.",

  "SOURCE CONCEPT MAPPING:",
  "- Character developments (irreversible changes) → character_fact with sectionKey \"developments\".",
  "- Character abilities → character_fact with sectionKey \"abilities\".",
  "- Character voice/quotes → character_fact with sectionKey \"voice\".",
  "- Items tied to a character → character_fact with sectionKey \"items\" and the character's subjectId.",
  "- Items not tied to a character → world_fact with sectionKey \"items\".",
  "- Callbacks → thread. Prepend [CALLBACK] in the text. Include planted element, payoff target, and status.",

  "SECTION KEY CONVENTIONS:",
  "- character_fact: facts, developments, abilities, voice, or items. Never use it for ordinary actions, scene beats, decisions, arrivals, departures, promises, discoveries, relationship moments, moods, wounds, resources, aims, or location.",
  "- relationship_event: history.",
  "- relationship_state: state, only when backed by a same-pass relationship_event or existing relationship note.",
  "- relationship_conflict: conflict.",
  "- world_fact: facts or items.",
  "- timeline_event: event.",
  "- thread: summary. The text must describe an unresolved situation and what would resolve it.",
  "- tone: observations. World/session-level atmospheric register only, not one-scene mood.",
  "- anchor: the source section key. Recurring motif or planted callback only.",

  "Each unit must be assigned to a memory stream and useful for future continuity.",
  "Every unit must include at least one supplied evidence string, including source_note:<id>.",
  "Use real lowercase snake_case subjectId and sectionKey values derived from the source.",
  "Never output placeholder values such as lowercase_snake_case_scope_id, lowercase_snake_case, target_note_id, or copied schema/example text.",
  "Do not copy schema/example placeholder values.",
  "Omit optional fields unless they are real and evidence-backed.",
  "Use timeline_event for historical source-summary scenes or beats; never call those current_scene.",
  "Memory streams may link to timeline_event notes using occurred_in, triggered_by, resolved_in, or evidenced_by.",
  "Keep source-note provenance as source_note evidence; timeline links describe story structure, not source provenance.",
  "Use sourceHash exactly as supplied.",
  "Set confidence and salience from 0 to 1.",
  "For voice/tone quotes, quote only exact text present in the source.",
  "Do not emit current scene, current state, character_state, relationship arc, boundary, or preference memories from source-summary extraction.",
  "For enum fields, choose exactly one string from the allowed arrays. Do not join multiple values with |.",
].join("\n");
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
export const DEFAULT_LTM_EVIDENCE_UNIT_ALLOWED_BUCKETS = [
  "timeline_event",
  "character_fact",
  "relationship_event",
  "relationship_state",
  "relationship_conflict",
  "world_fact",
  "thread",
  "tone",
  "anchor",
] as const satisfies LtmEvidenceUnit["bucket"][];

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
  maxSourceTokens?: number;
  maxExistingNoteTokens?: number;
  signal?: AbortSignal;
  operationId?: string;
  allowedBuckets?: LtmEvidenceUnit["bucket"][];
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
    if (chatOptions.reasoningEffort !== "none" || !isReasoningNoneUnsupportedError(err)) {
      throw err;
    }
    await recordLtmDebugEvent({
      operationId: extractionOptions.operationId,
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
    return extractionOptions.provider.chatComplete(messages, {
      ...chatOptions,
      reasoningEffort: DEFAULT_LTM_EXTRACTION_REASONING_EFFORT,
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

function safeSnippet(text: string | undefined) {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value || value.length < 12) return undefined;
  return value.length > 280 ? `${value.slice(0, 277).trim()}...` : value;
}

function extractCandidateSnippet(candidate: unknown) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const text = (candidate as Record<string, unknown>).text;
  return typeof text === "string" ? safeSnippet(text) : undefined;
}

function parseEvidenceUnitPayload(raw: unknown, expectedSourceHash: string): ParsedEvidenceUnitPayload {
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

function evidenceUnitMessages(options: RunLongTermMemoryEvidenceUnitExtractionOptions): ChatMessage[] {
  const allowedBuckets = options.allowedBuckets ?? DEFAULT_LTM_EVIDENCE_UNIT_ALLOWED_BUCKETS;
  const filteredScanOrder = LTM_EXTRACTION_BUCKET_SCAN_ORDER.filter((bucket) => allowedBuckets.includes(bucket));
  const allBucketDescriptions: Record<string, string> = {
    timeline_event: "source-summary scene/plot pivot, decision, action, discovery, fight outcome, promise, arrival, or departure; not the live current scene",
    character_fact: "durable character identity/trait/role/affiliation/backstory/belief/permanent status/development/ability/item/exact voice quote; not ordinary scene action or transient condition",
    character_state: "legacy/manual current character condition only; source-summary extraction must not use this stream",
    relationship_event: "evidence-backed interpersonal event or history item",
    relationship_state: "current reduced relationship state backed by same-pass relationship_event or existing relationship note",
    relationship_conflict: "unresolved contradiction or instability",
    world_fact: "stable world/lore fact",
    thread: "unresolved situation, question, tension, or goal with a clear future resolver",
    tone: "durable world/session atmospheric register or recurring style only",
    anchor: "recurring motif, planted callback, or continuity anchor",
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
          bucket: "one allowed stream value from allowedBuckets",
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
        existingTypedNotes: formatExistingNotes(options.existingNotes, options.maxExistingNoteTokens),
        sourceText: truncateToEstimatedTokens(options.sourceText, options.maxSourceTokens),
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
  };
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
  totalCandidates?: number;
  parserDroppedCandidates?: LtmExtractionDroppedCandidate[];
  sourceText: string;
  sourceNote: LtmNote;
  existingNotes: LtmNote[];
  scope: LtmScope;
  modes: LtmMode[];
  sourceHash: string;
}): CompileEvidenceUnitExtractionResult {
  const validated = validateLtmEvidenceUnits({
    units: options.unitResponse.units,
    sourceText: options.sourceText,
    sourceNote: options.sourceNote,
    existingNotes: options.existingNotes,
    expectedSourceHash: options.sourceHash,
  });
  const keptUnits = validated.keptUnits;
  const droppedCandidates = [...(options.parserDroppedCandidates ?? []), ...validated.droppedCandidates];
  const compiled = keptUnits.length
    ? compileLtmEvidenceUnits({
        units: keptUnits,
        existingNotes: options.existingNotes,
        scope: options.scope,
        modes: options.modes,
        summary: options.unitResponse.summary,
      })
    : {
        summary: options.unitResponse.summary,
        mutations: [],
        suggestionCap: { limit: LTM_DRAFT_MUTATION_LIMIT, generated: 0, returned: 0, capped: 0 },
      };
  const { suggestionCap, ...compiledResponse } = compiled;
  const diagnostics = [...validated.diagnostics];
  if (suggestionCap.capped > 0) {
    diagnostics.push({
      severity: "warning",
      code: "suggestions_capped",
      message: `Created ${suggestionCap.returned} of ${suggestionCap.generated} suggested changes. Extract again on a smaller source or split the source note to review more.`,
    });
  }
  const totalCandidates = options.totalCandidates ?? options.unitResponse.units.length + droppedCandidates.length;
  const outcome = summarizeExtractionOutcome({
    totalCandidates,
    keptUnits: keptUnits.length,
    droppedCandidates,
    mutations: compiledResponse.mutations.length,
    suggestionCap,
  });
  return {
    unitResponse: options.unitResponse,
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
