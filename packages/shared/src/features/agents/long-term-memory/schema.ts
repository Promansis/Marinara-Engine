import { z } from "zod";
import {
  DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE,
  DEFAULT_LTM_RECALL_PREAMBLE,
  DEFAULT_LTM_RECALL_STYLE,
  DEFAULT_LTM_RECALL_STYLE_WEIGHTS,
} from "./constants.js";

export const ltmNoteTypeSchema = z.enum([
  "source",
  "timeline_event",
  "character",
  "relationship",
  "scene",
  "thread",
  "world",
  "tone",
]);

export const ltmNoteTitleSchema = z.string().trim().min(1).max(240);

export const ltmStatusSchema = z.enum(["active", "resolved", "archived"]);

export const ltmEvidenceUnitStatusSchema = z.enum(["active", "resolved", "archived", "developing"]);

export const ltmEvidenceUnitBucketSchema = z.enum([
  "timeline_event",
  "character_fact",
  "relationship_state",
  "world_fact",
  "thread",
  "tone",
  "anchor",
]);

export const ltmModeSchema = z.enum(["roleplay", "conversation", "game"]);
const LTM_EXTRACTION_MODES = ltmModeSchema.options;

export const ltmExtractionReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);

export const ltmExtractionVerbositySchema = z.enum(["low", "medium", "high"]);

const ltmGlobalSettingsShape = z
  .object({
    version: z.literal(1).default(1),
    enableLongTermMemory: z.boolean().optional(),
    longTermMemoryBudgetTokens: z.number().int().min(128).max(16_384).optional(),
    longTermMemoryMaxChunks: z.number().int().min(1).max(100).optional(),
    longTermMemoryScoreThreshold: z.number().finite().min(0).max(1).optional(),
    longTermMemoryRecallContextMessages: z.number().int().min(1).max(20).optional(),
    longTermMemoryRecallStyle: z.enum(["balanced", "exact", "broad", "story"]).optional(),
    longTermMemorySemanticWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryLexicalWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryGraphWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryMetadataWeight: z.number().finite().min(0).max(2).nullable().optional(),
    longTermMemoryKeywordWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryIncludeResolved: z.boolean().optional(),
    longTermMemoryRecallPreamble: z.string().max(500).optional(),
    longTermMemoryDebug: z.boolean().optional(),
  })
  .strict();

const LTM_GLOBAL_LEGACY_KEYS = /^(importConcurrency|connectionId|model|instruction|autoApplyLowRisk)$/;

export const ltmGlobalSettingsSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const normalized = { ...input };
  delete normalized.extractionMode;
  for (const key of Object.keys(normalized)) {
    if (LTM_GLOBAL_LEGACY_KEYS.test(key)) delete normalized[key];
  }
  if ("longTermMemoryRecallStyle" in normalized) {
    normalized.longTermMemoryRecallStyle =
      input.longTermMemoryRecallStyle === "exact" ||
      input.longTermMemoryRecallStyle === "broad" ||
      input.longTermMemoryRecallStyle === "story" ||
      input.longTermMemoryRecallStyle === "balanced"
        ? input.longTermMemoryRecallStyle
        : undefined;
  }
  return normalized;
}, ltmGlobalSettingsShape);

export const ltmResolvedGlobalSettingsSchema = z
  .object({
    version: z.literal(1),
    enableLongTermMemory: z.boolean(),
    longTermMemoryBudgetTokens: z.number().int().min(128).max(16_384),
    longTermMemoryMaxChunks: z.number().int().min(1).max(100),
    longTermMemoryScoreThreshold: z.number().finite().min(0).max(1),
    longTermMemoryRecallContextMessages: z.number().int().min(1).max(20),
    longTermMemoryRecallStyle: z.enum(["balanced", "exact", "broad", "story"]),
    longTermMemorySemanticWeight: z.number().finite().min(0).max(1),
    longTermMemoryLexicalWeight: z.number().finite().min(0).max(1),
    longTermMemoryGraphWeight: z.number().finite().min(0).max(1),
    longTermMemoryKeywordWeight: z.number().finite().min(0).max(1),
    longTermMemoryIncludeResolved: z.boolean(),
    longTermMemoryRecallPreamble: z.string().max(500),
    longTermMemoryDebug: z.boolean(),
  })
  .strict();

export const DEFAULT_LTM_GLOBAL_SETTINGS = ltmResolvedGlobalSettingsSchema.parse({
  version: 1,
  enableLongTermMemory: true,
  longTermMemoryBudgetTokens: 4096,
  longTermMemoryMaxChunks: 20,
  longTermMemoryScoreThreshold: 0,
  longTermMemoryRecallContextMessages: 4,
  longTermMemoryRecallStyle: DEFAULT_LTM_RECALL_STYLE,
  longTermMemorySemanticWeight: DEFAULT_LTM_RECALL_STYLE_WEIGHTS.semanticWeight,
  longTermMemoryLexicalWeight: DEFAULT_LTM_RECALL_STYLE_WEIGHTS.lexicalWeight,
  longTermMemoryGraphWeight: DEFAULT_LTM_RECALL_STYLE_WEIGHTS.graphWeight,
  longTermMemoryKeywordWeight: DEFAULT_LTM_RECALL_STYLE_WEIGHTS.keywordWeight,
  longTermMemoryIncludeResolved: false,
  longTermMemoryRecallPreamble: DEFAULT_LTM_RECALL_PREAMBLE,
  longTermMemoryDebug: false,
});

