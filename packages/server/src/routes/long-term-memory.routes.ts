// ──────────────────────────────────────────────
// Routes: Long-Term Memory Maintenance
// ──────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_SIDECAR_CONNECTION_ID,
  ltmConflictSchema,
  ltmDraftMutationSchema,
  ltmDraftReviewResponseSchema,
  ltmDraftStatusSchema,
  ltmDebugPhaseSchema,
  ltmDebugStatusSchema,
  ltmExtractionSettingsSchema,
  ltmExtractSourceNoteRequestSchema,
  ltmExtractSourceNoteResponseSchema,
  ltmGlobalSettingsSchema,
  ltmExtractionDraftSchema,
  ltmExtractionResponseSchema,
  ltmImportSourceNotesRequestSchema,
  ltmImportSourceNotesResponseSchema,
  ltmIdentityRepairApplyRequestSchema,
  ltmIdentityRepairApplyResponseSchema,
  ltmIdentityRepairPreviewRequestSchema,
  ltmIdentityRepairPreviewResponseSchema,
  ltmIntegrityResponseSchema,
  ltmInteropPreviewRequestSchema,
  ltmInteropPreviewResponseSchema,
  ltmIsoTimestampSchema,
  ltmLinkSchema,
  ltmModeSchema,
  ltmNoteIdSchema,
  ltmNoteTransferApplyResponseSchema,
  ltmNoteTransferPreviewRequestSchema,
  ltmNoteTransferPreviewResponseSchema,
  ltmNoteTitleSchema,
  ltmNoteTypeSchema,
  ltmRepairRequestSchema,
  ltmRepairResponseSchema,
  ltmScopeSchema,
  ltmSectionKeySchema,
  ltmSectionSchema,
  ltmStatusSchema,
  ltmSubjectsSchema,
  ltmStatusResponseSchema,
  type LtmExtractSourceNoteRequest,
  type LtmNote,
} from "@marinara-engine/shared";
import { z } from "zod";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";
import { createLLMProvider } from "../services/llm/provider-registry.js";
import { getLocalSidecarProvider, LOCAL_SIDECAR_MODEL } from "../services/llm/local-sidecar.js";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { resolveBaseUrl } from "./generate/generate-route-utils.js";
import type { BaseLLMProvider } from "../services/llm/base-provider.js";
import {
  getLongTermMemoryDirectories,
  getLongTermMemoryRoot,
  LTM_DIR_NAME,
} from "../services/long-term-memory/paths.js";
import {
  clearLtmDebugLog,
  exportLtmDebugLog,
  readLtmDebugLog,
  recordLtmDebugEvent,
} from "../services/long-term-memory/debug-log.js";
import { LongTermMemoryDraftStore } from "../services/long-term-memory/draft-store.js";
import { projectLongTermMemoryDraftReview } from "../services/long-term-memory/draft-review.js";
import {
  checkLongTermMemoryIntegrity,
  createLongTermMemoryInteropSourceNotes,
  planLongTermMemoryInteropSourceNotes,
  previewLongTermMemoryInterop,
  repairLongTermMemory,
} from "../services/long-term-memory/maintenance.js";
import {
  rebuildLongTermMemoryIndexes,
  type LtmRebuildScope,
} from "../services/long-term-memory/rebuild.js";
import { loadLtmIndexGeneration } from "../services/long-term-memory/index-generation.js";
import { readLtmIndexState } from "../services/long-term-memory/index-state.js";
import {
  applyLongTermMemoryDraft,
  LtmDraftApplyError,
} from "../services/long-term-memory/reconciliation.js";
import { LtmDraftProjectionError } from "../services/long-term-memory/draft-projector.js";
import { retrieveLongTermMemory } from "../services/long-term-memory/retrieval.js";
import {
  extractLongTermMemoryFromSourceNote,
  finalizeLongTermMemoryExtractionDraft,
  isLtmSourceNote,
} from "../services/long-term-memory/source-extraction.js";
import { directIngestGameJournal } from "../services/long-term-memory/direct-ingest.js";
import { getLtmExtractionConfig, updateLtmExtractionConfig } from "../services/long-term-memory/extraction-config.js";
import { getLtmGlobalSettings, updateLtmGlobalSettings } from "../services/long-term-memory/settings.js";
import { LongTermMemoryStorage } from "../services/long-term-memory/storage.js";
import { applyLtmScopeLinksToDerivedNotes } from "../services/long-term-memory/scope-links.js";
import { countBy } from "../services/long-term-memory/ltm-utils.js";
import { ltmModeForChatMode, resolveChatLtmScope } from "../services/long-term-memory/chat-scope.js";
import {
  applyLtmNoteTransfer,
  LtmNoteTransferError,
  previewLtmNoteTransfer,
} from "../services/long-term-memory/note-transfer.js";
import { withConcurrency } from "../lib/concurrency.js";
import { loadTrustedLtmSubjectCatalog } from "../services/long-term-memory/subject-identity.js";
import { readLongTermMemoryInjectionReceipt } from "../services/long-term-memory/usage.js";
import {
  applyLtmIdentityRepairs,
  LtmIdentityRepairError,
  previewLtmIdentityRepairs,
} from "../services/long-term-memory/identity-repair.js";

const NOTE_BODY_LIMIT_BYTES = 512 * 1024;
const DRAFT_BODY_LIMIT_BYTES = 512 * 1024;
const SEARCH_BODY_LIMIT_BYTES = 128 * 1024;
const REBUILD_BODY_LIMIT_BYTES = 8 * 1024;
const MAINTENANCE_BODY_LIMIT_BYTES = 32 * 1024;
const IDENTITY_REPAIR_BODY_LIMIT_BYTES = 512 * 1024;

function extractionCanMarkSourceCurrent(input: {
  response: { mutations: unknown[] };
  diagnostics: Array<{ severity: "warning" | "error" }>;
  outcome: { state: string; droppedUnits: number };
}) {
  if (input.response.mutations.length > 0) return true;
  return input.outcome.state === "no_suggestions_created" && input.outcome.droppedUnits === 0 && input.diagnostics.length === 0;
}

