import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  ltmExtractionResponseSchema,
  ltmEventSchema,
  ltmNoteSchema,
  withMergedLtmScopeLinks,
  type LtmDraftMutation,
  type LtmExtractionDraft,
  type LtmMode,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { LongTermMemoryDraftStore } from "./extraction.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import {
  getLongTermMemoryDirectories,
  getLongTermMemoryRoot,
  LTM_VAULT_FOLDERS,
  notePathForId,
  safeJoin,
  vaultFolderForNoteType,
} from "./paths.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryStorage } from "./storage.js";
import { writeJsonAtomic } from "./atomic-json.js";

type IntegritySeverity = "info" | "warning" | "error";
type IntegrityIssue = {
  severity: IntegritySeverity;
  code: string;
  path?: string;
  noteId?: string;
  message: string;
};

export type LtmRepairAction = "rebuild_indexes" | "quarantine_malformed_notes";
export type LtmInteropSource = "characters" | "lorebooks" | "chats";

type DraftSeed = {
  title: string;
  sourceId: string;
  sourceText: string;
  sourceNoteId: string;
  sourceTag: string;
  evidence: string[];
  source?: LtmExtractionDraft["source"];
  scope?: LtmScope;
  modes: LtmMode[];
  response: Parameters<LongTermMemoryDraftStore["createDraft"]>[0]["response"];
};

export interface LtmIntegrityResult {
  ok: boolean;
  checkedAt: string;
  noteCount: number;
  eventCount: number;
  issues: IntegrityIssue[];
}

export interface LtmReplayAuditResult {
  replayable: boolean;
  checkedAt: string;
  replayRoot: string;
  eventCount: number;
  unsupportedEventCount: number;
  replayedEventCount: number;
  driftCount: number | null;
  messages: string[];
}

export interface LtmRepairResult {
  repairedAt: string;
  actions: Array<{ action: LtmRepairAction; result: string; count?: number }>;
  integrity: LtmIntegrityResult;
}

export interface LtmInteropPreview {
  source: LtmInteropSource;
  scanned: number;
  draftable: number;
  samples: Array<{ sourceId: string; title: string; mutationCount: number; summary: string }>;
}

export interface LtmInteropSourceNoteImport {
  sourceId: string;
  title: string;
  note: LtmNote;
  created: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 72);
  return normalized || fallback;
}