export const ltmExtractionPromptTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    prompt: z.string().min(1),
  })
  .strict();

const LTM_EXTRACTION_MODE_LABELS = {
  roleplay: "Roleplay",
  conversation: "Conversation",
  game: "Game",
} as const satisfies Record<(typeof LTM_EXTRACTION_MODES)[number], string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLtmExtractionMode(value: unknown): value is (typeof LTM_EXTRACTION_MODES)[number] {
  return value === "roleplay" || value === "conversation" || value === "game";
}

function stripLegacyPromptTemplateMode(template: unknown) {
  if (!isRecord(template)) return template;
  const { mode: _mode, ...rest } = template;
  return rest;
}

function nextLegacyPromptTemplateId(mode: (typeof LTM_EXTRACTION_MODES)[number], usedIds: Set<string>) {
  const base = `legacy_${mode}_system_prompt`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let suffix = 2;
  while (usedIds.has(`${base}_${suffix}`)) suffix += 1;
  const id = `${base}_${suffix}`;
  usedIds.add(id);
  return id;
}

function normalizeLegacyExtractionSettings(value: unknown) {
  if (!isRecord(value)) return value;
  const input = value;
  const normalized: Record<string, unknown> = { ...input };
  delete normalized.rejectPlaceholderOutput;
  delete normalized.systemPrompt;
  delete normalized.systemPromptsByMode;
  delete normalized.activePromptTemplateId;

  const rawTemplates = Array.isArray(input.promptTemplates) ? input.promptTemplates : [];
  const promptTemplates = rawTemplates.map(stripLegacyPromptTemplateMode);
  const templateIds = new Set<string>();
  const legacyTemplateModes = new Map<string, (typeof LTM_EXTRACTION_MODES)[number]>();
  for (const template of rawTemplates) {
    if (!isRecord(template) || typeof template.id !== "string") continue;
    templateIds.add(template.id);
    if (isLtmExtractionMode(template.mode)) legacyTemplateModes.set(template.id, template.mode);
  }

  if (rawTemplates.length > 0) normalized.promptTemplates = promptTemplates;

  const modeIds = isRecord(input.activePromptTemplateIdsByMode) ? input.activePromptTemplateIdsByMode : {};
  const legacyActiveId = typeof input.activePromptTemplateId === "string" ? input.activePromptTemplateId : null;
  const hasLegacyPromptOverrides = typeof input.systemPrompt === "string" || isRecord(input.systemPromptsByMode);
  const hasLegacyActiveShape = Boolean(legacyActiveId) || legacyTemplateModes.size > 0 || hasLegacyPromptOverrides;
  let activePromptTemplateIdsByMode: Record<string, string | null> = {};

  if (hasLegacyActiveShape) {
    for (const mode of LTM_EXTRACTION_MODES) {
      const hasModeId = Object.prototype.hasOwnProperty.call(modeIds, mode);
      const modeId = modeIds[mode];
      if (
        typeof modeId === "string" &&
        templateIds.has(modeId) &&
        (!legacyTemplateModes.has(modeId) || legacyTemplateModes.get(modeId) === mode)
      ) {
        activePromptTemplateIdsByMode[mode] = modeId;
      } else if (modeId === null) {
        activePromptTemplateIdsByMode[mode] = null;
      } else if (
        !hasModeId &&
        legacyActiveId &&
        templateIds.has(legacyActiveId) &&
        (!legacyTemplateModes.has(legacyActiveId) || legacyTemplateModes.get(legacyActiveId) === mode)
      ) {
        activePromptTemplateIdsByMode[mode] = legacyActiveId;
      }
    }
  } else if (isRecord(input.activePromptTemplateIdsByMode)) {
    activePromptTemplateIdsByMode = { ...input.activePromptTemplateIdsByMode } as Record<string, string | null>;
  }

  const systemPromptsByMode = isRecord(input.systemPromptsByMode) ? input.systemPromptsByMode : {};
  const legacySystemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt.trim() : "";
  const migratedTemplates = [...promptTemplates];
  for (const mode of LTM_EXTRACTION_MODES) {
    const modePrompt = typeof systemPromptsByMode[mode] === "string" ? systemPromptsByMode[mode].trim() : "";
    const prompt =
      modePrompt && modePrompt !== DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[mode]
        ? modePrompt
        : legacySystemPrompt && legacySystemPrompt !== DEFAULT_LTM_EXTRACTION_PROMPTS_BY_MODE[mode]
          ? legacySystemPrompt
          : "";
    if (!prompt || migratedTemplates.length >= 50) continue;
    const id = nextLegacyPromptTemplateId(mode, templateIds);
    migratedTemplates.push({
      id,
      name: `Legacy ${LTM_EXTRACTION_MODE_LABELS[mode]} prompt`,
      prompt,
    });
    if (!activePromptTemplateIdsByMode[mode]) activePromptTemplateIdsByMode[mode] = id;
  }

  if (migratedTemplates.length > 0) normalized.promptTemplates = migratedTemplates;
  if (Object.keys(activePromptTemplateIdsByMode).length > 0) {
    normalized.activePromptTemplateIdsByMode = activePromptTemplateIdsByMode;
  } else {
    delete normalized.activePromptTemplateIdsByMode;
  }

  return normalized;
}

