// ──────────────────────────────────────────────
// Routes: Long-Term Memory Maintenance
// ──────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  LOCAL_SIDECAR_CONNECTION_ID,
  ltmConflictSchema,
  ltmDraftSourceSchema,
  ltmDraftStatusSchema,
  ltmDebugPhaseSchema,
  ltmDebugStatusSchema,
  ltmExtractionSettingsSchema,
  ltmExtractionDraftSchema,
  ltmExtractionResponseSchema,
  ltmGateSchema,
  ltmIndexMetadataSchema,
  ltmIsoTimestampSchema,
  ltmLinkSchema,
  ltmModeSchema,
  ltmNoteIdSchema,
  ltmNoteTypeSchema,
  ltmScopeSchema,
  ltmSectionKeySchema,
  ltmSectionSchema,
  ltmStatusSchema,
  withMergedLtmScopeLinks,
  type LtmIndexMetadata,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import { z } from "zod";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";
import { createLLMProvider } from "../services/llm/provider-registry.js";
import { getLocalSidecarProvider, LOCAL_SIDECAR_MODEL } from "../services/llm/local-sidecar.js";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { resolveBaseUrl } from "./generate/generate-route-utils.js";
import {
  getLongTermMemoryDirectories,
  getLongTermMemoryRoot,
  LTM_DIR_NAME,
  safeJoin,
} from "../services/long-term-memory/paths.js";
import {
  clearLtmDebugLog,
  exportLtmDebugLog,
  readLtmDebugLog,
  recordLtmDebugEvent,
} from "../services/long-term-memory/debug-log.js";
import { LongTermMemoryDraftStore } from "../services/long-term-memory/extraction.js";
import {
  auditLongTermMemoryReplay,
  checkLongTermMemoryIntegrity,
  createLongTermMemoryInteropDrafts,
  createLongTermMemoryInteropSourceNotes,
  previewLongTermMemoryInterop,
  repairLongTermMemory,
  type LtmInteropSource,
  type LtmRepairAction,
} from "../services/long-term-memory/maintenance.js";
import { rebuildLongTermMemoryIndexes, type LtmEmbeddingIndex } from "../services/long-term-memory/rebuild.js";
import { applyLongTermMemoryDraft, rejectLongTermMemoryDraft } from "../services/long-term-memory/reconciliation.js";
import { retrieveLongTermMemory } from "../services/long-term-memory/retrieval.js";
import {
  extractLongTermMemoryFromSourceNote,
  isLtmSourceNote,
} from "../services/long-term-memory/source-extraction.js";
import { getLtmExtractionConfig, updateLtmExtractionConfig } from "../services/long-term-memory/extraction-config.js";
import { LongTermMemoryStorage } from "../services/long-term-memory/storage.js";
import { applyLtmScopeLinksToDerivedNotes } from "../services/long-term-memory/scope-links.js";

const NOTE_BODY_LIMIT_BYTES = 512 * 1024;
const DRAFT_BODY_LIMIT_BYTES = 512 * 1024;
const SEARCH_BODY_LIMIT_BYTES = 128 * 1024;
const REBUILD_BODY_LIMIT_BYTES = 8 * 1024;
const MAINTENANCE_BODY_LIMIT_BYTES = 32 * 1024;

const ltmIdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "Identifier must be lowercase snake_case.");

const listNotesQuerySchema = z
  .object({
    type: ltmNoteTypeSchema.optional(),
    status: ltmStatusSchema.optional(),
    tag: ltmIdentifierSchema.optional(),
  })
  .strict();

