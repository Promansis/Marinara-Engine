// ──────────────────────────────────────────────
// Long-Term Memory Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";

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

export const ltmStatusSchema = z.enum(["active", "resolved", "archived"]);

export const ltmEvidenceUnitStatusSchema = z.enum(["active", "resolved", "archived", "developing"]);

export const ltmEvidenceUnitBucketSchema = z.enum([
  "timeline_event",
  "character_fact",
  "character_state",
  "relationship_event",
  "relationship_state",
  "relationship_conflict",
  "world_fact",
  "thread",
  "tone",
  "anchor",
]);

export const ltmModeSchema = z.enum(["roleplay", "conversation", "game"]);

export const ltmExtractionReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export const ltmExtractionVerbositySchema = z.enum(["low", "medium", "high"]);

export const ltmExtractionPromptTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    prompt: z.string().min(1),
  })
  .strict();

export const ltmExtractionSettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    systemPrompt: z.string().min(1).max(20_000).optional(),
    extraInstruction: z.string().max(4_000).optional(),
    reasoningEffort: ltmExtractionReasoningEffortSchema.optional(),
    verbosity: ltmExtractionVerbositySchema.optional(),
    maxOutputTokens: z.number().int().min(512).max(32_768).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxSourceChars: z.number().int().min(1_000).max(200_000).optional(),
    maxExistingNoteChars: z.number().int().min(1_000).max(100_000).optional(),
    existingNoteMaxChunks: z.number().int().min(1).max(100).optional(),
    existingNoteMaxTokens: z.number().int().min(128).max(16_384).optional(),
    rejectPlaceholderOutput: z.boolean().optional(),
    promptTemplates: z.array(ltmExtractionPromptTemplateSchema).max(50).optional(),
    activePromptTemplateId: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const ltmResolvedExtractionSettingsSchema = z
  .object({
    version: z.literal(1),
    systemPrompt: z.string().min(1).max(20_000),
    extraInstruction: z.string().max(4_000),
    reasoningEffort: ltmExtractionReasoningEffortSchema,
    verbosity: ltmExtractionVerbositySchema,
    maxOutputTokens: z.number().int().min(512).max(32_768),
    temperature: z.number().finite().min(0).max(2),
    maxSourceChars: z.number().int().min(1_000).max(200_000),
    maxExistingNoteChars: z.number().int().min(1_000).max(100_000),
    existingNoteMaxChunks: z.number().int().min(1).max(100),
    existingNoteMaxTokens: z.number().int().min(128).max(16_384),
    rejectPlaceholderOutput: z.boolean(),
    promptTemplates: z.array(ltmExtractionPromptTemplateSchema).max(50),
    activePromptTemplateId: z.string().min(1).max(64).nullable(),
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

const idPrefixesByType = {
  source: ["source_", "scene_summary_"],
  timeline_event: ["timeline_"],
  character: ["char_"],
  relationship: ["rel_"],
  scene: ["scene_"],
  thread: ["thread_"],
  world: ["world_", "faction_", "location_", "rule_", "rules"],
  tone: ["tone_"],
} as const satisfies Record<z.infer<typeof ltmNoteTypeSchema>, readonly string[]>;

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

export const ltmLinkSchema = z
  .object({
    target: ltmNoteIdSchema,
    relation: ltmIdentifierSchema,
  })
  .strict();

export const ltmEvidenceUnitSchema = z
  .object({
    id: z.string().uuid(),
    bucket: ltmEvidenceUnitBucketSchema,
    subjectId: ltmIdentifierSchema,
    sectionKey: ltmSectionKeySchema,
    text: z.string().min(1).max(2_000),
    evidence: z.array(z.string().min(1).max(240)).min(1).max(20),
    confidence: z.number().finite().min(0).max(1),
    salience: z.number().finite().min(0).max(1),
    status: ltmEvidenceUnitStatusSchema,
    links: z.array(ltmLinkSchema).max(50).default([]),
    mergeHint: z.string().min(1).max(240).optional(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strip();

export const ltmSectionSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    updatedAt: ltmIsoTimestampSchema,
    salience: z.number().finite().min(0).max(1).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
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
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema,
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    createdAt: ltmIsoTimestampSchema,
    updatedAt: ltmIsoTimestampSchema,
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    version: z.number().int().min(1),
    extracted: z.boolean().optional(),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((note, ctx) => {
    const allowedPrefixes = idPrefixesByType[note.type];
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
  "summary_sync",
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
  })
  .strict()
  .refine(
    (value) => value.semanticWeight + value.lexicalWeight + value.graphWeight > 0,
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
    generatedAt: ltmIsoTimestampSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    noteCount: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    files: z.record(ltmSafeRelativePathSchema, z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  })
  .strict();

export const ltmDraftStatusSchema = z.enum(["pending", "accepted", "rejected", "auto_applied"]);

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
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema.default("active"),
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    createdAt: ltmIsoTimestampSchema.optional(),
    updatedAt: ltmIsoTimestampSchema.optional(),
    extracted: z.boolean().optional(),
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    version: z.number().int().min(1).optional(),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strip()
  .superRefine((note, ctx) => {
    const allowedPrefixes = idPrefixesByType[note.type];
    if (!allowedPrefixes.some((prefix) => note.id === prefix || note.id.startsWith(prefix))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: `ID for ${note.type} notes must start with ${allowedPrefixes.join(" or ")}.`,
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
    mutations: z.array(ltmDraftMutationSchema).min(1).max(25),
    rejectedReason: z.string().max(1_000).optional(),
    appliedAt: ltmIsoTimestampSchema.optional(),
    appliedMutationIds: z.array(z.string().uuid()).max(25).optional(),
    skippedMutationIds: z.array(z.string().uuid()).max(25).optional(),
  })
  .strip();

export const ltmExtractionResponseSchema = z
  .object({
    summary: z.string().max(2_000).default(""),
    mutations: z.array(ltmDraftMutationSchema).max(25).default([]),
  })
  .strict();

export const ltmEvidenceUnitExtractionResponseSchema = z
  .object({
    summary: z.string().max(2_000).default(""),
    units: z.array(ltmEvidenceUnitSchema).max(40).default([]),
  })
  .strict();

export type LtmNoteType = z.infer<typeof ltmNoteTypeSchema>;
export type LtmStatus = z.infer<typeof ltmStatusSchema>;
export type LtmEvidenceUnitStatus = z.infer<typeof ltmEvidenceUnitStatusSchema>;
export type LtmEvidenceUnitBucket = z.infer<typeof ltmEvidenceUnitBucketSchema>;
export type LtmExtractionReasoningEffort = z.infer<typeof ltmExtractionReasoningEffortSchema>;
export type LtmExtractionVerbosity = z.infer<typeof ltmExtractionVerbositySchema>;
export type LtmExtractionSettings = z.infer<typeof ltmExtractionSettingsSchema>;
export type LtmResolvedExtractionSettings = z.infer<typeof ltmResolvedExtractionSettingsSchema>;
export type LtmMode = z.infer<typeof ltmModeSchema>;
export type LtmScope = z.infer<typeof ltmScopeSchema>;
export type LtmLink = z.infer<typeof ltmLinkSchema>;
export type LtmSection = z.infer<typeof ltmSectionSchema>;
export type LtmConflict = z.infer<typeof ltmConflictSchema>;
export type LtmNote = z.infer<typeof ltmNoteSchema>;
export type LtmEvent = z.infer<typeof ltmEventSchema>;
export type LtmDebugStatus = z.infer<typeof ltmDebugStatusSchema>;
export type LtmDebugPhase = z.infer<typeof ltmDebugPhaseSchema>;
export type LtmDebugError = z.infer<typeof ltmDebugErrorSchema>;
export type LtmDebugEvent = z.infer<typeof ltmDebugEventSchema>;
export type LtmPolicy = z.infer<typeof ltmPolicySchema>;
export type LtmPoliciesConfig = z.infer<typeof ltmPoliciesConfigSchema>;
export type LtmRetrievalConfig = z.infer<typeof ltmRetrievalConfigSchema>;
export type LtmIndexMetadata = z.infer<typeof ltmIndexMetadataSchema>;
export type LtmDraftStatus = z.infer<typeof ltmDraftStatusSchema>;
export type LtmDraftRisk = z.infer<typeof ltmDraftRiskSchema>;
export type LtmDraftSource = z.infer<typeof ltmDraftSourceSchema>;
export type LtmDraftNoteInput = z.infer<typeof ltmDraftNoteInputSchema>;
export type LtmDraftMutation = z.infer<typeof ltmDraftMutationSchema>;
export type LtmExtractionDraft = z.infer<typeof ltmExtractionDraftSchema>;
export type LtmExtractionResponse = z.infer<typeof ltmExtractionResponseSchema>;
export type LtmEvidenceUnit = z.infer<typeof ltmEvidenceUnitSchema>;
export type LtmEvidenceUnitExtractionResponse = z.infer<typeof ltmEvidenceUnitExtractionResponseSchema>;