async function markSourceExtractionCurrent(
  storage: LongTermMemoryStorage,
  note: LtmNote,
  fingerprint: NonNullable<LtmNote["extractionFingerprint"]> | undefined,
  summary: string,
) {
  if (!fingerprint) return note;
  return storage.updateNote(
    note.id,
    { extractionFingerprint: fingerprint },
    {
      actor: "maintenance_api",
      cause: "source_extraction.completed",
      summary,
    },
  );
}

const ltmIdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "Identifier must be lowercase snake_case.");

const scopedListIdsSchema = z.preprocess(
  (value) => {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return values.map((item) => String(item).trim()).filter(Boolean);
  },
  z.array(z.string().min(1).max(120)).max(100).optional(),
);

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "false") return false;
  if (value === "true") return true;
  return value;
}, z.boolean().optional());

const listNotesQuerySchema = z
  .object({
    type: ltmNoteTypeSchema.optional(),
    status: ltmStatusSchema.optional(),
    tag: ltmIdentifierSchema.optional(),
    scopeChatIds: scopedListIdsSchema,
    scopeGroupId: z.string().min(1).max(120).optional(),
    scopeCharacterIds: scopedListIdsSchema,
    includeGlobal: queryBooleanSchema,
  })
  .strict();

const removeNoteScopeBodySchema = z
  .object({
    chatIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    groupId: z.string().min(1).max(120).optional(),
    characterIds: z.array(z.string().min(1).max(120)).max(100).optional(),
  })
  .strict()
  .refine((body) => (body.chatIds?.length ?? 0) > 0 || Boolean(body.groupId) || (body.characterIds?.length ?? 0) > 0, {
    message: "At least one scope link is required.",
  });

const createNoteBodySchema = z
  .object({
    id: ltmNoteIdSchema,
    title: ltmNoteTitleSchema.optional(),
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema,
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    keywords: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    createdAt: ltmIsoTimestampSchema.optional(),
    updatedAt: ltmIsoTimestampSchema.optional(),
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    subjects: ltmSubjectsSchema.optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((note, ctx) => {
    const expected = note.type === "character" ? 1 : note.type === "relationship" ? 2 : 0;
    if (expected > 0 && note.subjects?.length !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjects"],
        message: `${note.type === "character" ? "Character" : "Relationship"} notes require exactly ${expected} subject${expected === 1 ? "" : "s"}.`,
      });
    }
    if (expected === 0 && note.subjects) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjects"],
        message: "Only character and relationship notes can store subjects.",
      });
    }
  });

const updateNoteBodySchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const body = { ...(value as Record<string, unknown>) };
    if (body.title === null || body.title === "") body.title = undefined;
    return body;
  },
  z
    .object({
      title: ltmNoteTitleSchema.optional(),
      type: ltmNoteTypeSchema.optional(),
      status: ltmStatusSchema.optional(),
      modes: z.array(ltmModeSchema).min(1).max(8).optional(),
      scope: ltmScopeSchema.optional(),
      tags: z.array(ltmIdentifierSchema).max(100).optional(),
      keywords: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
      links: z.array(ltmLinkSchema).max(250).optional(),
      sections: z.record(ltmSectionKeySchema, ltmSectionSchema).optional(),
      conflicts: z.array(ltmConflictSchema).max(250).optional(),
      subjects: ltmSubjectsSchema.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "Patch body must include at least one updatable field."),
);

const rebuildBodySchema = z.object({}).strict().default({});

const draftIdParamSchema = z.object({ id: z.string().uuid() }).strict();
const draftMutationParamSchema = z.object({ id: z.string().uuid(), mutationId: z.string().uuid() }).strict();
const noteIdParamSchema = z.object({ id: ltmNoteIdSchema }).strict();
const permanentDeleteNotesBodySchema = z
  .object({
    ids: z.array(ltmNoteIdSchema).min(1).max(100),
  })
  .strict();

const listDraftsQuerySchema = z
  .object({
    status: ltmDraftStatusSchema.optional(),
    chatId: z.string().min(1).max(120).optional(),
  })
  .strict();

const draftReviewQuerySchema = z
  .object({
    sourceNoteId: ltmNoteIdSchema.optional(),
    chatId: z.string().min(1).max(120).optional(),
    status: ltmDraftStatusSchema.optional(),
  })
  .strict();

const acceptDraftBodySchema = z
  .object({
    mutationIds: z.array(z.string().uuid()).min(1).optional(),
    lowRiskOnly: z.boolean().optional(),
    editedMutations: z.array(ltmDraftMutationSchema).optional(),
  })
  .strict()
  .default({});

const skipDraftBodySchema = z
  .object({
    mutationIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

const applyScopeToDerivedBodySchema = z
  .object({
    chatIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    characterIds: z.array(z.string().min(1).max(120)).max(100).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.chatIds?.length || value.characterIds?.length), {
    message: "Provide at least one chat or character link to apply.",
  });

const searchBodySchema = z
  .object({
    queryText: z.string().max(20_000).optional(),
    recentUserMessage: z.string().max(20_000).optional(),
    recentMessages: z.array(z.string().max(10_000)).max(20).optional(),
    mentionedCharacterNames: z.array(z.string().min(1).max(120)).max(100).optional(),
    noteIds: z.array(ltmNoteIdSchema).max(100).optional(),
    tags: z.array(ltmIdentifierSchema).max(100).optional(),
    mode: ltmModeSchema.optional(),
    scope: ltmScopeSchema.optional(),
    characterIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    includeResolved: z.boolean().optional(),
    includeSourceNotes: z.boolean().optional(),
    debug: z.boolean().optional(),
    maxChunks: z.number().int().min(1).max(100).optional(),
    maxTokens: z.number().int().min(128).max(16_384).optional(),
    minScore: z.number().finite().min(0).max(1).optional(),
    semanticWeight: z.number().finite().min(0).max(1).optional(),
    lexicalWeight: z.number().finite().min(0).max(1).optional(),
    graphWeight: z.number().finite().min(0).max(1).optional(),
    keywordWeight: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.queryText?.trim() ||
        value.recentUserMessage?.trim() ||
        value.recentMessages?.length ||
        value.mentionedCharacterNames?.length ||
        value.noteIds?.length ||
        value.tags?.length ||
        value.characterIds?.length ||
        value.scope,
      ),
    "Search body must include query text, ids, tags, scope, or character signals.",
  );

const debugLogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1_000).default(200),
    operationId: z.string().uuid().optional(),
    sourceNoteId: ltmNoteIdSchema.optional(),
    draftId: z.string().uuid().optional(),
    status: ltmDebugStatusSchema.optional(),
    phase: ltmDebugPhaseSchema.optional(),
  })
  .strict();