const createNoteBodySchema = z
  .object({
    id: ltmNoteIdSchema,
    type: ltmNoteTypeSchema,
    status: ltmStatusSchema,
    modes: z.array(ltmModeSchema).min(1).max(8),
    scope: ltmScopeSchema.default({}),
    tags: z.array(ltmIdentifierSchema).max(100).default([]),
    createdAt: ltmIsoTimestampSchema.optional(),
    updatedAt: ltmIsoTimestampSchema.optional(),
    links: z.array(ltmLinkSchema).max(250).default([]),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
    version: z.number().int().min(1).optional(),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

const updateNoteBodySchema = z
  .object({
    status: ltmStatusSchema.optional(),
    modes: z.array(ltmModeSchema).min(1).max(8).optional(),
    scope: ltmScopeSchema.optional(),
    tags: z.array(ltmIdentifierSchema).max(100).optional(),
    links: z.array(ltmLinkSchema).max(250).optional(),
    sections: z.record(ltmSectionKeySchema, ltmSectionSchema).optional(),
    conflicts: z.array(ltmConflictSchema).max(250).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch body must include at least one updatable field.");

const rebuildBodySchema = z.object({}).strict().default({});

const repairActionSchema = z.enum(["rebuild_indexes", "quarantine_malformed_notes"]);

const repairBodySchema = z
  .object({
    actions: z.array(repairActionSchema).min(1).max(2),
  })
  .strict();

const interopSourceSchema = z.enum(["characters", "lorebooks", "chats"]);

const interopBodySchema = z
  .object({
    source: interopSourceSchema,
    limit: z.number().int().min(1).max(100).default(25),
    scope: ltmScopeSchema.optional(),
  })
  .strict();

const interopImportBodySchema = z
  .object({
    source: interopSourceSchema,
    sourceIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    limit: z.number().int().min(1).max(100).default(25),
    scope: ltmScopeSchema.optional(),
    connectionId: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(240).optional(),
    instruction: z.string().max(2_000).optional(),
    applyLowRisk: z.boolean().optional(),
    includeExistingNotes: z.boolean().optional(),
  })
  .strict();

const draftIdParamSchema = z.object({ id: z.string().uuid() }).strict();
const noteIdParamSchema = z.object({ id: ltmNoteIdSchema }).strict();

const listDraftsQuerySchema = z
  .object({
    status: ltmDraftStatusSchema.optional(),
    chatId: z.string().min(1).max(120).optional(),
  })
  .strict();

const createDraftBodySchema = z
  .object({
    source: ltmDraftSourceSchema.default({}),
    scope: ltmScopeSchema.default({}),
    modes: z.array(ltmModeSchema).min(1).max(8),
    summary: z.string().max(2_000).optional(),
    response: ltmExtractionResponseSchema,
  })
  .strict();

const rejectDraftBodySchema = z
  .object({
    reason: z.string().max(1_000).optional(),
  })
  .strict()
  .default({});

const acceptDraftBodySchema = z
  .object({
    mutationIds: z.array(z.string().uuid()).min(1).max(25).optional(),
    lowRiskOnly: z.boolean().optional(),
  })
  .strict()
  .default({});

const updateDraftBodySchema = ltmExtractionDraftSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch body must include at least one updatable field.");

const extractSourceNoteBodySchema = z
  .object({
    chatId: z.string().min(1).max(120).optional(),
    connectionId: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(240).optional(),
    instruction: z.string().max(2_000).optional(),
    applyLowRisk: z.boolean().optional(),
    includeExistingNotes: z.boolean().optional(),
  })
  .strict()
  .default({});

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
    mentionedCharacterNames: z.array(z.string().min(1).max(120)).max(100).optional(),
    noteIds: z.array(ltmNoteIdSchema).max(100).optional(),
    tags: z.array(ltmIdentifierSchema).max(100).optional(),
    scope: ltmScopeSchema.optional(),
    characterIds: z.array(z.string().min(1).max(120)).max(100).optional(),
    includeGates: z.array(ltmGateSchema).max(8).optional(),
    includeArchived: z.boolean().optional(),
    includeResolved: z.boolean().optional(),
    includeSourceNotes: z.boolean().optional(),
    debug: z.boolean().optional(),
    maxChunks: z.number().int().min(1).max(100).optional(),
    maxTokens: z.number().int().min(128).max(16_384).optional(),
    minScore: z.number().finite().min(0).max(1).optional(),
    semanticWeight: z.number().finite().min(0).max(1).optional(),
    lexicalWeight: z.number().finite().min(0).max(1).optional(),
    graphWeight: z.number().finite().min(0).max(1).optional(),
    alwaysWeight: z.number().finite().min(0).max(2).optional(),
    metadataWeight: z.number().finite().min(0).max(2).optional(),
    typedPriorityWeight: z.number().finite().min(0).max(2).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.queryText?.trim() ||
        value.recentUserMessage?.trim() ||
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

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

async function readOptionalJson<T>(index: string, path: string, parse: (value: unknown) => T) {
  try {
    return { value: parse(JSON.parse(await readFile(path, "utf8"))), error: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { value: null, error: null };
    return { value: null, error: { index, code: "index_unavailable" } };
  }
}

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

function normalizeCharacterIds(value: unknown) {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function normalizeLtmIdentifier(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) ? value : null;
}

function ltmModeForChatMode(mode: unknown): LtmMode {
  return ltmModeSchema.catch("roleplay").parse(mode);
}

function resolveChatLtmScope(chat: {
  id: string;
  groupId?: string | null;
  characterIds?: unknown;
  metadata?: unknown;
}) {
  const meta = parseMetadata(chat.metadata);
  const configuredScope =
    meta.longTermMemoryScope && typeof meta.longTermMemoryScope === "object" && !Array.isArray(meta.longTermMemoryScope)
      ? (meta.longTermMemoryScope as Record<string, unknown>)
      : {};
  const universe = normalizeLtmIdentifier(configuredScope.universe);
  const rpId = normalizeLtmIdentifier(configuredScope.rpId);
  const characterIds = normalizeCharacterIds(chat.characterIds);
  return withMergedLtmScopeLinks(
    {
      chatId: chat.id,
      ...(chat.groupId ? { groupId: chat.groupId } : {}),
      ...(characterIds.length ? { characterIds } : {}),
      ...(universe ? { universe } : {}),
      ...(rpId ? { rpId } : {}),
    },
    { chatIds: [chat.id] },
  ) satisfies LtmScope;
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

class LtmExtractionRouteError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function longTermMemoryRoutes(app: FastifyInstance) {
  const storage = new LongTermMemoryStorage();
  const draftStore = new LongTermMemoryDraftStore();
  const chats = createChatsStorage(app.db);
  const connections = createConnectionsStorage(app.db);

  async function resolveExtractionProvider(
    body: z.infer<typeof extractSourceNoteBodySchema>,
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
        model: body.model ?? LOCAL_SIDECAR_MODEL,
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
      model: body.model ?? conn.model,
    };
  }

  app.get("/status", async () => {
    await storage.initializeLtmStore();
    const notes = await storage.listNotes();
    const dirs = getLongTermMemoryDirectories(storage.root);
    const events = await getEventLogStatus(dirs.eventLog);
    const manifestStatus = await readOptionalJson<LtmIndexMetadata>(
      "manifest",
      safeJoin(dirs.indexes, "manifest.json"),
      (value) => ltmIndexMetadataSchema.parse(value),
    );
    const embeddingsStatus = await readOptionalJson<LtmEmbeddingIndex>(
      "embeddings",
      safeJoin(dirs.indexes, "embeddings.json"),
      (value) => value as LtmEmbeddingIndex,
    );
    const manifest = manifestStatus.value;
    const embeddings = embeddingsStatus.value;

    return {
      initialized: true,
      directory: LTM_DIR_NAME,
      notes: summarizeNotes(notes),
      events,
      indexes: {
        manifestAvailable: Boolean(manifest),
        errors: [manifestStatus.error, embeddingsStatus.error].filter((error): error is NonNullable<typeof error> =>
          Boolean(error),
        ),
        generatedAt: manifest?.generatedAt ?? null,
        sourceHash: manifest?.sourceHash ?? null,
        noteCount: manifest?.noteCount ?? null,
        chunkCount: manifest?.chunkCount ?? null,
        embeddingsAvailable: Boolean(embeddings?.embeddedChunkCount),
        embeddedChunkCount: embeddings?.embeddedChunkCount ?? 0,
      },
    };
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

  app.get<{ Querystring: unknown }>("/notes", async (req) => {
    const query = listNotesQuerySchema.parse(req.query);
    return storage.listNotes(query);
  });

  app.get<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    const id = ltmNoteIdSchema.parse(req.params.id);
    const note = await storage.getNote(id);
    if (!note) return reply.status(404).send({ error: "Long-term memory note not found" });
    return note;
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/notes/:id/extract",
    { bodyLimit: DRAFT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory source extraction" })) return;
      const { id } = noteIdParamSchema.parse(req.params);
      const body = extractSourceNoteBodySchema.parse(req.body ?? {});
      const sourceNote = await storage.getNote(id);
      if (!sourceNote) return reply.status(404).send({ error: "Long-term memory note not found" });
      if (!isLtmSourceNote(sourceNote)) {
        return reply.status(400).send({ error: "Long-term memory note is not a source note" });
      }

      const chat = body.chatId ? await chats.getById(body.chatId) : null;
      if (body.chatId && !chat) return reply.status(404).send({ error: "Chat not found" });

      const operationId = randomUUID();
      try {
        const { provider, model } = await resolveExtractionProvider(body, chat?.connectionId ?? null);
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
          scope: chat ? resolveChatLtmScope(chat) : sourceNote.scope,
          modes: chat ? [ltmModeForChatMode(chat.mode)] : sourceNote.modes,
          instruction: body.instruction,
          includeExistingNotes: body.includeExistingNotes,
          operationId,
        });
        const applyResult =
          body.applyLowRisk && result.draft
            ? await applyLongTermMemoryDraft(result.draft.id, {
                actor: "maintenance_api",
                autoApplyLowRiskOnly: true,
                autoApplyPolicy: "source_extraction",
                operationId,
              })
            : null;

        return {
          draft: applyResult?.draft ?? result.draft,
          diagnostics: result.diagnostics,
          response: result.response,
          appliedMutationIds: applyResult?.appliedMutationIds ?? [],
          skippedMutationIds: applyResult?.skippedMutationIds ?? [],
        };
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

      return storage.updateNote(id, patch, {
        actor: "maintenance_api",
        cause: "api.patch",
        summary: "Updated via long-term memory maintenance API",
      });
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
    return { archived: true, note: archivedNotes[0], notes: archivedNotes };
  });

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
    return { deleted: true, id: note.id };
  });

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

  app.get("/integrity", async () => checkLongTermMemoryIntegrity());

  app.post("/replay", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory replay audit" })) return;
    rebuildBodySchema.parse(req.body ?? {});
    return auditLongTermMemoryReplay();
  });

  app.post<{ Body: unknown }>("/repair", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory repair" })) return;
    const body = repairBodySchema.parse(req.body);
    return repairLongTermMemory(body.actions as LtmRepairAction[]);
  });

  app.post<{ Body: unknown }>("/import/preview", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req) => {
    const body = interopBodySchema.parse(req.body);
    return previewLongTermMemoryInterop(app.db, body.source as LtmInteropSource, body.limit);
  });

  app.post<{ Body: unknown }>("/import/drafts", { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory import draft creation" })) return;
    const body = interopBodySchema.parse(req.body);
    return createLongTermMemoryInteropDrafts(app.db, body.source as LtmInteropSource, {
      limit: body.limit,
      scope: body.scope,
    });
  });

  app.post<{ Body: unknown }>(
    "/import/source-notes",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory source import" })) return;
      const body = interopImportBodySchema.parse(req.body);
      const operationId = randomUUID();
      const imported = await createLongTermMemoryInteropSourceNotes(app.db, body.source as LtmInteropSource, {
        sourceIds: body.sourceIds,
        limit: body.limit,
        scope: body.scope,
        operationId,
      });
      const results = [];

      for (const item of imported.imported) {
        try {
          const { provider, model } = await resolveExtractionProvider(body);
          await recordLtmDebugEvent({
            operationId,
            phase: "extraction",
            action: "provider_resolved",
            status: "ok",
            source: imported.source,
            sourceId: item.sourceId,
            sourceNoteId: item.note.id,
            provider: provider.constructor.name,
            model,
          });
          const result = await extractLongTermMemoryFromSourceNote({
            noteId: item.note.id,
            provider,
            model,
            scope: item.note.scope,
            modes: item.note.modes,
            instruction: body.instruction,
            includeExistingNotes: body.includeExistingNotes,
            operationId,
          });
          const applyResult =
            body.applyLowRisk && result.draft
              ? await applyLongTermMemoryDraft(result.draft.id, {
                  actor: "maintenance_api",
                  autoApplyLowRiskOnly: true,
                  autoApplyPolicy: "source_extraction",
                  operationId,
                })
              : null;

          results.push({
            sourceId: item.sourceId,
            title: item.title,
            note: item.note,
            created: item.created,
            draft: applyResult?.draft ?? result.draft,
            diagnostics: result.diagnostics,
            appliedMutationIds: applyResult?.appliedMutationIds ?? [],
            skippedMutationIds: applyResult?.skippedMutationIds ?? [],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to extract imported source";
          await recordLtmDebugEvent({
            operationId,
            phase: "extraction",
            action: "imported_source_extract",
            status: "error",
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
            draft: null,
            diagnostics: [{ severity: "error", code: "extract_failed", message }],
            appliedMutationIds: [],
            skippedMutationIds: [],
          });
        }
      }

      return {
        source: imported.source,
        imported: results,
        missingSourceIds: body.sourceIds.filter(
          (sourceId) => !imported.imported.some((item) => item.sourceId === sourceId),
        ),
      };
    },
  );

  app.post<{ Body: unknown }>("/search", { bodyLimit: SEARCH_BODY_LIMIT_BYTES }, async (req) => {
    const body = searchBodySchema.parse(req.body);
    const result = await retrieveLongTermMemory(body);
    return {
      ...result,
      warnings: result.warnings.map(sanitizeStorageText),
    };
  });

  app.get<{ Querystring: unknown }>("/drafts", async (req) => {
    const query = listDraftsQuerySchema.parse(req.query);
    return draftStore.listDrafts(query);
  });

  app.get<{ Params: { id: string } }>("/drafts/:id", async (req, reply) => {
    const { id } = draftIdParamSchema.parse(req.params);
    const draft = await draftStore.getDraft(id);
    if (!draft) return reply.status(404).send({ error: "Long-term memory draft not found" });
    return draft;
  });

  app.post<{ Body: unknown }>("/drafts", { bodyLimit: DRAFT_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft creation" })) return;
    const body = createDraftBodySchema.parse(req.body);
    const draft = await draftStore.createDraft({
      source: body.source,
      scope: body.scope,
      modes: body.modes,
      summary: body.summary,
      response: body.response,
      userMessage: "",
      assistantReply: "",
    });
    return reply.status(201).send(draft);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/drafts/:id",
    { bodyLimit: DRAFT_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft update" })) return;
      const { id } = draftIdParamSchema.parse(req.params);
      const patch = updateDraftBodySchema.parse(req.body);
      try {
        const draft = await draftStore.updateDraft(id, patch);
        if (!draft) return reply.status(404).send({ error: "Long-term memory draft not found" });
        return draft;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update long-term memory draft";
        return reply.status(message.includes("cannot be restored") ? 409 : 400).send({ error: message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/drafts/:id/accept", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft acceptance" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const body = acceptDraftBodySchema.parse(req.body ?? {});
    try {
      return await applyLongTermMemoryDraft(id, {
        actor: "maintenance_api",
        mutationIds: body.mutationIds,
        autoApplyLowRiskOnly: body.lowRiskOnly,
        operationId: randomUUID(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply long-term memory draft";
      const status = message.includes("not found") ? 404 : message.includes("not pending") ? 409 : 400;
      return reply.status(status).send({ error: message });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/drafts/:id/reject",
    { bodyLimit: REBUILD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft rejection" })) return;
      const { id } = draftIdParamSchema.parse(req.params);
      const body = rejectDraftBodySchema.parse(req.body ?? {});
      try {
        return await rejectLongTermMemoryDraft(id, { reason: body.reason, operationId: randomUUID() });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to reject long-term memory draft";
        const status = message.includes("not found") ? 404 : message.includes("not pending") ? 409 : 400;
        return reply.status(status).send({ error: message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/drafts/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft deletion" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    const deleted = await draftStore.deleteDraft(id);
    if (!deleted) return reply.status(404).send({ error: "Long-term memory draft not found" });
    return { deleted: true, id };
  });
}