function hashShort(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function textSection(text: string, evidence: string[]) {
  return {
    text: text.trim().slice(0, 20_000),
    updatedAt: nowIso(),
    confidence: 0.8,
    evidence,
  };
}

function readJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function compactLines(lines: Array<[string, unknown]>) {
  return lines
    .map(([label, value]) => {
      const text = typeof value === "string" ? value.trim() : "";
      return text ? `${label}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function mutationBase(summary: string, evidence: string[], risk: LtmDraftMutation["risk"] = "medium") {
  return {
    id: randomUUID(),
    risk,
    confidence: 0.8,
    summary,
    evidence,
  };
}

function makeDraftResponse(mutations: LtmDraftMutation[], summary: string) {
  return ltmExtractionResponseSchema.parse({ summary, mutations });
}

async function listVaultFiles(root: string) {
  const dirs = getLongTermMemoryDirectories(root);
  const files: Array<{ folder: (typeof LTM_VAULT_FOLDERS)[number]; path: string }> = [];
  for (const folder of LTM_VAULT_FOLDERS) {
    const folderPath = safeJoin(dirs.vault, folder);
    const entries = await readdir(folderPath, { withFileTypes: true }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json"))
        files.push({ folder, path: safeJoin(folderPath, entry.name) });
    }
  }
  return files;
}

async function checkEventLogIntegrity(root: string, issues: IntegrityIssue[]) {
  const dirs = getLongTermMemoryDirectories(root);
  const publicPath = relative(root, dirs.eventLog)
    .split(/[\\/]+/)
    .join("/");
  let content = "";
  try {
    content = await readFile(dirs.eventLog, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    issues.push({
      severity: "error",
      code: "event_log_unreadable",
      path: publicPath,
      message: err instanceof Error ? err.message : "Event log could not be read.",
    });
    return 0;
  }

  let eventCount = 0;
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      ltmEventSchema.parse(JSON.parse(line));
      eventCount += 1;
    } catch (err) {
      issues.push({
        severity: "error",
        code: "malformed_event",
        path: publicPath,
        message:
          err instanceof Error ? `Line ${index + 1}: ${err.message}` : `Line ${index + 1}: Event failed validation.`,
      });
    }
  }
  return eventCount;
}

async function writeReplayNoteExact(root: string, note: LtmNote) {
  const parsed = ltmNoteSchema.parse(note);
  await writeJsonAtomic(notePathForId(parsed.id, parsed.type, root), parsed);
}

export async function checkLongTermMemoryIntegrity(root = getLongTermMemoryRoot()): Promise<LtmIntegrityResult> {
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  const issues: IntegrityIssue[] = [];
  const notesById = new Map<string, LtmNote>();

  for (const file of await listVaultFiles(root)) {
    const publicPath = relative(root, file.path)
      .split(/[\\/]+/)
      .join("/");
    try {
      const note = ltmNoteSchema.parse(JSON.parse(await readFile(file.path, "utf8")));
      notesById.set(note.id, note);
      if (vaultFolderForNoteType(note.type) !== file.folder) {
        issues.push({
          severity: "error",
          code: "folder_type_mismatch",
          path: publicPath,
          noteId: note.id,
          message: `Note type ${note.type} belongs in ${vaultFolderForNoteType(note.type)}.`,
        });
      }
      const expected = notePathForId(note.id, note.type, root);
      if (expected !== file.path) {
        issues.push({
          severity: "warning",
          code: "path_id_mismatch",
          path: publicPath,
          noteId: note.id,
          message: `Filename should be ${basename(expected)}.`,
        });
      }
      if (note.previousHash) {
        issues.push({
          severity: "info",
          code: "hash_chain_present",
          path: publicPath,
          noteId: note.id,
          message: "Note has a previous hash pointer.",
        });
      }
    } catch (err) {
      issues.push({
        severity: "error",
        code: "malformed_note",
        path: publicPath,
        message: err instanceof Error ? err.message : "Note failed validation.",
      });
    }
  }

  for (const note of notesById.values()) {
    for (const link of note.links) {
      if (!notesById.has(link.target)) {
        issues.push({
          severity: "warning",
          code: "missing_link_target",
          noteId: note.id,
          message: `Link target ${link.target} does not exist.`,
        });
      }
    }
  }

  const eventCount = await checkEventLogIntegrity(root, issues);
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    checkedAt: nowIso(),
    noteCount: notesById.size,
    eventCount,
    issues,
  };
}

export async function auditLongTermMemoryReplay(root = getLongTermMemoryRoot()): Promise<LtmReplayAuditResult> {
  return withLtmDebugOperation(
    {
      root,
      phase: "replay",
      action: "audit_replay",
      message: "Audit long-term memory replay log",
    },
    async (operationId) => {
      const storage = new LongTermMemoryStorage(root);
      const events = await storage.readEvents();
      const replayRoot = join(dirname(root), `${basename(root)}-replay-${Date.now()}`);
      const replayStorage = new LongTermMemoryStorage(replayRoot);
      try {
        await replayStorage.initializeLtmStore();
        const unsupported = [];
        let replayedEventCount = 0;

        for (const event of events) {
          const payload = event.payload ?? {};
          try {
            if (payload.note) {
              const note = ltmNoteSchema.parse(payload.note);
              if (event.type.endsWith(".created")) {
                await replayStorage.createNote(note, {
                  actor: "replay",
                  cause: event.id,
                  summary: event.summary,
                  payload: { sourceEventId: event.id },
                  suppressEvent: true,
                });
              } else {
                await writeReplayNoteExact(replayRoot, note);
              }
              replayedEventCount += 1;
              continue;
            }
            if (
              typeof event.target === "string" &&
              payload.patch &&
              typeof payload.patch === "object" &&
              !Array.isArray(payload.patch)
            ) {
              await replayStorage.updateNote(event.target, payload.patch, {
                actor: "replay",
                cause: event.id,
                summary: event.summary,
                payload: { sourceEventId: event.id },
                suppressEvent: true,
              });
              replayedEventCount += 1;
              continue;
            }
            unsupported.push(event);
          } catch {
            unsupported.push(event);
          }
        }

        const driftCount = unsupported.length === 0 ? await compareVaults(storage, replayStorage) : null;
        const result = {
          replayable: unsupported.length === 0,
          checkedAt: nowIso(),
          replayRoot: relative(dirname(root), replayRoot)
            .split(/[\\/]+/)
            .join("/"),
          eventCount: events.length,
          unsupportedEventCount: unsupported.length,
          replayedEventCount,
          driftCount,
          messages:
            unsupported.length > 0
              ? [
                  "Event log is mutation history, but existing events do not include enough note payload data for full vault replay.",
                  "Use integrity check plus rebuild for current recovery; future event writers should include note or patch payloads for deterministic replay.",
                ]
              : driftCount === 0
                ? ["Replay finished and matched the current vault."]
                : [`Replay finished with ${driftCount} note difference(s).`],
        };
        await recordLtmDebugEvent({
          root,
          operationId,
          phase: "replay",
          action: "audit_replay_result",
          status: result.replayable ? "ok" : "warning",
          counts: {
            events: result.eventCount,
            unsupportedEvents: result.unsupportedEventCount,
            replayedEvents: result.replayedEventCount,
            drift: result.driftCount ?? 0,
          },
          details: { messages: result.messages },
        });
        return result;
      } finally {
        await rm(replayRoot, { recursive: true, force: true });
      }
    },
  );
}

async function compareVaults(left: LongTermMemoryStorage, right: LongTermMemoryStorage) {
  const [leftNotes, rightNotes] = await Promise.all([left.listNotes(), right.listNotes()]);
  const rightById = new Map(rightNotes.map((note) => [note.id, stableNote(note)]));
  let drift = 0;
  for (const note of leftNotes) {
    if (stableNote(note) !== rightById.get(note.id)) drift += 1;
    rightById.delete(note.id);
  }
  return drift + rightById.size;
}

function stableNote(note: LtmNote) {
  return JSON.stringify(note);
}

export async function repairLongTermMemory(
  actions: LtmRepairAction[],
  root = getLongTermMemoryRoot(),
): Promise<LtmRepairResult> {
  return withLtmDebugOperation(
    {
      root,
      phase: "repair",
      action: "repair",
      message: "Repair long-term memory store",
      details: { actions },
    },
    async (operationId) => {
      const results: LtmRepairResult["actions"] = [];
      const dirs = getLongTermMemoryDirectories(root);

      for (const action of actions) {
        if (action === "rebuild_indexes") {
          const result = await rebuildLongTermMemoryIndexes({ root });
          results.push({ action, result: "rebuilt", count: result.chunkCount });
          await recordLtmDebugEvent({
            root,
            operationId,
            phase: "rebuild",
            action: "repair_rebuild_indexes",
            status: "ok",
            counts: { chunks: result.chunkCount, notes: result.noteCount },
          });
          continue;
        }

        const quarantineDir = join(dirs.root, "quarantine", `malformed-${Date.now()}`);
        let moved = 0;
        for (const file of await listVaultFiles(root)) {
          try {
            ltmNoteSchema.parse(JSON.parse(await readFile(file.path, "utf8")));
          } catch {
            await mkdir(join(quarantineDir, file.folder), { recursive: true });
            await rename(file.path, join(quarantineDir, file.folder, basename(file.path)));
            moved += 1;
          }
        }
        results.push({ action, result: moved > 0 ? "quarantined" : "no_malformed_notes", count: moved });
      }

      const result = {
        repairedAt: nowIso(),
        actions: results,
        integrity: await checkLongTermMemoryIntegrity(root),
      };
      await recordLtmDebugEvent({
        root,
        operationId,
        phase: "repair",
        action: "repair_result",
        status: result.integrity.ok ? "ok" : "warning",
        counts: {
          actions: results.length,
          issues: result.integrity.issues.length,
        },
        details: { actions: results },
      });
      return result;
    },
  );
}

async function characterDrafts(db: DB, limit: number, sourceIds?: Set<string>): Promise<DraftSeed[]> {
  const characters = await createCharactersStorage(db).list();
  const rows = sourceIds ? characters.filter((row) => sourceIds.has(row.id)) : characters.slice(0, limit);
  return rows.flatMap((row) => {
    const data = readJsonObject(row.data);
    const name = typeof data.name === "string" ? data.name : "Character";
    const body = compactLines([
      ["Description", data.description],
      ["Personality", data.personality],
      ["Scenario", data.scenario],
      ["First message", data.first_mes],
      ["Creator notes", row.comment],
    ]);
    if (!body) return [];
    const noteId = `char_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`;
    const sourceNoteId = `scene_import_character_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`;
    const evidence = [`character:${row.id}`];
    const mutation: LtmDraftMutation = {
      ...mutationBase(`Import character card for ${name}`, evidence),
      kind: "create_note",
      note: {
        id: noteId,
        type: "character",
        status: "active",
        modes: ["conversation", "roleplay", "game"],
        scope: { characterIds: [row.id] },
        tags: readJsonArray(data.tags)
          .map((tag) => normalizeIdentifier(tag, "tag"))
          .slice(0, 12),
        links: [],
        sections: { profile: textSection(body, evidence) },
      },
    };
    return [
      {
        title: name,
        sourceId: row.id,
        sourceText: body,
        sourceNoteId,
        sourceTag: "imported_character",
        evidence,
        modes: mutation.note.modes,
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${name}`),
      },
    ];
  });
}