async function getEventLogStatus(path: string) {
  try {
    const info = await stat(path);
    return { logAvailable: true, bytes: info.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { logAvailable: false, bytes: 0 };
    }
    return { logAvailable: false, bytes: null };
  }
}

function sanitizeStorageText(value: string) {
  return value.split(getLongTermMemoryRoot()).join(LTM_DIR_NAME);
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function normalizeLtmIdentifier(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) ? value : null;
}

function publicRebuildResult(result: Awaited<ReturnType<typeof rebuildLongTermMemoryIndexes>>) {
  return {
    generatedAt: result.generatedAt,
    noteCount: result.noteCount,
    chunkCount: result.chunkCount,
    sourceChunkCount: result.sourceChunkCount,
    embeddedChunkCount: result.embeddedChunkCount,
    embeddingsAvailable: result.embeddingsAvailable,
    manifest: result.manifest,
  };
}

function summarizeNotes(notes: LtmNote[]) {
  return {
    total: notes.length,
    byType: countBy(notes.map((note) => note.type)),
    byStatus: countBy(notes.map((note) => note.status)),
  };
}

function rebuildScopeForNote(note: LtmNote) {
  return isLtmSourceNote(note) ? "source" : "typed";
}

function rebuildScopeForNotes(notes: readonly LtmNote[]): LtmRebuildScope {
  const scopes = new Set(notes.map((note) => rebuildScopeForNote(note)));
  return scopes.size > 1 ? "all" : (scopes.values().next().value ?? "all");
}

class LtmExtractionRouteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function requireLtmExtractionModel(model: string | null | undefined) {
  const resolved = model?.trim();
  if (!resolved) throw new LtmExtractionRouteError("No model configured for LTM source extraction", 400);
  return resolved;
}