const ltmActivePromptTemplateIdsByModeSchema = z
  .object({
    roleplay: z.string().min(1).max(64).nullable().optional(),
    conversation: z.string().min(1).max(64).nullable().optional(),
    game: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

const ltmExtractionSettingsShape = z
  .object({
    version: z.literal(1).default(1),
    reasoningEffort: ltmExtractionReasoningEffortSchema.optional(),
    verbosity: ltmExtractionVerbositySchema.optional(),
    maxOutputTokens: z.number().int().min(512).max(32_768).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxSourceTokens: z.number().int().min(128).max(65_536).optional(),
    maxExistingNoteTokens: z.number().int().min(128).max(32_768).optional(),
    existingNoteMaxChunks: z.number().int().min(1).max(100).optional(),
    existingNoteMaxTokens: z.number().int().min(128).max(32_768).optional(),
    promptTemplates: z.array(ltmExtractionPromptTemplateSchema).max(50).optional(),
    activePromptTemplateIdsByMode: ltmActivePromptTemplateIdsByModeSchema.optional(),
    aiKeywordExtraction: z.boolean().optional(),
    refinePass: z.boolean().optional(),
  })
  .strict();

export const ltmExtractionSettingsSchema = z.preprocess((value) => {
  return normalizeLegacyExtractionSettings(value);
}, ltmExtractionSettingsShape);

export const ltmResolvedExtractionSettingsSchema = z
  .object({
    version: z.literal(1),
    systemPrompt: z.string().min(1).max(20_000),
    reasoningEffort: ltmExtractionReasoningEffortSchema,
    verbosity: ltmExtractionVerbositySchema,
    maxOutputTokens: z.number().int().min(512).max(32_768),
    temperature: z.number().finite().min(0).max(2),
    maxSourceTokens: z.number().int().min(128).max(65_536),
    maxExistingNoteTokens: z.number().int().min(128).max(32_768),
    existingNoteMaxChunks: z.number().int().min(1).max(100),
    existingNoteMaxTokens: z.number().int().min(128).max(32_768),
    promptTemplates: z.array(ltmExtractionPromptTemplateSchema).max(50),
    activePromptTemplateId: z.string().min(1).max(64).nullable(),
    activePromptTemplateIdsByMode: ltmActivePromptTemplateIdsByModeSchema,
    aiKeywordExtraction: z.boolean(),
    refinePass: z.boolean(),
  })
  .strict();

export const ltmVaultFolderSchema = z.enum([
  "sources",
  "timeline",
  "characters",
  "relationships",
  "scenes",
  "threads",
  "world",
  "tone",
]);

export const LTM_NOTE_TYPE_TO_VAULT_FOLDER = {
  source: "sources",
  timeline_event: "timeline",
  character: "characters",
  relationship: "relationships",
  scene: "scenes",
  thread: "threads",
  world: "world",
  tone: "tone",
} as const satisfies Record<z.infer<typeof ltmNoteTypeSchema>, z.infer<typeof ltmVaultFolderSchema>>;

export const LTM_NOTE_ID_PREFIXES_BY_TYPE = {
  source: ["source_"],
  timeline_event: ["timeline_"],
  character: ["char_"],
  relationship: ["rel_"],
  scene: ["scene_"],
  thread: ["thread_"],
  world: ["world_", "faction_", "location_", "rule_", "rules"],
  tone: ["tone_"],
} as const satisfies Record<z.infer<typeof ltmNoteTypeSchema>, readonly string[]>;

const LTM_LEGACY_NOTE_ID_PREFIXES_BY_TYPE = {
  source: ["scene_summary_"],
} as const;

function allowedStoredNoteIdPrefixes(type: z.infer<typeof ltmNoteTypeSchema>) {
  return [
    ...LTM_NOTE_ID_PREFIXES_BY_TYPE[type],
    ...(type === "source" ? LTM_LEGACY_NOTE_ID_PREFIXES_BY_TYPE.source : []),
  ];
}

const LTM_SOURCE_SUMMARY_SCENE_TAGS = ["source_summary", "chat_summary"] as const;

export function hasLtmSourceSummarySceneTag(tags: readonly string[]) {
  return LTM_SOURCE_SUMMARY_SCENE_TAGS.some((tag) => tags.includes(tag));
}

export function isLtmSourceLikeNote(note: { type: z.infer<typeof ltmNoteTypeSchema>; tags: readonly string[] }) {
  return note.type === "source" || (note.type === "scene" && hasLtmSourceSummarySceneTag(note.tags));
}

export const ltmIsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), "Timestamp must be parseable ISO-8601.");

export const ltmSafeRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.includes("\0"), "Path cannot contain NUL bytes.")
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "Path must be relative.")
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), "Path must not include a Windows drive prefix.")
  .refine(
    (value) => value.split(/[\\/]+/).every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Path must not contain empty, current, or parent segments.",
  );

const ltmIdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "Identifier must be lowercase snake_case.");

export const ltmNoteIdSchema = ltmIdentifierSchema;

