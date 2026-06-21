import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { logger } from "../../lib/logger.js";
import {
  ltmIndexMetadataSchema,
  normalizeChatSummaryEntries,
  ltmExtractionResponseSchema,
  ltmEventSchema,
  ltmNoteSchema,
  ltmScopeSchema,
  getLtmScopeChatIds,
  withMergedLtmScopeLinks,
  type ChatSummaryEntry,
  type LtmDraftMutation,
  type LtmExtractionDraft,
  type LtmIndexMetadata,
  type LtmMode,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
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
import { stableJsonHash } from "./chunking.js";
import { LongTermMemoryStorage } from "./storage.js";

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

type ImportSourceCandidate = {
  title: string;
  sourceId: string;
  sourceText: string;
  sourceNoteId: string;
  legacySourceNoteIds?: string[];
  sourceTag: string;
  evidence: string[];
  scope?: LtmScope;
  modes: LtmMode[];
  response: {
    summary: string;
    mutations: LtmDraftMutation[];
  };
};

function chatSummaryMessageRange(entry: ChatSummaryEntry) {
  if (entry.sourceMode === "range" && entry.rangeStartIndex && entry.rangeEndIndex) {
    return `${entry.rangeStartIndex}-${entry.rangeEndIndex}`;
  }
  if (entry.rangeStartIndex && entry.rangeEndIndex) return `${entry.rangeStartIndex}-${entry.rangeEndIndex}`;
  if (entry.messageCount) return `last ${entry.messageCount}`;
  if (entry.sourceMode === "agent") return "agent summary";
  return "last messages";
}

function chatSummaryImportTitle(chatName: string, entry: ChatSummaryEntry) {
  return `${chatName}, msgs ${chatSummaryMessageRange(entry)}`;
}

function chatSummaryImportSourceId(chatId: string, entryId: string) {
  return `${chatId}:${entryId}`;
}

function evidenceSafeValue(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 200);
}

function normalizeLegacyNoteScope(scope: unknown) {
  const parsed = ltmScopeSchema.parse(
    scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {},
  );
  return withMergedLtmScopeLinks(parsed, {});
}

export interface LtmIntegrityResult {
  ok: boolean;
  checkedAt: string;
  noteCount: number;
  eventCount: number;
  issues: IntegrityIssue[];
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
  samples: Array<{ sourceId: string; title: string; mutationCount: number; summary: string; snippet: string }>;
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
    logger.error(err, "Event log unreadable at %s", publicPath);
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

async function checkIndexCoherence(root: string, vaultNoteCount: number, issues: IntegrityIssue[]) {
  const dirs = getLongTermMemoryDirectories(root);
  const manifestPath = safeJoin(dirs.indexes, "manifest.json");
  let manifest: LtmIndexMetadata | null = null;
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest = ltmIndexMetadataSchema.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(err, "Manifest unreadable at %s", relative(root, manifestPath));
      issues.push({
        severity: "error",
        code: "manifest_unreadable",
        path: relative(root, manifestPath),
        message: "Manifest cannot be read or parsed.",
      });
    }
    return;
  }

  if (manifest.noteCount !== vaultNoteCount) {
    issues.push({
      severity: "warning",
      code: "manifest_note_mismatch",
      path: relative(root, manifestPath),
      message: `Manifest reports ${manifest.noteCount} notes but vault has ${vaultNoteCount}.`,
    });
  }

  const vaultFiles = await listVaultFiles(root);
  const computedHashes: Record<string, string> = {};
  for (const file of vaultFiles) {
    const relativePath = relative(root, file.path).split(/[\\/]+/).join("/");
    computedHashes[relativePath] = stableJsonHash(await readFile(file.path, "utf8"));
  }
  const actualSourceHash = stableJsonHash(computedHashes);
  if (manifest.sourceHash !== actualSourceHash) {
    issues.push({
      severity: "warning",
      code: "manifest_hash_mismatch",
      path: relative(root, manifestPath),
      message: "Manifest source hash does not match current vault content.",
    });
  }

  const embeddingsPath = safeJoin(dirs.indexes, "embeddings.json");
  try {
    const embeddingsRaw = JSON.parse(await readFile(embeddingsPath, "utf8"));
    const embeddings = embeddingsRaw as { embeddedChunkCount?: number; chunks?: unknown[] };
    const embeddingCount = embeddings.embeddedChunkCount ?? embeddings.chunks?.length ?? -1;
    if (embeddingCount !== manifest.chunkCount) {
      issues.push({
        severity: "info",
        code: "embedding_chunk_mismatch",
        path: relative(root, embeddingsPath),
        message: `Embeddings report ${embeddingCount} chunks but manifest reports ${manifest.chunkCount}.`,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(err, "Embeddings index unreadable at %s", relative(root, embeddingsPath));
      issues.push({
        severity: "warning",
        code: "embeddings_unreadable",
        path: relative(root, embeddingsPath),
        message: "Embeddings index cannot be read.",
      });
    }
  }
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
      const raw = JSON.parse(await readFile(file.path, "utf8"));
      const note = ltmNoteSchema.parse({
        ...raw,
        scope: normalizeLegacyNoteScope(raw.scope),
      });
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
    } catch (err) {
      logger.warn(err, "Malformed note at %s", publicPath);
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
  await checkIndexCoherence(root, notesById.size, issues);
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    checkedAt: nowIso(),
    noteCount: notesById.size,
    eventCount,
    issues,
  };
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
            const raw = JSON.parse(await readFile(file.path, "utf8"));
            ltmNoteSchema.parse({
              ...raw,
              scope: normalizeLegacyNoteScope(raw.scope),
            });
          } catch {
            await mkdir(join(quarantineDir, file.folder), { recursive: true });
            await rename(file.path, join(quarantineDir, file.folder, basename(file.path)));
            moved += 1;
          }
        }
        results.push({ action, result: moved > 0 ? "quarantined" : "no_malformed_notes", count: moved });
        if (moved > 0) {
          await rebuildLongTermMemoryIndexes({ root });
        }
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

