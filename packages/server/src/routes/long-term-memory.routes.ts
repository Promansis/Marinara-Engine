// ──────────────────────────────────────────────
// Routes: Long-Term Memory Maintenance
// ──────────────────────────────────────────────
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  ltmConflictSchema,
  ltmDraftStatusSchema,
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
  type LtmIndexMetadata,
  type LtmNote,
} from "@marinara-engine/shared";
import { z } from "zod";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";
import {
  getLongTermMemoryDirectories,
  getLongTermMemoryRoot,
  LTM_DIR_NAME,
  safeJoin,
} from "../services/long-term-memory/paths.js";
import { LongTermMemoryDraftStore } from "../services/long-term-memory/extraction.js";
import {
  auditLongTermMemoryReplay,
  checkLongTermMemoryIntegrity,
  createLongTermMemoryInteropDrafts,
  previewLongTermMemoryInterop,
  repairLongTermMemory,
  type LtmInteropSource,
  type LtmRepairAction,
} from "../services/long-term-memory/maintenance.js";
import { rebuildLongTermMemoryIndexes, type LtmEmbeddingIndex } from "../services/long-term-memory/rebuild.js";
import { applyLongTermMemoryDraft, rejectLongTermMemoryDraft } from "../services/long-term-memory/reconciliation.js";
import { retrieveLongTermMemory } from "../services/long-term-memory/retrieval.js";
import { LongTermMemoryStorage } from "../services/long-term-memory/storage.js";

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
    previousHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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

const draftIdParamSchema = z.object({ id: z.string().uuid() }).strict();

const listDraftsQuerySchema = z
  .object({
    status: ltmDraftStatusSchema.optional(),
    chatId: z.string().min(1).max(120).optional(),
  })
  .strict();

const createDraftBodySchema = z
  .object({
    source: z
      .object({
        chatId: z.string().min(1).max(120).optional(),
        userMessageId: z.string().min(1).max(120).optional(),
        assistantMessageId: z.string().min(1).max(120).optional(),
        turn: z.number().int().min(0).optional(),
      })
      .strict()
      .default({}),
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
    maxChunks: z.number().int().min(1).max(100).optional(),
    maxTokens: z.number().int().min(128).max(16_384).optional(),
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

function publicRebuildResult(result: Awaited<ReturnType<typeof rebuildLongTermMemoryIndexes>>) {
  return {
    generatedAt: result.generatedAt,
    noteCount: result.noteCount,
    chunkCount: result.chunkCount,
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

export async function longTermMemoryRoutes(app: FastifyInstance) {
  const storage = new LongTermMemoryStorage();
  const draftStore = new LongTermMemoryDraftStore();

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

  app.post<{ Body: unknown }>(
    "/notes",
    { bodyLimit: NOTE_BODY_LIMIT_BYTES },
    async (req, reply) => {
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
    },
  );

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

  app.delete<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory note archival" })) return;
    const id = ltmNoteIdSchema.parse(req.params.id);
    const existing = await storage.getNote(id);
    if (!existing) return reply.status(404).send({ error: "Long-term memory note not found" });

    const note = await storage.archiveNote(id, {
      actor: "maintenance_api",
      cause: "api.archive",
      summary: "Archived via long-term memory maintenance API",
    });
    return { archived: true, note };
  });

  app.post<{ Body: unknown }>(
    "/rebuild",
    { bodyLimit: REBUILD_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory index rebuild" })) return;
      rebuildBodySchema.parse(req.body ?? {});
      const result = await rebuildLongTermMemoryIndexes();
      return publicRebuildResult(result);
    },
  );

  app.get("/integrity", async () => checkLongTermMemoryIntegrity());

  app.post(
    "/replay",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory replay audit" })) return;
      rebuildBodySchema.parse(req.body ?? {});
      return auditLongTermMemoryReplay();
    },
  );

  app.post<{ Body: unknown }>(
    "/repair",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory repair" })) return;
      const body = repairBodySchema.parse(req.body);
      return repairLongTermMemory(body.actions as LtmRepairAction[]);
    },
  );

  app.post<{ Body: unknown }>(
    "/import/preview",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req) => {
      const body = interopBodySchema.parse(req.body);
      return previewLongTermMemoryInterop(app.db, body.source as LtmInteropSource, body.limit);
    },
  );

  app.post<{ Body: unknown }>(
    "/import/drafts",
    { bodyLimit: MAINTENANCE_BODY_LIMIT_BYTES },
    async (req, reply) => {
      if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory import draft creation" })) return;
      const body = interopBodySchema.parse(req.body);
      return createLongTermMemoryInteropDrafts(app.db, body.source as LtmInteropSource, {
        limit: body.limit,
        scope: body.scope,
      });
    },
  );

  app.post<{ Body: unknown }>(
    "/search",
    { bodyLimit: SEARCH_BODY_LIMIT_BYTES },
    async (req) => {
      const body = searchBodySchema.parse(req.body);
      const result = await retrieveLongTermMemory(body);
      return {
        ...result,
        warnings: result.warnings.map(sanitizeStorageText),
      };
    },
  );

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

  app.post<{ Body: unknown }>(
    "/drafts",
    { bodyLimit: DRAFT_BODY_LIMIT_BYTES },
    async (req, reply) => {
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
    },
  );

  app.post<{ Params: { id: string } }>("/drafts/:id/accept", async (req, reply) => {
    if (!requirePrivilegedAccess(req, reply, { feature: "Long-term memory draft acceptance" })) return;
    const { id } = draftIdParamSchema.parse(req.params);
    try {
      return await applyLongTermMemoryDraft(id, { actor: "maintenance_api" });
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
        return await rejectLongTermMemoryDraft(id, { reason: body.reason });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to reject long-term memory draft";
        const status = message.includes("not found") ? 404 : message.includes("not pending") ? 409 : 400;
        return reply.status(status).send({ error: message });
      }
    },
  );
}