export const ltmSourceProvenanceSchema = z
  .object({
    kind: z.enum(["character", "lorebook", "chat_summary", "game_journal"]),
    sourceId: z.string().min(1).max(120),
    entryId: z.string().min(1).max(120).optional(),
  })
  .strict();

export const ltmSectionKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "Section key must be lowercase snake_case.");

export const ltmScopeSchema = z
  .object({
    chatId: z.string().min(1).max(120).optional(),
    chatIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    groupId: z.string().min(1).max(120).optional(),
    characterIds: z.array(z.string().min(1).max(120)).max(100).optional(),
  })
  .strict();

export const ltmNoteTransferModeSchema = z.enum(["copy", "move"]);

export const ltmNoteTransferConflictSeveritySchema = z.enum(["hard", "soft"]);

export const ltmNoteTransferConflictReasonSchema = z.enum(["exact_text", "same_source_type", "lexical_overlap"]);

export const ltmNoteTransferConflictSchema = z
  .object({
    noteId: ltmNoteIdSchema,
    targetNoteId: ltmNoteIdSchema,
    targetTitle: z.string().min(1).max(240),
    targetType: ltmNoteTypeSchema,
    targetPreview: z.string().max(600).optional(),
    severity: ltmNoteTransferConflictSeveritySchema,
    reason: ltmNoteTransferConflictReasonSchema,
    score: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const ltmNoteTransferPreviewItemSchema = z
  .object({
    noteId: ltmNoteIdSchema,
    title: z.string().min(1).max(240),
    type: ltmNoteTypeSchema,
    previewText: z.string().max(600),
    scope: ltmScopeSchema,
    nextScope: ltmScopeSchema,
    derived: z.boolean().default(false),
    sourceNoteId: ltmNoteIdSchema.optional(),
    classification: z.enum(["ready", "no_op", "conflict"]),
    defaultIncluded: z.boolean(),
    reason: z.string().min(1).max(240).optional(),
    conflicts: z.array(ltmNoteTransferConflictSchema).max(3).default([]),
  })
  .strict();

export const ltmNoteTransferPreviewRequestSchema = z
  .object({
    noteIds: z.array(ltmNoteIdSchema).min(1).max(500),
    mode: ltmNoteTransferModeSchema,
    destinationChatId: z.string().min(1).max(120),
    includeDerived: z.boolean().optional(),
  })
  .strict();

export const ltmNoteTransferPreviewResponseSchema = z
  .object({
    mode: ltmNoteTransferModeSchema,
    destinationChatId: z.string().min(1).max(120),
    selection: z
      .object({
        requestedNoteCount: z.number().int().min(0),
        totalNoteCount: z.number().int().min(0),
        requestedNoteIds: z.array(ltmNoteIdSchema).max(500),
        availableDerivedCount: z.number().int().min(0),
        includedDerivedCount: z.number().int().min(0),
        derivedNoteIds: z.array(ltmNoteIdSchema).max(500),
        includeDerived: z.boolean(),
      })
      .strict(),
    buckets: z
      .object({
        ready: z.array(ltmNoteIdSchema).max(500),
        noOp: z.array(ltmNoteIdSchema).max(500),
        conflict: z.array(ltmNoteIdSchema).max(500),
      })
      .strict(),
    items: z.array(ltmNoteTransferPreviewItemSchema).max(500),
  })
  .strict();

export const ltmLinkSchema = z
  .object({
    target: ltmNoteIdSchema,
    relation: z.enum([
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
    ]),
    aspect: z.string().max(50).optional(),
  })
  .strict();

/**
 * Structured extraction importance. Used by compilation, UI editing, and
 * retrieval weighting instead of encoding markers into section text.
 */
export const ltmImportanceSchema = z.enum(["critical", "major", "moderate", "minor"]);

/**
 * Relationship dimensions are optional 0-100 scores. Omitted values are treated
 * as the neutral baseline by consumers.
 */
export const ltmRelationshipDimensionsSchema = z
  .object({
    trust: z.number().int().min(0).max(100).optional(),
    respect: z.number().int().min(0).max(100).optional(),
    loyalty: z.number().int().min(0).max(100).optional(),
    intimacy: z.number().int().min(0).max(100).optional(),
    tension: z.number().int().min(0).max(100).optional(),
    hostility: z.number().int().min(0).max(100).optional(),
    dependency: z.number().int().min(0).max(100).optional(),
    affection: z.number().int().min(0).max(100).optional(),
    lust: z.number().int().min(0).max(100).optional(),
    protectiveness: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const ltmRelationshipDimensionChangesSchema = z.record(z.number().int().min(-100).max(100));

export const ltmEvidenceUnitSchema = z
  .object({
    id: z.string().uuid(),
    bucket: ltmEvidenceUnitBucketSchema,
    subjectId: ltmIdentifierSchema,
    sectionKey: ltmSectionKeySchema,
    text: z.string().min(1).max(2_000),
    importance: ltmImportanceSchema.default("moderate"),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    evidence: z.array(z.string().min(1).max(240)).min(1).max(20),
    confidence: z.number().finite().min(0).max(1),
    salience: z.number().finite().min(0).max(1),
    status: ltmEvidenceUnitStatusSchema,
    links: z.array(ltmLinkSchema).max(50).default([]),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    dimensions: ltmRelationshipDimensionsSchema.optional(),
    dimensionChanges: ltmRelationshipDimensionChangesSchema.optional(),
  })
  .strip();

/**
 * Compiled note sections store metadata as structured fields. The text remains
 * user-editable prose; callers must not parse importance or dimensions from it.
 */
export const ltmSectionSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    updatedAt: ltmIsoTimestampSchema,
    salience: z.number().finite().min(0).max(1).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    importance: ltmImportanceSchema.optional(),
    dimensions: ltmRelationshipDimensionsSchema.optional(),
    dimensionChanges: ltmRelationshipDimensionChangesSchema.optional(),
    evidence: z.array(z.string().min(1).max(240)).max(100).optional(),
  })
  .strip();

export const ltmConflictSchema = z
  .object({
    field: z.string().min(1).max(200),
    existing: z.string().max(20_000),
    proposed: z.string().max(20_000),
    sourceTurn: z.number().int().min(0).optional(),
    resolution: z.enum(["pending", "accepted", "rejected", "user_decided"]),
    policy: z.string().min(1).max(120),
  })
  .strict();

export const ltmNoteSchema = z
  .object({
    id: ltmNoteIdSchema,
    title: ltmNoteTitleSchema.optional(),
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema,
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    createdAt: ltmIsoTimestampSchema,
    updatedAt: ltmIsoTimestampSchema,
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    provenance: ltmSourceProvenanceSchema.optional(),
    version: z.number().int().min(1),
    extracted: z.boolean().optional(),
  })
  .strict()
  .superRefine((note, ctx) => {
    const allowedPrefixes = allowedStoredNoteIdPrefixes(note.type);
    if (!allowedPrefixes.some((prefix) => note.id === prefix || note.id.startsWith(prefix))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: `ID for ${note.type} notes must start with ${allowedPrefixes.join(" or ")}.`,
      });
    }

    if (Date.parse(note.updatedAt) < Date.parse(note.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt cannot be earlier than createdAt.",
      });
    }

    if (note.provenance && note.type !== "source") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message: "Only source notes can store import provenance.",
      });
    }
  });