async function characterImportCandidates(
  db: DB,
  limit: number,
  sourceIds?: Set<string>,
): Promise<ImportSourceCandidate[]> {
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
    const sourceNoteId = `source_import_character_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`;
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
        legacySourceNoteIds: [`scene_import_character_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`],
        sourceTag: "imported_character",
        evidence,
        modes: mutation.note.modes,
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${name}`),
      },
    ];
  });
}

async function lorebookImportCandidates(
  db: DB,
  limit: number,
  sourceIds?: Set<string>,
): Promise<ImportSourceCandidate[]> {
  const storage = createLorebooksStorage(db);
  const books = (await storage.list()) as Array<Record<string, unknown>>;
  const selectedBooks = sourceIds
    ? books.filter((book) => typeof book.id === "string" && sourceIds.has(book.id))
    : books.slice(0, limit);
  const candidates: ImportSourceCandidate[] = [];
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
    const sourceNoteId = `source_import_lorebook_${normalizeIdentifier(name, "lorebook")}_${hashShort(id)}`;
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
    candidates.push({
      title: name,
      sourceId: id,
      sourceText: text,
      sourceNoteId,
      legacySourceNoteIds: [`scene_import_lorebook_${normalizeIdentifier(name, "lorebook")}_${hashShort(id)}`],
      sourceTag: "imported_lorebook",
      evidence,
      modes,
      scope: mutation.note.scope,
      response: makeDraftResponse([mutation], `Import ${name}`),
    });
  }
  return candidates;
}

async function chatImportCandidates(
  db: DB,
  limit: number,
  sourceIds?: Set<string>,
  scope?: LtmScope,
): Promise<ImportSourceCandidate[]> {
  const chats = await createChatsStorage(db).list();
  const scopeChatIds = new Set(getLtmScopeChatIds(scope));
  const scopedChats = scopeChatIds.size || scope?.groupId
    ? chats.filter((chat) => {
        if (scopeChatIds.size) return scopeChatIds.has(chat.id);
        return Boolean(scope?.groupId && chat.groupId === scope.groupId);
      })
    : chats;
  const rows = sourceIds ? scopedChats : scopedChats.slice(0, limit);
  const candidates = rows.flatMap((chat) => {
    const metadata = readJsonObject(chat.metadata);
    const summary = typeof metadata.summary === "string" ? metadata.summary.trim() : "";
    const entries = normalizeChatSummaryEntries(metadata.summaryEntries, {
      legacySummary: summary,
      legacyFallback: Array.isArray(metadata.summaryEntries) ? false : true,
    }).filter((entry) => entry.enabled,);
    if (entries.length === 0) return [];
    const mode = chat.mode as LtmMode;
    return entries.map((entry) => {
      const chatName = evidenceSafeValue(chat.name) || "Chat";
      const title = chatSummaryImportTitle(chatName, entry);
      const range = chatSummaryMessageRange(entry);
      const noteSeed = `${chat.id}:${entry.id}`;
      const noteId = `scene_${normalizeIdentifier(chat.name, "chat")}_${hashShort(noteSeed)}`;
      const sourceNoteId = `source_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(noteSeed)}`;
      const evidence = [
        `chat:${chat.id}`,
        `chat_name:${chatName}`,
        `summary_entry:${entry.id}`,
        `message_range:${range}`,
      ];
      const mutation: LtmDraftMutation = {
        ...mutationBase(`Import chat summary for ${title}`, evidence, "low"),
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
          sections: { summary: textSection(entry.content, evidence) },
        },
      };
      return {
        title,
        sourceId: chatSummaryImportSourceId(chat.id, entry.id),
        sourceText: entry.content,
        sourceNoteId,
        legacySourceNoteIds:
          entry.origin === "legacy"
            ? [`scene_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(chat.id)}`]
            : undefined,
        sourceTag: "imported_chat",
        evidence,
        modes: mutation.note.modes,
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${title}`),
      };
    });
  });
  const seenHashes = new Set<string>();
  const deduped = candidates.filter((candidate) => {
    const hash = createHash("sha256").update(candidate.sourceText).digest("hex");
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });
  return sourceIds ? deduped.filter((candidate) => sourceIds.has(candidate.sourceId)) : deduped.slice(0, limit);
}