function importAbortError() {
  const error = new Error("Long-term memory import was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfImportAborted(signal: AbortSignal) {
  if (signal.aborted) throw importAbortError();
}

function isImportAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function withImportAbortSignal<T>(request: FastifyRequest, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  if (request.raw.aborted) abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

export async function longTermMemoryRoutes(app: FastifyInstance) {
  const storage = new LongTermMemoryStorage();
  const draftStore = new LongTermMemoryDraftStore();
  const chats = createChatsStorage(app.db);
  const connections = createConnectionsStorage(app.db);

  async function resolveExtractionProvider(
    body: LtmExtractSourceNoteRequest,
    chatConnectionId?: string | null,
  ) {
    const defaultAgentConn = body.connectionId ? null : await connections.getDefaultForAgents();
    let connId = body.connectionId ?? defaultAgentConn?.id ?? chatConnectionId ?? null;
    if (connId === "random") {
      const pool = await connections.listRandomPool();
      if (!pool.length) throw new LtmExtractionRouteError("No connections are marked for the random pool", 400);
      connId = pool[Math.floor(Math.random() * pool.length)]!.id;
    }

    if (connId === LOCAL_SIDECAR_CONNECTION_ID) {
      return {
        provider: getLocalSidecarProvider(),
        model: requireLtmExtractionModel(body.model ?? LOCAL_SIDECAR_MODEL),
      };
    }

    let conn =
      connId === defaultAgentConn?.id ? defaultAgentConn : connId ? await connections.getWithKey(connId) : null;
    if (body.connectionId && !conn) {
      throw new LtmExtractionRouteError(`API connection not found: ${body.connectionId}`, 400);
    }
    if (chatConnectionId && connId === chatConnectionId && !conn) {
      throw new LtmExtractionRouteError(`Chat API connection not found: ${chatConnectionId}`, 400);
    }
    if (!conn) {
      const defaultConn = await connections.getDefault();
      conn = defaultConn ? await connections.getWithKey(defaultConn.id) : null;
    }
    if (!conn) throw new LtmExtractionRouteError("No API connection configured for LTM source extraction", 400);

    return {
      provider: createLLMProvider(
        conn.provider,
        resolveBaseUrl(conn),
        conn.apiKey,
        conn.maxContext,
        conn.openrouterProvider,
        conn.maxTokensOverride,
        conn.claudeFastMode === "true",
      ),
      model: requireLtmExtractionModel(body.model ?? conn.model),
    };
  }

  app.get("/status", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory status" })) return;
    await storage.initializeLtmStore();
    const notes = await storage.listNotes();
    const dirs = getLongTermMemoryDirectories(storage.root);
    const events = await getEventLogStatus(dirs.eventLog);
    const [integrity, generationResult, stateResult] = await Promise.all([
      checkLongTermMemoryIntegrity(storage.root),
      loadLtmIndexGeneration(storage.root).then(
        (value) => ({ value, error: null }),
        () => ({ value: null, error: { index: "generation", code: "index_unavailable" } }),
      ),
      readLtmIndexState(storage.root).then(
        (value) => ({ value, error: null }),
        () => ({ value: null, error: { index: "state", code: "index_unavailable" } }),
      ),
    ]);
    const generation = generationResult.value;
    const state = stateResult.value;
    const manifest = generation?.manifest ?? null;
    const embeddings = generation?.bundles.typed?.embeddings ?? null;
    const errors = [generationResult.error, stateResult.error].filter(
      (error): error is NonNullable<typeof error> => Boolean(error),
    );

    return ltmStatusResponseSchema.parse({
      initialized: true,
      directory: LTM_DIR_NAME,
      notes: summarizeNotes(notes),
      events,
      indexes: {
        health: integrity.health,
        manifestAvailable: Boolean(manifest),
        generationId: manifest?.generationId ?? null,
        currentGenerationId: generation?.pointer?.generationId ?? null,
        recovered: generation?.recovered ?? false,
        dirty: state?.dirty ?? true,
        rebuildState: state?.rebuildState ?? "idle",
        errors,
        warnings: generation?.warnings ?? [],
        generatedAt: manifest?.generatedAt ?? null,
        sourceHash: manifest?.sourceHash ?? null,
        noteCount: manifest?.noteCount ?? null,
        chunkCount: manifest?.chunkCount ?? null,
        chunkFormatVersion: manifest?.chunkFormatVersion ?? null,
        embeddingsAvailable: Boolean(embeddings?.embeddedChunkCount),
        embeddedChunkCount: embeddings?.embeddedChunkCount ?? 0,
      },
    });
  });

  app.get<{ Querystring: unknown }>("/debug-log", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory debug log access" })) return;
    const query = debugLogQuerySchema.parse(req.query);
    return { events: await readLtmDebugLog(query) };
  });

  app.get("/debug-log/export", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory debug log export" })) return;
    const content = await exportLtmDebugLog();
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename="ltm-debug-log-${Date.now()}.jsonl"`)
      .send(content);
  });

  app.delete("/debug-log", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory debug log clearing" })) return;
    return clearLtmDebugLog();
  });

  app.get<{ Params: { chatId: string } }>("/last-injection/:chatId", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory last injection" })) return;
    const receipt = await readLongTermMemoryInjectionReceipt(req.params.chatId);
    if (!receipt) {
      return reply.send({ memoryCount: 0, tokenCount: 0, memories: [] });
    }
    const notes = await storage.listNotes();
    const titleMap = new Map(notes.map((n) => [n.id, n.title?.trim() || n.id]));
    const memories = new Map<string, { noteId: string; title: string; tokenCount: number }>();
    for (const chunk of receipt.chunks) {
      const existing = memories.get(chunk.noteId);
      if (existing) {
        existing.tokenCount += chunk.tokenCount;
      } else {
        memories.set(chunk.noteId, {
          noteId: chunk.noteId,
          title: titleMap.get(chunk.noteId) ?? chunk.noteId,
          tokenCount: chunk.tokenCount,
        });
      }
    }
    return reply.send({
      memoryCount: memories.size,
      tokenCount: receipt.serializedTokenCount,
      memories: Array.from(memories.values()),
    });
  });

  app.get("/extraction-settings", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory extraction settings" })) return;
    return getLtmExtractionConfig();
  });

  app.put<{ Body: unknown }>(
    "/extraction-settings",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory extraction settings" })) return;
      return updateLtmExtractionConfig(ltmExtractionSettingsSchema.parse(req.body ?? {}));
    },
  );

  app.get("/settings", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory settings" })) return;
    return getLtmGlobalSettings();
  });

  app.put<{ Body: unknown }>("/settings", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory settings" })) return;
    return updateLtmGlobalSettings(ltmGlobalSettingsSchema.parse(req.body ?? {}));
  });

  app.get<{ Querystring: unknown }>("/notes", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory notes list" })) return;
    const query = listNotesQuerySchema.parse(req.query);
    const scope =
      query.scopeChatIds?.length || query.scopeGroupId || query.scopeCharacterIds?.length
        ? {
            ...(query.scopeChatIds?.length ? { chatIds: query.scopeChatIds, chatId: query.scopeChatIds[0] } : {}),
            ...(query.scopeGroupId ? { groupId: query.scopeGroupId } : {}),
            ...(query.scopeCharacterIds?.length ? { characterIds: query.scopeCharacterIds } : {}),
          }
        : undefined;
    return storage.listNotes({
      type: query.type,
      status: query.status,
      tag: query.tag,
      scope,
      characterIds: query.scopeCharacterIds,
      includeGlobal: query.includeGlobal,
    });
  });

  app.get<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note detail" })) return;
    const id = ltmNoteIdSchema.parse(req.params.id);
    const note = await storage.getNote(id);
    if (!note) return reply.status(404).send({ error: "Long-term memory note not found" });
    return note;
  });

  app.post<{ Body: unknown }>(
    "/notes/transfer-preview",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note transfer preview" })) return;
      const body = ltmNoteTransferPreviewRequestSchema.parse(req.body ?? {});
      const destinationChat = await chats.getById(body.destinationChatId);
      if (!destinationChat) return reply.status(404).send({ error: "Destination chat not found" });

      try {
        return ltmNoteTransferPreviewResponseSchema.parse(await previewLtmNoteTransfer(body, destinationChat));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to preview long-term memory transfer";
        const status = err instanceof LtmNoteTransferError ? err.statusCode : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  app.post<{ Body: unknown }>("/notes/transfer", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note transfer" })) return;
    const body = ltmNoteTransferPreviewRequestSchema.parse(req.body ?? {});
    const destinationChat = await chats.getById(body.destinationChatId);
    if (!destinationChat) return reply.status(404).send({ error: "Destination chat not found" });

    try {
      const result = await applyLtmNoteTransfer(body, destinationChat, {
        storage,
        rebuild: async () => publicRebuildResult(await rebuildLongTermMemoryIndexes()),
      });
      return ltmNoteTransferApplyResponseSchema.parse(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to transfer long-term memory notes";
      const status = err instanceof LtmNoteTransferError ? err.statusCode : 500;
      return reply.status(status).send({ error: message });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/notes/:id/extract",
    { bodyLimit: DRAFT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory source extraction" })) return;
      const { id } = noteIdParamSchema.parse(req.params);
      const body = ltmExtractSourceNoteRequestSchema.parse(req.body ?? {});
      const sourceNote = await storage.getNote(id);
      if (!sourceNote) return reply.status(404).send({ error: "Long-term memory note not found" });
      if (!isLtmSourceNote(sourceNote)) {
        return reply.status(400).send({ error: "Long-term memory note is not a source note" });
      }

      const chat = body.chatId ? await chats.getById(body.chatId) : null;
      if (body.chatId && !chat) return reply.status(404).send({ error: "Chat not found" });

      const operationId = randomUUID();

      // Game journal source notes are ingested directly without LLM extraction
      if (sourceNote.tags.includes("imported_game_journal")) {
        try {
          const directResult = await directIngestGameJournal(app.db, sourceNote, undefined, operationId, {
            applyLowRisk: body.applyLowRisk,
          });
          if (extractionCanMarkSourceCurrent(directResult)) {
            await markSourceExtractionCurrent(
              storage,
              directResult.sourceNote,
              directResult.draft?.source.extractionFingerprint,
              `Completed extraction for ${directResult.sourceNote.title ?? directResult.sourceNote.id}`,
            );
          }
          await rebuildLongTermMemoryIndexes({
            scope: directResult.appliedMutationIds.length > 0 ? "all" : "source",
          });
          return ltmExtractSourceNoteResponseSchema.parse({
            operationId: directResult.operationId,
            draft: directResult.draft,
            diagnostics: directResult.diagnostics,
            outcome: directResult.outcome,
            accounting: directResult.accounting,
            response: directResult.response,
            appliedMutationIds: directResult.appliedMutationIds,
            skippedMutationIds: directResult.skippedMutationIds,
          });
        } catch (err) {
          await recordLtmDebugEvent({
            operationId,
            phase: "extraction",
            action: "extract_source_note_route",
            status: "error",
            sourceNoteId: id,
            error: err,
          });
          const message = err instanceof Error ? err.message : "Failed to extract long-term memory from source note";
          return reply.status(502).send({ error: message });
        }
      }

      try {
        const { provider, model } = await resolveExtractionProvider(body, chat?.connectionId ?? null);
        const extractionScope = chat ? resolveChatLtmScope(chat) : sourceNote.scope;
        const trustedSubjectCatalog = await loadTrustedLtmSubjectCatalog(app.db, extractionScope);
        await recordLtmDebugEvent({
          operationId,
          phase: "extraction",
          action: "provider_resolved",
          status: "ok",
          sourceNoteId: id,
          provider: provider.constructor.name,
          model,
        });
        const result = await extractLongTermMemoryFromSourceNote({
          noteId: id,
          provider,
          model,
          scope: extractionScope,
          modes: chat ? [ltmModeForChatMode(chat.mode)] : sourceNote.modes,
          mode: body.mode,
          instruction: body.instruction,
          operationId,
          trustedSubjectCatalog,
        });
        const applyResult =
          body.applyLowRisk && result.draft && result.draft.mutations.length > 0
            ? await applyLongTermMemoryDraft(result.draft.id, {
                actor: "maintenance_api",
                autoApplyLowRiskOnly: true,
                operationId,
              })
            : null;
        if (extractionCanMarkSourceCurrent(result)) {
          await markSourceExtractionCurrent(
            storage,
            result.sourceNote,
            (applyResult?.draft ?? result.draft)?.source.extractionFingerprint,
            `Completed extraction for ${result.sourceNote.title ?? result.sourceNote.id}`,
          );
        }
        await rebuildLongTermMemoryIndexes({ scope: "source" });

        return ltmExtractSourceNoteResponseSchema.parse({
          operationId: result.operationId,
          draft: applyResult?.draft ?? result.draft,
          diagnostics: result.diagnostics,
          outcome: result.outcome,
          accounting: result.accounting,
          response: result.response,
          appliedMutationIds: applyResult?.appliedMutationIds ?? [],
          skippedMutationIds: applyResult?.skippedMutationIds ?? [],
        });
      } catch (err) {
        await recordLtmDebugEvent({
          operationId,
          phase: "extraction",
          action: "extract_source_note_route",
          status: "error",
          sourceNoteId: id,
          error: err,
        });
        const message = err instanceof Error ? err.message : "Failed to extract long-term memory from source note";
        const status =
          err instanceof LtmExtractionRouteError
            ? err.statusCode
            : message.includes("not found")
              ? 404
              : message.includes("configured")
                ? 400
                : 502;
        return reply.status(status).send({ error: message });
      }
    },
  );

  app.post<{ Body: unknown }>("/notes", { bodyLimit: NOTE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note creation" })) return;
    const body = createNoteBodySchema.parse(req.body);
    const existing = await storage.getNote(body.id);
    if (existing) return reply.status(409).send({ error: `Long-term memory note already exists: ${body.id}` });

    const note = await storage.createNote(body, {
      actor: "maintenance_api",
      cause: "api.create",
      summary: "Created via long-term memory maintenance API",
    });
    await rebuildLongTermMemoryIndexes({ scope: rebuildScopeForNote(note) });
    return reply.status(201).send(note);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/notes/:id",
    { bodyLimit: NOTE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note update" })) return;
      const id = ltmNoteIdSchema.parse(req.params.id);
      const patch = updateNoteBodySchema.parse(req.body);
      const existing = await storage.getNote(id);
      if (!existing) return reply.status(404).send({ error: "Long-term memory note not found" });

      const note = await storage.updateNote(id, patch, {
        actor: "maintenance_api",
        cause: "api.patch",
        summary: "Updated via long-term memory maintenance API",
      });
      await rebuildLongTermMemoryIndexes({
        scope: rebuildScopeForNote(existing) === "source" ? "source" : rebuildScopeForNote(note),
      });
      return note;
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/notes/:id/scope/apply-to-derived",
    { bodyLimit: REBUILD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory derived scope update" })) return;
      const id = ltmNoteIdSchema.parse(req.params.id);
      const body = applyScopeToDerivedBodySchema.parse(req.body ?? {});
      const result = await applyLtmScopeLinksToDerivedNotes(id, {
        chatIds: body.chatIds,
        characterIds: body.characterIds,
      });
      if (!result) return reply.status(404).send({ error: "Long-term memory note not found" });
      return {
        sourceNoteId: result.sourceNoteId,
        count: result.count,
        affectedNoteIds: result.affectedNoteIds,
        rebuild: result.rebuild ? publicRebuildResult(result.rebuild) : null,
      };
    },
  );

  app.delete<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note archival" })) return;
    const id = ltmNoteIdSchema.parse(req.params.id);
    const existing = await storage.getNote(id);
    if (!existing) return reply.status(404).send({ error: "Long-term memory note not found" });

    const archivedNotes = await storage.archiveSourceNoteWithDerived(id, {
      actor: "maintenance_api",
      cause: "api.archive",
      summary: "Archived via long-term memory maintenance API",
    });
    const rebuild = await rebuildLongTermMemoryIndexes();
    return { archived: true, note: archivedNotes[0], notes: archivedNotes, rebuild: publicRebuildResult(rebuild) };
  });

  app.post<{ Body: unknown }>(
    "/notes/permanent-delete",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note deletion" })) return;
      const body = permanentDeleteNotesBodySchema.parse(req.body ?? {});
      const result = await storage.deleteNotesPermanently(body.ids, {
        actor: "maintenance_api",
        cause: "api.delete",
        summary: "Deleted via long-term memory maintenance API",
      });
      if (result.deletedNotes.length > 0) {
        await rebuildLongTermMemoryIndexes({ scope: rebuildScopeForNotes(result.deletedNotes) });
      }
      return { deletedIds: result.deletedIds, failedIds: result.failedIds };
    },
  );

  app.delete<{ Params: { id: string } }>("/notes/:id/permanent", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note deletion" })) return;
    const id = ltmNoteIdSchema.parse(req.params.id);
    const existing = await storage.getNote(id);
    if (!existing) return reply.status(404).send({ error: "Long-term memory note not found" });

    const note = await storage.deleteNote(id, {
      actor: "maintenance_api",
      cause: "api.delete",
      summary: "Deleted via long-term memory maintenance API",
    });
    await rebuildLongTermMemoryIndexes({ scope: rebuildScopeForNote(note) });
    return { deleted: true, id: note.id };
  });

  app.delete<{ Params: { id: string }; Body: unknown }>(
    "/notes/:id/scope",
    { bodyLimit: REBUILD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note scope removal" })) return;
      const id = ltmNoteIdSchema.parse(req.params.id);
      const body = removeNoteScopeBodySchema.parse(req.body ?? {});
      const existing = await storage.getNote(id);
      if (!existing) return reply.status(404).send({ error: "Long-term memory note not found" });

      const result = await storage.removeNoteFromScope(id, body, {
        actor: "maintenance_api",
        cause: "api.unscope",
        summary: "Removed from scope via long-term memory maintenance API",
      });
      if (result.deleted || result.changed) {
        await rebuildLongTermMemoryIndexes({
          scope: result.deleted ? rebuildScopeForNote(existing) : rebuildScopeForNote(result.note!),
        });
      }
      if (result.deleted) {
        return { deleted: true, unscoped: false, id: existing.id };
      }
      return { deleted: false, unscoped: result.changed, id: result.note!.id, note: result.note };
    },
  );

  app.post<{ Body: unknown }>("/rebuild", { bodyLimit: REBUILD_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory index rebuild" })) return;
    rebuildBodySchema.parse(req.body ?? {});
    const operationId = randomUUID();
    await recordLtmDebugEvent({
      operationId,
      phase: "rebuild",
      action: "manual_rebuild",
      status: "started",
    });
    const started = Date.now();
    try {
      const result = await rebuildLongTermMemoryIndexes();
      await recordLtmDebugEvent({
        operationId,
        phase: "rebuild",
        action: "manual_rebuild",
        status: "ok",
        durationMs: Date.now() - started,
        counts: {
          notes: result.noteCount,
          chunks: result.chunkCount,
          sourceChunks: result.sourceChunkCount,
          embeddedChunks: result.embeddedChunkCount,
        },
      });
      return publicRebuildResult(result);
    } catch (err) {
      await recordLtmDebugEvent({
        operationId,
        phase: "rebuild",
        action: "manual_rebuild",
        status: "error",
        durationMs: Date.now() - started,
        error: err,
      });
      throw err;
    }
  });

  app.get("/integrity", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory integrity check" })) return;
    return ltmIntegrityResponseSchema.parse(await checkLongTermMemoryIntegrity());
  });

  app.post<{ Body: unknown }>("/repair", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory repair" })) return;
    const body = ltmRepairRequestSchema.parse(req.body);
    return ltmRepairResponseSchema.parse(await repairLongTermMemory(body.actions));
  });

  app.post<{ Body: unknown }>(
    "/identity-repair/preview",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory identity repair preview" })) return;
      const body = ltmIdentityRepairPreviewRequestSchema.parse(req.body ?? {});
      const catalog = await loadTrustedLtmSubjectCatalog(app.db, body.scope, getLongTermMemoryRoot());
      return ltmIdentityRepairPreviewResponseSchema.parse(previewLtmIdentityRepairs(catalog, body.scope));
    },
  );

  app.post<{ Body: unknown }>(
    "/identity-repair/apply",
    { bodyLimit: IDENTITY_REPAIR_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory identity repair" })) return;
      const body = ltmIdentityRepairApplyRequestSchema.parse(req.body ?? {});
      try {
        return ltmIdentityRepairApplyResponseSchema.parse(
          await applyLtmIdentityRepairs(body, {
            loadCatalog: () => loadTrustedLtmSubjectCatalog(app.db, body.scope, getLongTermMemoryRoot()),
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to repair long-term memory identities";
        const status = error instanceof LtmIdentityRepairError ? error.statusCode : 500;
        const code = error instanceof LtmIdentityRepairError ? error.code : "identity_repair_failed";
        return reply.status(status).send({ error: message, code });
      }
    },
  );

  app.post<{ Body: unknown }>("/import/preview", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory source import preview" })) return;
    const body = ltmInteropPreviewRequestSchema.parse(req.body);
    return ltmInteropPreviewResponseSchema.parse(
      await previewLongTermMemoryInterop(app.db, body.source, body.limit, getLongTermMemoryRoot(), body.scope, body.mode),
    );
  });

  app.post<{ Body: unknown }>(
    "/import/source-notes",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory source import" })) return;
      const body = ltmImportSourceNotesRequestSchema.parse(req.body);
      const operationId = randomUUID();
      const importOptions = {
        sourceIds: body.sourceIds,
        limit: body.limit,
        scope: body.scope,
        mode: body.mode,
        operationId,
      };
      const plan = await planLongTermMemoryInteropSourceNotes(app.db, body.source, importOptions);
      let provider: BaseLLMProvider | null = null;
      let model = "";
      if (plan.requiresExtraction) {
        const resolved = await resolveExtractionProvider(body);
        provider = resolved.provider;
        model = resolved.model;
        await recordLtmDebugEvent({
          operationId,
          phase: "extraction",
          action: "provider_resolved",
          status: "ok",
          source: plan.source,
          provider: provider.constructor.name,
          model,
        });
      }
      return withImportAbortSignal(req, async (signal) => {
        throwIfImportAborted(signal);
        const imported = await createLongTermMemoryInteropSourceNotes(app.db, body.source, {
          ...importOptions,
          plan,
        });
        const importedSourceNoteCount = imported.imported.length;
        const results = [];

        const importConcurrency = Math.max(body.importConcurrency ?? 3, 1);

        const tasks = imported.imported.map((item) => async () => {
          try {
            throwIfImportAborted(signal);
            const isGameJournal = item.note.tags.includes("imported_game_journal");

            if (isGameJournal) {
              const directResult = await directIngestGameJournal(app.db, item.note, undefined, operationId, {
                applyLowRisk: false,
                persistDraft: false,
                signal,
              });
              throwIfImportAborted(signal);
              return {
                state: "prepared" as const,
                item,
                extractionMethod: "direct_ingest" as const,
                sourceNote: directResult.sourceNote,
                extractionMode: directResult.extractionMode,
                diagnostics: directResult.diagnostics,
                outcome: directResult.outcome,
                accounting: directResult.accounting,
                response: directResult.response,
              };
            }

            if (!provider) {
              throw new Error("No LLM provider available for non-game source note extraction");
            }
            const trustedSubjectCatalog = await loadTrustedLtmSubjectCatalog(app.db, item.note.scope);
            const result = await extractLongTermMemoryFromSourceNote({
              noteId: item.note.id,
              provider,
              model,
              scope: item.note.scope,
              modes: item.note.modes,
              mode: body.mode,
              instruction: body.instruction,
              operationId,
              signal,
              trustedSubjectCatalog,
              persistDraft: false,
            });
            throwIfImportAborted(signal);
            return {
              state: "prepared" as const,
              item,
              extractionMethod: "llm" as const,
              sourceNote: result.sourceNote,
              extractionMode: result.extractionMode,
              diagnostics: result.diagnostics,
              outcome: result.outcome,
              accounting: result.accounting,
              response: result.response,
            };
          } catch (err) {
            const cancelled = signal.aborted || isImportAbortError(err);
            const message = err instanceof Error ? err.message : "Failed to extract imported source";
            await recordLtmDebugEvent({
              operationId,
              phase: "extraction",
              action: "imported_source_extract",
              status: cancelled ? "warning" : "error",
              source: imported.source,
              sourceId: item.sourceId,
              sourceNoteId: item.note.id,
              error: err,
            });
            return {
              state: "failed" as const,
              item,
              extractionMethod: item.note.tags.includes("imported_game_journal")
                ? ("direct_ingest" as const)
                : ("llm" as const),
              cancelled,
              message,
            };
          }
        });

        const preparedResults = await withConcurrency(tasks, importConcurrency);
        const overlay = new Map<string, LtmNote>();
        for (const prepared of preparedResults) {
          const { item } = prepared;
          if (prepared.state === "failed") {
            results.push({
              sourceId: item.sourceId,
              title: item.title,
              note: item.note,
              created: item.created,
              sourceWriteStatus: item.created ? ("created" as const) : ("refreshed" as const),
              extractionStatus: prepared.cancelled ? ("cancelled" as const) : ("failed" as const),
              extractionMethod: prepared.extractionMethod,
              retryable: true,
              error: {
                code: prepared.cancelled ? "cancelled" : "extract_failed",
                message: prepared.message,
              },
              draft: null,
              diagnostics: [
                {
                  severity: prepared.cancelled ? ("warning" as const) : ("error" as const),
                  code: prepared.cancelled ? "cancelled" : "extract_failed",
                  message: prepared.message,
                },
              ],
              outcome: {
                state: "no_suggestions_created" as const,
                totalCandidates: 0,
                keptUnits: 0,
                droppedUnits: 0,
                droppedCandidates: [],
              },
              accounting: {
                providerCandidates: 0,
                normalizedAdditions: 0,
                parserRejections: 0,
                validationRejections: 0,
                deduplications: 0,
                keptUnits: 0,
              },
              appliedMutationIds: [],
              skippedMutationIds: [],
            });
            continue;
          }

          try {
            throwIfImportAborted(signal);
            const draft = await finalizeLongTermMemoryExtractionDraft(
              {
                sourceNote: prepared.sourceNote,
                response: prepared.response,
                scope: prepared.sourceNote.scope,
                modes: prepared.sourceNote.modes,
                extractionMode: prepared.extractionMode,
                operationId,
                diagnostics: prepared.diagnostics,
                outcome: prepared.outcome,
                accounting: prepared.accounting,
              },
              { overlay },
            );
            const applyResult =
              body.applyLowRisk && draft.mutations.length > 0
                ? await applyLongTermMemoryDraft(draft.id, {
                    actor: "maintenance_api",
                    autoApplyLowRiskOnly: true,
                    rebuildIndexes: false,
                    operationId,
                  })
                : null;
            const extractedNote = extractionCanMarkSourceCurrent(prepared)
              ? await markSourceExtractionCurrent(
                  storage,
                  prepared.sourceNote,
                  (applyResult?.draft ?? draft).source.extractionFingerprint,
                  `Completed extraction for ${item.title}`,
                )
              : prepared.sourceNote;
            results.push({
              sourceId: item.sourceId,
              title: item.title,
              note: extractedNote,
              created: item.created,
              sourceWriteStatus: item.created ? ("created" as const) : ("refreshed" as const),
              extractionStatus: "succeeded" as const,
              extractionMethod: prepared.extractionMethod,
              retryable: false,
              draft: applyResult?.draft ?? draft,
              diagnostics: prepared.diagnostics,
              outcome: prepared.outcome,
              accounting: prepared.accounting,
              appliedMutationIds: applyResult?.appliedMutationIds ?? [],
              skippedMutationIds: applyResult?.skippedMutationIds ?? [],
            });
          } catch (err) {
            const cancelled = signal.aborted || isImportAbortError(err);
            const message = err instanceof Error ? err.message : "Failed to finalize imported source";
            await recordLtmDebugEvent({
              operationId,
              phase: "draft",
              action: "imported_source_finalize",
              status: cancelled ? "warning" : "error",
              source: imported.source,
              sourceId: item.sourceId,
              sourceNoteId: item.note.id,
              error: err,
            });
            results.push({
              sourceId: item.sourceId,
              title: item.title,
              note: item.note,
              created: item.created,
              sourceWriteStatus: item.created ? ("created" as const) : ("refreshed" as const),
              extractionStatus: cancelled ? ("cancelled" as const) : ("failed" as const),
              extractionMethod: prepared.extractionMethod,
              retryable: true,
              error: { code: cancelled ? "cancelled" : "finalize_failed", message },
              draft: null,
              diagnostics: [
                ...prepared.diagnostics,
                {
                  severity: cancelled ? ("warning" as const) : ("error" as const),
                  code: cancelled ? "cancelled" : "finalize_failed",
                  message,
                },
              ],
              outcome: prepared.outcome,
              accounting: prepared.accounting,
              appliedMutationIds: [],
              skippedMutationIds: [],
            });
          }
        }

        const totalApplied = results.reduce((sum, result) => sum + result.appliedMutationIds.length, 0);
        if (importedSourceNoteCount > 0) {
          const rebuildScope = totalApplied > 0 ? "all" : "source";
          const rebuildResult = await rebuildLongTermMemoryIndexes({ scope: rebuildScope });
          await recordLtmDebugEvent({
            root: undefined,
            operationId,
            phase: "rebuild",
            action: "import_batch_rebuild",
            status: "ok",
            counts: {
              sourceNotes: importedSourceNoteCount,
              appliedMutations: totalApplied,
              notes: rebuildResult.noteCount,
              chunks: rebuildResult.chunkCount,
              sourceChunks: rebuildResult.sourceChunkCount,
            },
            details: { scope: rebuildScope },
          });
        }

        const succeeded = results.filter((result) => result.extractionStatus === "succeeded").length;
        const failed = results.filter((result) => result.extractionStatus === "failed").length;
        const cancelled = results.filter((result) => result.extractionStatus === "cancelled").length;
        const incomplete = failed + cancelled + plan.missingSourceIds.length + imported.writeFailures.length;
        const batchStatus =
          incomplete === 0
            ? "success"
            : succeeded > 0
              ? "partial_success"
              : cancelled > 0 &&
                  failed === 0 &&
                  plan.missingSourceIds.length === 0 &&
                  imported.writeFailures.length === 0
                ? "cancelled"
                : "failed";
        return ltmImportSourceNotesResponseSchema.parse({
          operationId,
          batchStatus,
          source: imported.source,
          imported: results,
          writeFailures: imported.writeFailures,
          missingSourceIds: plan.missingSourceIds,
          counts: {
            requested: body.sourceIds.length,
            sourceNotesWritten: importedSourceNoteCount,
            succeeded,
            failed,
            cancelled,
            missing: plan.missingSourceIds.length,
            sourceWriteFailed: imported.writeFailures.length,
          },
        });
      });
    },
  );

  app.post<{ Body: unknown }>("/search", { bodyLimit: SEARCH_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory search" })) return;
    const body = searchBodySchema.parse(req.body);
    const result = await retrieveLongTermMemory(body);
    return {
      ...result,
      warnings: result.warnings.map(sanitizeStorageText),
    };
  });

  app.get<{ Querystring: unknown }>("/drafts", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft list" })) return;
    const query = listDraftsQuerySchema.parse(req.query);
    return draftStore.listDrafts(query);
  });

  app.get<{ Querystring: unknown }>("/drafts/pending-count", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory pending draft count" })) return;
    const query = listDraftsQuerySchema.parse(req.query);
    const drafts = await draftStore.listDrafts({ status: "pending", chatId: query.chatId });
    return { count: drafts.length };
  });

  app.get<{ Querystring: unknown }>("/drafts/review", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft review" })) return;
    const query = draftReviewQuerySchema.parse(req.query);
    return ltmDraftReviewResponseSchema.parse(
      await projectLongTermMemoryDraftReview({
        sourceNoteId: query.sourceNoteId,
        chatId: query.chatId,
        status: query.status,
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/drafts/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft detail" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const draft = await draftStore.getDraft(id);
    if (!draft) return reply.status(404).send({ error: "Long-term memory draft not found" });
    return draft;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/drafts/:id/accept", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft acceptance" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const body = acceptDraftBodySchema.parse(req.body ?? {});
    try {
      return await applyLongTermMemoryDraft(id, {
        actor: "maintenance_api",
        mutationIds: body.mutationIds,
        editedMutations: body.editedMutations,
        autoApplyLowRiskOnly: body.lowRiskOnly,
        operationId: randomUUID(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply long-term memory draft";
      const status =
        err instanceof LtmDraftApplyError
          ? err.statusCode
          : err instanceof LtmDraftProjectionError
            ? 409
            : message.includes("not found")
              ? 404
              : message.includes("not pending")
                ? 409
                : 400;
      const code =
        err instanceof LtmDraftApplyError
          ? err.code
          : err instanceof LtmDraftProjectionError
            ? err.code
            : "ltm_draft_apply_failed";
      return reply.status(status).send({ error: message, code });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/drafts/:id/skip", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft mutation deletion" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const body = skipDraftBodySchema.parse(req.body ?? {});
    const result = await draftStore.withDraftLock(id, () => draftStore.deleteDraftMutations(id, body.mutationIds));
    if (!result.deleted) {
      const status = result.reason === "not_pending" ? 409 : 404;
      const error =
        result.reason === "not_pending"
          ? "Long-term memory draft mutation can only be removed from pending drafts"
          : "Long-term memory draft mutation not found";
      return reply.status(status).send({ error });
    }
    return { deleted: true, draftId: id, mutationIds: body.mutationIds, draft: result.draft };
  });

  app.delete<{ Params: { id: string; mutationId: string } }>(
    "/drafts/:id/mutations/:mutationId",
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft mutation deletion" })) return;
      const { id, mutationId } = draftMutationParamSchema.parse(req.params);
      const result = await draftStore.withDraftLock(id, () => draftStore.deleteDraftMutation(id, mutationId));
      if (!result.deleted) {
        const status = result.reason === "not_pending" ? 409 : 404;
        const error =
          result.reason === "not_pending"
            ? "Long-term memory draft mutation can only be removed from pending drafts"
            : "Long-term memory draft mutation not found";
        return reply.status(status).send({ error });
      }
      return { deleted: true, draftId: id, mutationId, draft: result.draft };
    },
  );

  app.delete<{ Params: { id: string } }>("/drafts/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft deletion" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const deleted = await draftStore.withDraftLock(id, () => draftStore.deleteDraft(id));
    if (!deleted) return reply.status(404).send({ error: "Long-term memory draft not found" });
    return { deleted: true, id };
  });
}