export const ltmVaultFileReferenceSchema = z
  .object({
    noteId: ltmNoteIdSchema,
    type: ltmNoteTypeSchema,
    folder: ltmVaultFolderSchema,
    relativePath: ltmSafeRelativePathSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (LTM_NOTE_TYPE_TO_VAULT_FOLDER[value.type] !== value.folder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["folder"],
        message: `Folder must match note type ${value.type}.`,
      });
    }
  });

export const ltmEventSchema = z
  .object({
    id: z.string().uuid(),
    ts: ltmIsoTimestampSchema,
    type: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
    target: ltmNoteIdSchema.optional(),
    actor: z.string().min(1).max(120).optional(),
    turn: z.number().int().min(0).optional(),
    cause: z.string().min(1).max(240).optional(),
    summary: z.string().max(2_000).optional(),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();

export const ltmDebugStatusSchema = z.enum(["started", "ok", "skipped", "warning", "error"]);

export const ltmDebugPhaseSchema = z.enum([
  "import",
  "source_note",
  "extraction",
  "llm",
  "compiler",
  "draft",
  "apply",
  "injection",
  "retrieval",
  "rebuild",
  "repair",
  "replay",
  "diagnostic",
]);

export const ltmDebugErrorSchema = z
  .object({
    name: z.string().max(120).optional(),
    message: z.string().max(2_000),
    stack: z.string().max(6_000).optional(),
    code: z.string().max(120).optional(),
  })
  .strict();

export const ltmDebugEventSchema = z
  .object({
    id: z.string().uuid(),
    ts: ltmIsoTimestampSchema,
    operationId: z.string().uuid(),
    phase: ltmDebugPhaseSchema,
    action: z.string().min(1).max(120),
    status: ltmDebugStatusSchema,
    message: z.string().max(2_000).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    source: z.string().max(120).optional(),
    sourceId: z.string().max(240).optional(),
    sourceNoteId: ltmNoteIdSchema.optional(),
    draftId: z.string().uuid().optional(),
    noteId: ltmNoteIdSchema.optional(),
    mutationIds: z.array(z.string().uuid()).max(100).optional(),
    counts: z.record(z.number().int().min(0)).optional(),
    diagnostics: z.array(z.record(z.unknown())).max(80).optional(),
    provider: z.string().max(120).optional(),
    model: z.string().max(240).optional(),
    error: ltmDebugErrorSchema.optional(),
    details: z.record(z.unknown()).optional(),
    chatId: z.string().max(200).optional(),
    uiSummary: z.string().max(4_000).optional(),
  })
  .strict();

export const ltmPolicySchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const {
      updateBehavior: _updateBehavior,
      reconcileEvery: _reconcileEvery,
      summarization: _summarization,
      pinAgainstSummarization: _pinAgainstSummarization,
      autoArchiveOn: _autoArchiveOn,
      ...rest
    } = value as Record<string, unknown>;
    return rest;
  },
  z
    .object({
      type: ltmNoteTypeSchema,
      injection: z.enum(["always_for_active_characters", "on_relevance", "never"]).default("on_relevance"),
      sectionsAlways: z.array(ltmSectionKeySchema).default([]),
      sectionsOnRelevance: z.array(z.union([ltmSectionKeySchema, z.literal("*")])).default(["*"]),
    })
    .strict(),
);