async function lorebookDrafts(db: DB, limit: number, sourceIds?: Set<string>): Promise<DraftSeed[]> {
  const storage = createLorebooksStorage(db);
  const books = (await storage.list()) as Array<Record<string, unknown>>;
  const selectedBooks = sourceIds
    ? books.filter((book) => typeof book.id === "string" && sourceIds.has(book.id))
    : books.slice(0, limit);
  const drafts: DraftSeed[] = [];
  for (const book of selectedBooks) {
    const id = typeof book.id === "string" ? book.id : "";
    const name = typeof book.name === "string" && book.name.trim() ? book.name : "Lorebook";
    if (!id) continue;
    const entries = (await storage.listEntries(id)) as Array<Record<string, unknown>>;
    const description = typeof book.description === "string" ? book.description.trim() : "";
    const text = [
      description ? `Description: ${description}` : "",
      ...entries
        .filter((entry) => typeof entry.content === "string" && entry.content.trim())
        .slice(0, 8)
        .map((entry) => `${entry.name || "Entry"}: ${entry.content}`),
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!text) continue;
    const category = typeof book.category === "string" ? book.category : "";
    const type: LtmNoteType = category === "character" || category === "npc" ? "character" : "world";
    const prefix = type === "character" ? "char" : "world";
    const noteId = `${prefix}_${normalizeIdentifier(name, "lorebook")}_${hashShort(id)}`;
    const sourceNoteId = `scene_import_lorebook_${normalizeIdentifier(name, "lorebook")}_${hashShort(id)}`;
    const evidence = [`lorebook:${id}`];
    const modes: LtmMode[] = ["conversation", "roleplay", "game"];
    const mutation: LtmDraftMutation = {
      ...mutationBase(`Import lorebook ${name}`, evidence),
      kind: "create_note",
      note: {
        id: noteId,
        type,
        status: "active",
        modes,
        scope: withMergedLtmScopeLinks(
          {
            chatId: typeof book.chatId === "string" ? book.chatId : undefined,
            characterIds: Array.isArray(book.characterIds)
              ? book.characterIds.filter((value): value is string => typeof value === "string")
              : undefined,
          },
          { chatIds: typeof book.chatId === "string" ? [book.chatId] : [] },
        ),
        tags: Array.isArray(book.tags)
          ? book.tags.map((tag) => normalizeIdentifier(String(tag), "tag")).slice(0, 12)
          : [],
        links: [],
        sections: { lore: textSection(text, evidence) },
      },
    };
    drafts.push({
      title: name,
      sourceId: id,
      sourceText: text,
      sourceNoteId,
      sourceTag: "imported_lorebook",
      evidence,
      modes,
      scope: mutation.note.scope,
      response: makeDraftResponse([mutation], `Import ${name}`),
    });
  }
  return drafts;
}