async function interopImportCandidates(
  db: DB,
  source: LtmInteropSource,
  limit: number,
  sourceIds?: Set<string>,
  scope?: LtmScope,
) {
  return source === "characters"
    ? characterImportCandidates(db, limit, sourceIds)
    : source === "lorebooks"
      ? lorebookImportCandidates(db, limit, sourceIds)
      : chatImportCandidates(db, limit, sourceIds, scope);
}

export async function previewLongTermMemoryInterop(
  db: DB,
  source: LtmInteropSource,
  limit = 25,
  root?: string,
  scope?: LtmScope,
): Promise<LtmInteropPreview> {
  const candidates = await interopImportCandidates(db, source, limit, undefined, source === "chats" ? scope : undefined);
  const storage = new LongTermMemoryStorage(root ?? getLongTermMemoryRoot());
  const existingNotes = await storage.getNotesByIds(
    candidates.flatMap((candidate) => [candidate.sourceNoteId, ...(candidate.legacySourceNoteIds ?? [])]),
  );
  const deduped: typeof candidates = [];
  for (const c of candidates) {
    const ids = [c.sourceNoteId, ...(c.legacySourceNoteIds ?? [])];
    const exists = ids.some((id) => existingNotes.has(id));
    if (!exists) deduped.push(c);
  }
  return {
    source,
    scanned: limit,
    draftable: deduped.length,
    samples: deduped.map((candidate) => {
      const trimmed = candidate.sourceText.trim();
      const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
      return {
        sourceId: candidate.sourceId,
        title: candidate.title,
        mutationCount: candidate.response.mutations.length,
        summary: candidate.response.summary,
        snippet,
      };
    }),
  };
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
      const candidates = (await interopImportCandidates(db, source, limit, selected, source === "chats" ? options.scope : undefined)).filter((candidate) =>
        selected.has(candidate.sourceId),
      );
      const existingNotes = await storage.getNotesByIds(
        candidates.flatMap((candidate) => [...(candidate.legacySourceNoteIds ?? []), candidate.sourceNoteId]),
      );
      const imported: LtmInteropSourceNoteImport[] = [];
      await recordLtmDebugEvent({
        root,
        operationId,
        phase: "import",
        action: "source_candidates_resolved",
        status: candidates.length ? "ok" : "skipped",
        source,
        counts: {
          selectedSources: options.sourceIds.length,
          resolvedSources: candidates.length,
          missingSources: Math.max(0, options.sourceIds.length - candidates.length),
        },
        details: {
          resolvedSourceIds: candidates.map((candidate) => candidate.sourceId),
          missingSourceIds: options.sourceIds.filter(
            (sourceId) => !candidates.some((candidate) => candidate.sourceId === sourceId),
          ),
        },
      });

      for (const candidate of candidates) {
        const now = nowIso();
        const noteInput = {
          id: candidate.sourceNoteId,
          type: "source" as const,
          status: "active" as const,
          modes: candidate.modes,
          scope: { ...(candidate.scope ?? {}), ...(options.scope ?? {}) },
          tags: ["source_summary", candidate.sourceTag],
          links: [],
          sections: {
            source: {
              ...textSection(candidate.sourceText, candidate.evidence),
              updatedAt: now,
            },
          },
        };
        const noteIds = [...(candidate.legacySourceNoteIds ?? []), candidate.sourceNoteId];
        const existing = noteIds.map((noteId) => existingNotes.get(noteId)).find((note): note is LtmNote => Boolean(note));
        if (existing) {
          const note = await storage.updateNote(
            existing.id,
            {
              status: "active",
              modes: noteInput.modes,
              scope: noteInput.scope,
              tags: Array.from(new Set([...existing.tags, ...noteInput.tags])),
              sections: { ...existing.sections, ...noteInput.sections },
            },
            {
              actor: "maintenance_api",
              cause: "interop.source_import",
              summary: `Refreshed ${source} import source ${candidate.title}`,
            },
          );
          imported.push({ sourceId: candidate.sourceId, title: candidate.title, note, created: false });
          await recordLtmDebugEvent({
            root,
            operationId,
            phase: "source_note",
            action: "source_note_refreshed",
            status: "ok",
            source,
            sourceId: candidate.sourceId,
            sourceNoteId: note.id,
            counts: { sourceChars: candidate.sourceText.length },
            message: `Refreshed ${candidate.title}`,
          });
          continue;
        }

        const note = await storage.createNote(noteInput, {
          actor: "maintenance_api",
          cause: "interop.source_import",
          summary: `Imported ${source} source ${candidate.title}`,
        });
        imported.push({ sourceId: candidate.sourceId, title: candidate.title, note, created: true });
        await recordLtmDebugEvent({
          root,
          operationId,
          phase: "source_note",
          action: "source_note_created",
          status: "ok",
          source,
          sourceId: candidate.sourceId,
          sourceNoteId: note.id,
          counts: { sourceChars: candidate.sourceText.length },
          message: `Created ${candidate.title}`,
        });
      }

      return { source, imported };
    },
  );
}