export const ltmPoliciesConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    policies: z.array(ltmPolicySchema).default([]),
  })
  .strict();

const ltmRetrievalConfigShape = z
  .object({
    version: z.literal(1).default(1),
    maxChunks: z.number().int().min(1).max(100).default(12),
    maxTokens: z.number().int().min(128).max(16_384).default(2_048),
    semanticWeight: z.number().finite().min(0).max(1).default(0.6),
    lexicalWeight: z.number().finite().min(0).max(1).default(0.3),
    graphWeight: z.number().finite().min(0).max(1).default(0.1),
    keywordWeight: z.number().finite().min(0).max(1).default(0.2),
  })
  .strict()
  .refine(
    (value) => value.semanticWeight + value.lexicalWeight + value.graphWeight + value.keywordWeight > 0,
    "At least one retrieval weight must be positive.",
  );

export const ltmRetrievalConfigSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { enabled: _enabled, ...rest } = value as Record<string, unknown>;
  return rest;
}, ltmRetrievalConfigShape);

export const ltmIndexMetadataSchema = z
  .object({
    version: z.literal(1),
    chunkFormatVersion: z.number().int().min(1).optional(),
    generatedAt: ltmIsoTimestampSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    noteCount: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    files: z.record(ltmSafeRelativePathSchema, z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  })
  .strict();

export const ltmTransferRebuildSummarySchema = z
  .object({
    generatedAt: ltmIsoTimestampSchema,
    noteCount: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    sourceChunkCount: z.number().int().min(0),
    embeddedChunkCount: z.number().int().min(0),
    embeddingsAvailable: z.boolean(),
    manifest: ltmIndexMetadataSchema.optional(),
  })
  .strict();

export const ltmNoteTransferApplyResponseSchema = z
  .object({
    mode: ltmNoteTransferModeSchema,
    destinationChatId: z.string().min(1).max(120),
    updatedNoteIds: z.array(ltmNoteIdSchema).max(500),
    skippedNoteIds: z.array(ltmNoteIdSchema).max(500),
    derivedNoteIdsTouched: z.array(ltmNoteIdSchema).max(500),
    rebuild: ltmTransferRebuildSummarySchema.nullable(),
  })
  .strict();

export const ltmDraftStatusSchema = z.enum(["pending", "accepted", "auto_applied"]);

export const ltmDraftRiskSchema = z.enum(["low", "medium", "high"]);

export const ltmDraftSourceSchema = z
  .object({
    chatId: z.string().min(1).max(120).optional(),
    sourceNoteId: ltmNoteIdSchema.optional(),
    summaryEntryId: z.string().min(1).max(120).optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((value) => Boolean(value.sourceNoteId), {
    message: "Long-term memory drafts must be tied to a source note.",
    path: ["sourceNoteId"],
  });

export const ltmDraftNoteInputSchema = z
  .object({
    id: ltmNoteIdSchema,
    title: ltmNoteTitleSchema.optional(),
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema.default("active"),
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    createdAt: ltmIsoTimestampSchema.optional(),
    updatedAt: ltmIsoTimestampSchema.optional(),
    extracted: z.boolean().optional(),
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    provenance: ltmSourceProvenanceSchema.optional(),
    version: z.number().int().min(1).optional(),
  })
  .strip()
  .superRefine((note, ctx) => {
    const allowedPrefixes = LTM_NOTE_ID_PREFIXES_BY_TYPE[note.type];
    if (!allowedPrefixes.some((prefix) => note.id === prefix || note.id.startsWith(prefix))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: `ID for ${note.type} notes must start with ${allowedPrefixes.join(" or ")}.`,
      });
    }

    if (note.provenance && note.type !== "source") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message: "Only source notes can store import provenance.",
      });
    }
  });

const ltmDraftMutationBaseSchema = z.object({
  id: z.string().uuid(),
  risk: ltmDraftRiskSchema.default("medium"),
  confidence: z.number().finite().min(0).max(1).default(0.5),
  summary: z.string().min(1).max(1_000),
  evidence: z.array(z.string().min(1).max(240)).min(1).max(20),
});

export const ltmDraftMutationSchema = z.discriminatedUnion("kind", [
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("create_note"),
      note: ltmDraftNoteInputSchema,
    })
    .strip(),
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("append_section"),
      noteId: ltmNoteIdSchema,
      sectionKey: ltmSectionKeySchema,
      text: z.string().min(1).max(20_000),
      salience: z.number().finite().min(0).max(1).optional(),
      importance: ltmImportanceSchema.optional(),
      dimensions: ltmRelationshipDimensionsSchema.optional(),
      dimensionChanges: ltmRelationshipDimensionChangesSchema.optional(),
    })
    .strip(),
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("update_section"),
      noteId: ltmNoteIdSchema,
      sectionKey: ltmSectionKeySchema,
      section: ltmSectionSchema,
    })
    .strip(),
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("add_link"),
      noteId: ltmNoteIdSchema,
      link: ltmLinkSchema,
    })
    .strip(),
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("set_keywords"),
      noteId: ltmNoteIdSchema,
      keywords: z.array(z.string().trim().min(1).max(80)).max(30),
    })
    .strip(),
  ltmDraftMutationBaseSchema
    .extend({
      kind: z.literal("set_status"),
      noteId: ltmNoteIdSchema,
      status: ltmStatusSchema,
    })
    .strip(),
]);