async function chatDrafts(db: DB, limit: number, sourceIds?: Set<string>): Promise<DraftSeed[]> {
  const chats = await createChatsStorage(db).list();
  const rows = sourceIds ? chats.filter((chat) => sourceIds.has(chat.id)) : chats.slice(0, limit);
  return rows.flatMap((chat) => {
    const metadata = readJsonObject(chat.metadata);
    const summary = typeof metadata.summary === "string" ? metadata.summary.trim() : "";
    if (!summary) return [];
    const mode = chat.mode === "visual_novel" ? "visual_novel" : (chat.mode as LtmMode);
    const noteId = `scene_${normalizeIdentifier(chat.name, "chat")}_${hashShort(chat.id)}`;
    const sourceNoteId = `scene_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(chat.id)}`;
    const evidence = [`chat:${chat.id}`];
    const mutation: LtmDraftMutation = {
      ...mutationBase(`Import chat summary for ${chat.name}`, evidence, "low"),
      kind: "create_note",
      note: {
        id: noteId,
        type: "scene",
        status: "active",
        modes: [mode],
        scope: withMergedLtmScopeLinks(
          { chatId: chat.id, groupId: chat.groupId ?? undefined, characterIds: readJsonArray(chat.characterIds) },
          { chatIds: [chat.id] },
        ),
        tags: ["imported_chat_summary"],
        links: [],
        sections: { summary: textSection(summary, evidence) },
      },
    };
    return [
      {
        title: chat.name,
        sourceId: chat.id,
        sourceText: summary,
        sourceNoteId,
        sourceTag: "imported_chat",
        evidence,
        modes: mutation.note.modes,
        source: { chatId: chat.id },
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${chat.name}`),
      },
    ];
  });
}

async function interopDraftSeeds(db: DB, source: LtmInteropSource, limit: number, sourceIds?: Set<string>) {
  return source === "characters"
    ? characterDrafts(db, limit, sourceIds)
    : source === "lorebooks"
      ? lorebookDrafts(db, limit, sourceIds)
      : chatDrafts(db, limit, sourceIds);
}

export async function previewLongTermMemoryInterop(
  db: DB,
  source: LtmInteropSource,
  limit = 25,
): Promise<LtmInteropPreview> {
  const drafts = await interopDraftSeeds(db, source, limit);
  return {
    source,
    scanned: limit,
    draftable: drafts.length,
    samples: drafts.map((draft) => ({
      sourceId: draft.sourceId,
      title: draft.title,
      mutationCount: draft.response.mutations.length,
      summary: draft.response.summary,
    })),
  };
}

export async function createLongTermMemoryInteropDrafts(
  db: DB,
  source: LtmInteropSource,
  options: { limit?: number; scope?: LtmScope } = {},
): Promise<{ source: LtmInteropSource; created: LtmExtractionDraft[] }> {
  const limit = options.limit ?? 25;
  const store = new LongTermMemoryDraftStore();
  const drafts = await interopDraftSeeds(db, source, limit);
  const created: LtmExtractionDraft[] = [];
  for (const draft of drafts) {
    created.push(
      await store.createDraft({
        modes: draft.modes,
        source: draft.source,
        scope: { ...(draft.scope ?? {}), ...(options.scope ?? {}) },
        summary: draft.response.summary,
        response: draft.response,
        userMessage: "",
        assistantReply: "",
      }),
    );
  }
  return { source, created };
}

export async function createLongTermMemoryInteropSourceNotes(
  db: DB,
  source: LtmInteropSource,
  options: { sourceIds: string[]; limit?: number; scope?: LtmScope; operationId?: string } = { sourceIds: [] },
  root = getLongTermMemoryRoot(),
): Promise<{ source: LtmInteropSource; imported: LtmInteropSourceNoteImport[] }> {
  return withLtmDebugOperation(
    {
      operationId: options.operationId,
      root,
      phase: "import",
      action: "import_source_notes",
      source,
      counts: { selectedSources: options.sourceIds.length },
      details: { sourceIds: options.sourceIds, scope: options.scope },
    },
    async (operationId) => {
      const selected = new Set(options.sourceIds);
      const limit = Math.max(options.limit ?? options.sourceIds.length, options.sourceIds.length, 1);
      const storage = new LongTermMemoryStorage(root);
      const drafts = (await interopDraftSeeds(db, source, limit, selected)).filter((draft) =>
        selected.has(draft.sourceId),
      );
      const imported: LtmInteropSourceNoteImport[] = [];
      await recordLtmDebugEvent({
        root,
        operationId,
        phase: "import",
        action: "source_candidates_resolved",
        status: drafts.length ? "ok" : "skipped",
        source,
        counts: {
          selectedSources: options.sourceIds.length,
          resolvedSources: drafts.length,
          missingSources: Math.max(0, options.sourceIds.length - drafts.length),
        },
        details: {
          resolvedSourceIds: drafts.map((draft) => draft.sourceId),
          missingSourceIds: options.sourceIds.filter(
            (sourceId) => !drafts.some((draft) => draft.sourceId === sourceId),
          ),
        },
      });

      for (const draft of drafts) {
        const now = nowIso();
        const noteInput = {
          id: draft.sourceNoteId,
          type: "scene" as const,
          status: "dormant" as const,
          modes: draft.modes,
          scope: { ...(draft.scope ?? {}), ...(options.scope ?? {}) },
          tags: ["source_summary", draft.sourceTag],
          links: [],
          sections: {
            source: {
              ...textSection(draft.sourceText, draft.evidence),
              updatedAt: now,
            },
          },
        };
        const existing = await storage.getNote(noteInput.id);
        if (existing) {
          const note = await storage.updateNote(
            existing.id,
            {
              status: "dormant",
              modes: noteInput.modes,
              scope: noteInput.scope,
              tags: Array.from(new Set([...existing.tags, ...noteInput.tags])),
              sections: { ...existing.sections, ...noteInput.sections },
            },
            {
              actor: "maintenance_api",
              cause: "interop.source_import",
              summary: `Refreshed ${source} import source ${draft.title}`,
            },
          );
          imported.push({ sourceId: draft.sourceId, title: draft.title, note, created: false });
          await recordLtmDebugEvent({
            root,
            operationId,
            phase: "source_note",
            action: "source_note_refreshed",
            status: "ok",
            source,
            sourceId: draft.sourceId,
            sourceNoteId: note.id,
            counts: { sourceChars: draft.sourceText.length },
            message: `Refreshed ${draft.title}`,
          });
          continue;
        }

        const note = await storage.createNote(noteInput, {
          actor: "maintenance_api",
          cause: "interop.source_import",
          summary: `Imported ${source} source ${draft.title}`,
        });
        imported.push({ sourceId: draft.sourceId, title: draft.title, note, created: true });
        await recordLtmDebugEvent({
          root,
          operationId,
          phase: "source_note",
          action: "source_note_created",
          status: "ok",
          source,
          sourceId: draft.sourceId,
          sourceNoteId: note.id,
          counts: { sourceChars: draft.sourceText.length },
          message: `Created ${draft.title}`,
        });
      }

      return { source, imported };
    },
  );
}