export const ltmExtractionDraftSchema = z
  .object({
    id: z.string().uuid(),
    status: ltmDraftStatusSchema.default("pending"),
    createdAt: ltmIsoTimestampSchema,
    updatedAt: ltmIsoTimestampSchema,
    source: ltmDraftSourceSchema.default({}),
    scope: ltmScopeSchema.default({}),
    modes: z.array(ltmModeSchema).min(1).max(8),
    summary: z.string().max(2_000).default(""),
    mutations: z.array(ltmDraftMutationSchema).min(1),
    appliedAt: ltmIsoTimestampSchema.optional(),
    appliedMutationIds: z.array(z.string().uuid()).optional(),
    skippedMutationIds: z.array(z.string().uuid()).optional(),
  })
  .strip();

export const ltmExtractionDropReasonSchema = z.enum([
  "invalid_format",
  "placeholder_output",
  "quote_not_found_in_source",
  "missing_source_evidence",
  "source_summary_payload",
  "unsupported_bucket",
  "target_note_outside_scope",
  "too_long_to_keep_safely",
]);

export const ltmExtractionRecoveryHintSchema = z
  .object({
    noteType: ltmNoteTypeSchema.optional(),
    noteId: ltmNoteIdSchema.optional(),
    sectionKey: ltmSectionKeySchema.optional(),
    status: ltmStatusSchema.optional(),
  })
  .strict();

export const ltmExtractionDroppedCandidateSchema = z
  .object({
    index: z.number().int().min(0).max(999),
    reason: ltmExtractionDropReasonSchema,
    message: z.string().min(1).max(240),
    snippet: z.string().min(1).max(280).optional(),
    issues: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    recovery: ltmExtractionRecoveryHintSchema.optional(),
  })
  .strict();

export const ltmExtractionOutcomeStateSchema = z.enum(["success", "partial_success", "no_suggestions_created"]);

export const ltmExtractionOutcomeSchema = z
  .object({
    state: ltmExtractionOutcomeStateSchema,
    totalCandidates: z.number().int().min(0).max(999),
    keptUnits: z.number().int().min(0).max(999),
    droppedUnits: z.number().int().min(0).max(999),
    droppedCandidates: z.array(ltmExtractionDroppedCandidateSchema).max(80).default([]),
  })
  .strict();

export const ltmExtractionResponseSchema = z
  .object({
    summary: z.string().max(2_000).default(""),
    mutations: z.array(ltmDraftMutationSchema).default([]),
  })
  .strict();

export const ltmEvidenceUnitExtractionResponseSchema = z
  .object({
    summary: z.string().max(2_000).default(""),
    units: z.array(ltmEvidenceUnitSchema).default([]),
  })
  .strict();

export const ltmLastInjectionMemorySchema = z.object({
  noteId: z.string(),
  title: z.string(),
  tokenCount: z.number(),
});

export const ltmInjectionUiSummarySchema = z.object({
  memoryCount: z.number().default(0),
  tokenCount: z.number().default(0),
  memories: z.array(ltmLastInjectionMemorySchema).default([]),
});

export const ltmLastInjectionResponseSchema = z.object({
  memoryCount: z.number(),
  tokenCount: z.number(),
  memories: z.array(ltmLastInjectionMemorySchema),
});

export const ltmPendingDraftsCountResponseSchema = z.object({
  count: z.number(),
});

export type LtmNoteType = z.infer<typeof ltmNoteTypeSchema>;
export type LtmStatus = z.infer<typeof ltmStatusSchema>;
export type LtmEvidenceUnitStatus = z.infer<typeof ltmEvidenceUnitStatusSchema>;
export type LtmEvidenceUnitBucket = z.infer<typeof ltmEvidenceUnitBucketSchema>;
export type LtmImportance = z.infer<typeof ltmImportanceSchema>;
export type LtmRelationshipDimensions = z.infer<typeof ltmRelationshipDimensionsSchema>;
export type LtmRelationshipDimensionChanges = z.infer<typeof ltmRelationshipDimensionChangesSchema>;
export type LtmExtractionReasoningEffort = z.infer<typeof ltmExtractionReasoningEffortSchema>;
export type LtmExtractionVerbosity = z.infer<typeof ltmExtractionVerbositySchema>;
export type LtmGlobalSettings = z.infer<typeof ltmGlobalSettingsSchema>;
export type LtmResolvedGlobalSettings = z.infer<typeof ltmResolvedGlobalSettingsSchema>;
export type LtmExtractionSettings = z.infer<typeof ltmExtractionSettingsSchema>;
export type LtmResolvedExtractionSettings = z.infer<typeof ltmResolvedExtractionSettingsSchema>;
export type LtmMode = z.infer<typeof ltmModeSchema>;
export type LtmScope = z.infer<typeof ltmScopeSchema>;
export type LtmNoteTransferMode = z.infer<typeof ltmNoteTransferModeSchema>;
export type LtmNoteTransferConflict = z.infer<typeof ltmNoteTransferConflictSchema>;
export type LtmNoteTransferPreviewItem = z.infer<typeof ltmNoteTransferPreviewItemSchema>;
export type LtmNoteTransferPreviewRequest = z.infer<typeof ltmNoteTransferPreviewRequestSchema>;
export type LtmNoteTransferPreviewResponse = z.infer<typeof ltmNoteTransferPreviewResponseSchema>;
export type LtmLink = z.infer<typeof ltmLinkSchema>;
export type LtmSection = z.infer<typeof ltmSectionSchema>;
export type LtmConflict = z.infer<typeof ltmConflictSchema>;
export type LtmNote = z.infer<typeof ltmNoteSchema>;
export type LtmSourceProvenance = z.infer<typeof ltmSourceProvenanceSchema>;
export type LtmEvent = z.infer<typeof ltmEventSchema>;
export type LtmDebugStatus = z.infer<typeof ltmDebugStatusSchema>;
export type LtmDebugPhase = z.infer<typeof ltmDebugPhaseSchema>;
export type LtmDebugError = z.infer<typeof ltmDebugErrorSchema>;
export type LtmDebugEvent = z.infer<typeof ltmDebugEventSchema>;
export type LtmPolicy = z.infer<typeof ltmPolicySchema>;
export type LtmPoliciesConfig = z.infer<typeof ltmPoliciesConfigSchema>;
export type LtmRetrievalConfig = z.infer<typeof ltmRetrievalConfigSchema>;
export type LtmIndexMetadata = z.infer<typeof ltmIndexMetadataSchema>;
export type LtmTransferRebuildSummary = z.infer<typeof ltmTransferRebuildSummarySchema>;
export type LtmNoteTransferApplyResponse = z.infer<typeof ltmNoteTransferApplyResponseSchema>;
export type LtmDraftStatus = z.infer<typeof ltmDraftStatusSchema>;
export type LtmDraftRisk = z.infer<typeof ltmDraftRiskSchema>;
export type LtmDraftSource = z.infer<typeof ltmDraftSourceSchema>;
export type LtmDraftNoteInput = z.infer<typeof ltmDraftNoteInputSchema>;
export type LtmDraftMutation = z.infer<typeof ltmDraftMutationSchema>;
export type LtmExtractionDraft = z.infer<typeof ltmExtractionDraftSchema>;
export type LtmExtractionDropReason = z.infer<typeof ltmExtractionDropReasonSchema>;
export type LtmExtractionRecoveryHint = z.infer<typeof ltmExtractionRecoveryHintSchema>;
export type LtmExtractionDroppedCandidate = z.infer<typeof ltmExtractionDroppedCandidateSchema>;
export type LtmExtractionOutcomeState = z.infer<typeof ltmExtractionOutcomeStateSchema>;
export type LtmExtractionOutcome = z.infer<typeof ltmExtractionOutcomeSchema>;
export type LtmExtractionResponse = z.infer<typeof ltmExtractionResponseSchema>;
export type LtmEvidenceUnit = z.infer<typeof ltmEvidenceUnitSchema>;
export type LtmEvidenceUnitExtractionResponse = z.infer<typeof ltmEvidenceUnitExtractionResponseSchema>;
export type LtmLastInjectionMemory = z.infer<typeof ltmLastInjectionMemorySchema>;
export type LtmLastInjectionResponse = z.infer<typeof ltmLastInjectionResponseSchema>;
export type LtmPendingDraftsCountResponse = z.infer<typeof ltmPendingDraftsCountResponseSchema>;

/**
 * Settings stored in agent_configs.settings when type === "long-term-memory".
 * Subset of LtmGlobalSettings that are user-configurable per agent.
 */
const ltmAgentSettingsShape = z
  .object({
    author: z.string().optional(),
    connectionId: z.string().nullable().optional(),
    model: z.string().max(240).optional(),
    instruction: z.string().max(2_000).optional(),
    importConcurrency: z.number().int().min(1).max(10).optional(),
    importLimit: z.number().int().min(1).max(5000).optional(),
    importSource: z.string().max(50).optional(),
    autoApplyLowRisk: z.boolean().optional(),
    longTermMemoryBudgetTokens: z.number().int().min(128).max(16_384).optional(),
    longTermMemoryMaxChunks: z.number().int().min(1).max(100).optional(),
    longTermMemoryScoreThreshold: z.number().finite().min(0).max(1).optional(),
    longTermMemoryRecallContextMessages: z.number().int().min(1).max(20).optional(),
    longTermMemoryRecallStyle: z.enum(["balanced", "exact", "broad", "story"]).optional(),
    longTermMemorySemanticWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryLexicalWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryGraphWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryKeywordWeight: z.number().finite().min(0).max(1).nullable().optional(),
    longTermMemoryIncludeResolved: z.boolean().optional(),
    longTermMemoryRecallPreamble: z.string().max(500).optional(),
    longTermMemoryDebug: z.boolean().optional(),
  })
  .strict();

export const ltmAgentSettingsSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = { ...(value as Record<string, unknown>) };
  delete input.extractionMode;
  return input;
}, ltmAgentSettingsShape);

export type LtmAgentSettings = z.infer<typeof ltmAgentSettingsSchema>;
