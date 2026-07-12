import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { logger } from "../../lib/logger.js";
import { isEnoent, nowIso } from "./ltm-utils.js";
import {
  normalizeChatSummaryEntries,
  ltmExtractionResponseSchema,
  ltmEventSchema,
  getLtmScopeChatIds,
  withMergedLtmScopeLinks,
  type ChatSummaryEntry,
  type LtmDraftMutation,
  type LtmExtractionDraft,
  type LtmImportSourceWriteFailure,
  type LtmIndexHealth,
  type LtmIntegrityIssue,
  type LtmIntegrityResponse,
  type LtmInteropPreviewResponse,
  type LtmInteropSource,
  type LtmMode,
  type LtmNote,
  type LtmNoteType,
  type LtmScope,
  type LtmSourceProvenance,
  type LtmRepairAction,
  type LtmRepairResponse,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { computeGameSourceHash, renderGameSourceText } from "./game-journal-mapper.js";
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
import { CURRENT_LTM_CHUNK_FORMAT_VERSION, stableJsonHash } from "./chunking.js";
import { loadLtmIndexGeneration, ltmIndexPointerPath } from "./index-generation.js";
import { readLtmIndexState } from "./index-state.js";
import { LongTermMemoryStorage } from "./storage.js";
import { withLtmVaultLock } from "./vault-lock.js";
import { sourceNoteIdForProvenance } from "./source-identity.js";
import { parseStoredLtmNote } from "./stored-note.js";
import { ltmModeForChatMode } from "./chat-scope.js";
import { extractionFingerprintForLtmSourceMaterial, extractionFingerprintsEqual } from "./source-hash.js";

export type ImportSourceCandidate = {
  title: string;
  sourceId: string;
  sourceText: string;
  sourceNoteId: string;
  legacySourceNoteIds?: string[];
  sourceTag: string;
  evidence: string[];
  provenance: LtmSourceProvenance;
  scope?: LtmScope;
  modes: LtmMode[];
  extractionMode: LtmMode;
  response: {
    summary: string;
    mutations: LtmDraftMutation[];
  };
};

const LTM_LOREBOOK_ENTRY_MAX_TOKENS = 6_000;
const LTM_LOREBOOK_ENTRY_MAX_CHARS = LTM_LOREBOOK_ENTRY_MAX_TOKENS * 4;

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

function titleCaseFromIdentifier(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stripImportPrefix(value: string) {
  return value
    .replace(/^source_import_(character|lorebook|chat)_/, "")
    .replace(/^scene_import_(character|lorebook|chat)_/, "")
    .replace(/_[a-f0-9]{10}$/i, "");
}

function importedSourceTitleFromNote(note: Pick<LtmNote, "id" | "tags" | "title" | "sections">) {
  const title = note.title?.trim();
  if (title) return title;

  const evidence = note.sections.source?.evidence ?? [];
  const chatName = evidence
    .find((entry) => entry.startsWith("chat_name:"))
    ?.slice("chat_name:".length)
    .trim();
  const messageRange = evidence
    .find((entry) => entry.startsWith("message_range:"))
    ?.slice("message_range:".length)
    .trim();

  if (note.tags.includes("imported_chat") && chatName) {
    return messageRange ? `${chatName}, msgs ${messageRange}` : chatName;
  }

  if (note.tags.includes("imported_game_journal")) {
    return `Game Journal — ${titleCaseFromIdentifier(stripImportPrefix(note.id))}`;
  }

  if (note.tags.includes("imported_character")) {
    return `Character — ${titleCaseFromIdentifier(stripImportPrefix(note.id))}`;
  }

  if (note.tags.includes("imported_lorebook")) {
    return `Lorebook — ${titleCaseFromIdentifier(stripImportPrefix(note.id))}`;
  }

  if (note.tags.some((tag) => tag.startsWith("imported_"))) {
    return titleCaseFromIdentifier(stripImportPrefix(note.id)) || "Imported source";
  }

  return "Imported source";
}

function isBackfillableImportedSourceNote(note: LtmNote) {
  return note.type === "source" && note.tags.some((tag) => tag.startsWith("imported_"));
}

export interface LtmInteropSourceNoteImport {
  sourceId: string;
  title: string;
  note: LtmNote;
  created: boolean;
}

export type LtmInteropImportOptions = {
  sourceIds: string[];
  limit?: number;
  scope?: LtmScope;
  mode?: LtmMode;
  operationId?: string;
};

export interface LtmInteropSourceNotePlan {
  source: LtmInteropSource;
  requestedSourceIds: string[];
  missingSourceIds: string[];
  requiresExtraction: boolean;
  candidates: ImportSourceCandidate[];
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
    text: text.trim().slice(0, 24_000),
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
      if (isEnoent(err)) return [];
      throw err;
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json"))
        files.push({ folder, path: safeJoin(folderPath, entry.name) });
    }
  }
  return files;
}

async function checkEventLogIntegrity(root: string, issues: LtmIntegrityIssue[]) {
  const dirs = getLongTermMemoryDirectories(root);
  const publicPath = relative(root, dirs.eventLog)
    .split(/[\\/]+/)
    .join("/");
  let content = "";
  try {
    content = await readFile(dirs.eventLog, "utf8");
  } catch (err) {
    if (isEnoent(err)) return 0;
    logger.error(err, "[ltm] Event log unreadable at %s", publicPath);
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

async function checkIndexCoherence(
  root: string,
  vaultNoteCount: number,
  issues: LtmIntegrityIssue[],
  fileContents: Array<{ path: string; rawContent: string }>,
): Promise<LtmIndexHealth> {
  const pointerPath = ltmIndexPointerPath(root);
  const publicPointerPath = relative(root, pointerPath)
    .split(/[\\/]+/)
    .join("/");
  let loaded: Awaited<ReturnType<typeof loadLtmIndexGeneration>>;
  try {
    loaded = await loadLtmIndexGeneration(root);
  } catch (err) {
    logger.warn(err, "[ltm] Index generations could not be inspected");
    issues.push({
      severity: "error",
      code: "index_generation_unreadable",
      path: publicPointerPath,
      message: "Index generations cannot be read or validated.",
    });
    return "corrupt";
  }

  if (loaded.pointerStatus === "missing") {
    if (vaultNoteCount > 0) {
      issues.push({
        severity: "warning",
        code: "indexes_not_built",
        path: publicPointerPath,
        message: "Long-term memory indexes have not been built for the current vault.",
      });
    }
    return "not_built";
  }

  const manifest = loaded.manifest;
  if (!manifest) {
    issues.push({
      severity: "error",
      code: "index_generation_unavailable",
      path: publicPointerPath,
      message: "No valid long-term memory index generation is available.",
    });
    return "corrupt";
  }

  let health: LtmIndexHealth = loaded.recovered ? "degraded" : "healthy";
  if (loaded.recovered) {
    issues.push({
      severity: "warning",
      code: "index_generation_recovered",
      path: publicPointerPath,
      message: `Recovered indexes from generation ${manifest.generationId} because the current generation is invalid.`,
    });
  }

  const freshnessManifest = manifest;

  if (freshnessManifest.noteCount !== vaultNoteCount) {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "index_note_mismatch",
      path: publicPointerPath,
      message: `Manifest reports ${freshnessManifest.noteCount} notes but vault has ${vaultNoteCount}.`,
    });
  }

  if (freshnessManifest.chunkFormatVersion !== CURRENT_LTM_CHUNK_FORMAT_VERSION) {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "index_chunk_format_stale",
      path: publicPointerPath,
      message: `Index chunk format version ${freshnessManifest.chunkFormatVersion} is stale; rebuild indexes for version ${CURRENT_LTM_CHUNK_FORMAT_VERSION}.`,
    });
  }

  const computedHashes: Record<string, string> = {};
  for (const file of fileContents) {
    const relativePath = relative(root, file.path)
      .split(/[\\/]+/)
      .join("/");
    computedHashes[relativePath] = stableJsonHash(file.rawContent);
  }
  const actualSourceHash = stableJsonHash(computedHashes);
  if (freshnessManifest.sourceHash !== actualSourceHash) {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "index_source_hash_mismatch",
      path: publicPointerPath,
      message: "Index source hash does not match current vault content.",
    });
  }

  let state: Awaited<ReturnType<typeof readLtmIndexState>>;
  try {
    state = await readLtmIndexState(root);
  } catch (err) {
    logger.warn(err, "[ltm] Index state could not be read");
    issues.push({
      severity: "error",
      code: "index_state_unreadable",
      path: publicPointerPath,
      message: "Index rebuild state cannot be read or validated.",
    });
    return "corrupt";
  }

  if (state.dirty) {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "indexes_dirty",
      path: publicPointerPath,
      message: "The vault changed after the active index generation was built.",
    });
  } else if (!loaded.recovered && state.lastPublishedGenerationId !== manifest.generationId) {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "index_state_generation_mismatch",
      path: publicPointerPath,
      message: "Index state does not match the active generation.",
    });
  }

  if (state.rebuildState === "failed") {
    health = "stale";
    issues.push({
      severity: "warning",
      code: "index_rebuild_failed",
      path: publicPointerPath,
      message: state.error ?? "The latest index rebuild failed.",
    });
  } else if (state.rebuildState === "building" && health === "healthy") {
    health = "degraded";
    issues.push({
      severity: "info",
      code: "index_rebuild_in_progress",
      path: publicPointerPath,
      message: "A new index generation is being built.",
    });
  }
  return health;
}

export async function checkLongTermMemoryIntegrity(root = getLongTermMemoryRoot()): Promise<LtmIntegrityResponse> {
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  const issues: LtmIntegrityIssue[] = [];
  const notesById = new Map<string, LtmNote>();
  const fileContents: Array<{ path: string; rawContent: string }> = [];

  for (const file of await listVaultFiles(root)) {
    const publicPath = relative(root, file.path)
      .split(/[\\/]+/)
      .join("/");
    let rawContent: string;
    try {
      rawContent = await readFile(file.path, "utf8");
    } catch (err) {
      issues.push({
        severity: "error",
        code: "malformed_note",
        path: publicPath,
        message: err instanceof Error ? err.message : "Note could not be read.",
      });
      continue;
    }
    fileContents.push({ path: file.path, rawContent });
    try {
      const raw = JSON.parse(rawContent);
      const note = parseStoredLtmNote(raw);
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
      logger.warn(err, "[ltm] Malformed note at %s", publicPath);
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
  const health = await checkIndexCoherence(root, notesById.size, issues, fileContents);
  return {
    ok:
      !issues.some((issue) => issue.severity === "error") &&
      (health === "healthy" || (health === "not_built" && notesById.size === 0)),
    health,
    checkedAt: nowIso(),
    noteCount: notesById.size,
    eventCount,
    issues,
  };
}

export async function repairLongTermMemory(
  actions: LtmRepairAction[],
  root = getLongTermMemoryRoot(),
): Promise<LtmRepairResponse> {
  return withLtmVaultLock(root, () =>
    withLtmDebugOperation(
      {
        root,
        phase: "repair",
        action: "repair",
        message: "Repair long-term memory store",
        details: { actions },
      },
      async (operationId) => {
        const results: LtmRepairResponse["actions"] = [];
        const dirs = getLongTermMemoryDirectories(root);
        let rebuildNeeded = false;

        for (const action of actions) {
          if (action === "rebuild_indexes") {
            rebuildNeeded = true;
            results.push({ action, result: "rebuilt" });
            continue;
          }

          if (action === "backfill_imported_source_titles") {
            const storage = new LongTermMemoryStorage(root);
            const sourceNotes = await storage.listNotes({ type: "source" });
            let patched = 0;
            for (const note of sourceNotes) {
              if (!isBackfillableImportedSourceNote(note)) continue;
              if (note.title?.trim()) continue;
              await storage.updateNote(
                note.id,
                { title: importedSourceTitleFromNote(note) },
                {
                  actor: "maintenance_api",
                  cause: "repair.backfill_imported_source_titles",
                  summary: "Backfilled imported source note title",
                },
              );
              patched += 1;
            }
            results.push({ action, result: patched > 0 ? "backfilled" : "no_titles_to_backfill", count: patched });
            rebuildNeeded ||= patched > 0;
            await recordLtmDebugEvent({
              root,
              operationId,
              phase: "repair",
              action: "repair_backfill_source_titles",
              status: "ok",
              counts: { notes: patched },
            });
            continue;
          }

          const quarantineDir = join(dirs.root, "quarantine", `malformed-${Date.now()}`);
          let moved = 0;
          for (const file of await listVaultFiles(root)) {
            try {
              const raw = JSON.parse(await readFile(file.path, "utf8"));
              parseStoredLtmNote(raw);
            } catch {
              await mkdir(join(quarantineDir, file.folder), { recursive: true });
              await rename(file.path, join(quarantineDir, file.folder, basename(file.path)));
              moved += 1;
            }
          }
          results.push({ action, result: moved > 0 ? "quarantined" : "no_malformed_notes", count: moved });
          rebuildNeeded ||= moved > 0;
        }

        if (rebuildNeeded) {
          const rebuild = await rebuildLongTermMemoryIndexes({ root });
          const explicitRebuild = results.find((result) => result.action === "rebuild_indexes");
          if (explicitRebuild) explicitRebuild.count = rebuild.chunkCount;
          await recordLtmDebugEvent({
            root,
            operationId,
            phase: "rebuild",
            action: "repair_rebuild_indexes",
            status: "ok",
            counts: { chunks: rebuild.chunkCount, notes: rebuild.noteCount },
          });
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
    ),
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
    const extensions = readJsonObject(data.extensions);
    const name = typeof data.name === "string" ? data.name : "Character";
    const body = compactLines([
      ["Description", data.description],
      ["Personality", data.personality],
      ["Scenario", data.scenario],
      ["First message", data.first_mes],
      ["Example messages", data.mes_example],
      ["Creator notes", data.creator_notes],
      ["System prompt", data.system_prompt],
      ["Post-history instructions", data.post_history_instructions],
      ["Alternate greetings", readJsonArray(data.alternate_greetings).join("\n\n")],
      ["Backstory", extensions.backstory ?? data.backstory],
      ["Appearance", extensions.appearance ?? data.appearance],
      ["Library note", row.comment],
    ]);
    if (!body) return [];
    const noteId = `char_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`;
    const provenance = { kind: "character", sourceId: row.id } satisfies LtmSourceProvenance;
    const sourceNoteId = sourceNoteIdForProvenance(provenance);
    const evidence = [`character:${row.id}`];
    const mutation: LtmDraftMutation = {
      ...mutationBase(`Import character card for ${name}`, evidence),
      kind: "create_note",
      note: {
        id: noteId,
        type: "character",
        status: "active",
        modes: ["roleplay", "conversation", "game"],
        scope: { characterIds: [row.id] },
        tags: readJsonArray(data.tags)
          .map((tag) => normalizeIdentifier(tag, "tag"))
          .slice(0, 12),
        keywords: [],
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
        legacySourceNoteIds: [
          `source_import_character_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`,
          `scene_import_character_${normalizeIdentifier(name, "character")}_${hashShort(row.id)}`,
        ],
        sourceTag: "imported_character",
        evidence,
        provenance,
        modes: mutation.note.modes,
        extractionMode: "roleplay",
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${name}`),
      },
    ];
  });
}

function splitLorebookEntryText(text: string) {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > LTM_LOREBOOK_ENTRY_MAX_CHARS) {
    const window = remaining.slice(0, LTM_LOREBOOK_ENTRY_MAX_CHARS + 1);
    const boundary = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" "),
    );
    const end =
      boundary > LTM_LOREBOOK_ENTRY_MAX_CHARS / 2
        ? boundary + (window.startsWith(". ", boundary) ? 1 : 0)
        : LTM_LOREBOOK_ENTRY_MAX_CHARS;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function lorebookEntryIdentity(entry: Record<string, unknown>, index: number, part: number) {
  const rawId = entry.id ?? entry.uid ?? entry.key ?? `position_${index + 1}`;
  const base = String(rawId).trim() || `position_${index + 1}`;
  const suffix = part > 0 ? `:part:${part + 1}` : "";
  const value = `${base}${suffix}`;
  return value.length <= 120 ? value : `entry_${hashShort(`${base}\0${part}`)}`;
}

function lorebookCandidateSourceId(bookId: string, entryId: string) {
  return `lorebook_entry_${hashShort(`${bookId}\0${entryId}`)}`;
}

async function lorebookImportCandidates(
  db: DB,
  limit: number,
  sourceIds?: Set<string>,
): Promise<ImportSourceCandidate[]> {
  const storage = createLorebooksStorage(db);
  const books = (await storage.list()) as Array<Record<string, unknown>>;
  const candidates: ImportSourceCandidate[] = [];

  for (const book of books) {
    const id = typeof book.id === "string" ? book.id : "";
    if (!id) continue;
    const name = typeof book.name === "string" && book.name.trim() ? book.name : "Lorebook";
    const category = typeof book.category === "string" ? book.category : "";
    const type: LtmNoteType = category === "character" || category === "npc" ? "character" : "world";
    const prefix = type === "character" ? "char" : "world";
    const modes: LtmMode[] = ["roleplay", "conversation", "game"];
    const scope = withMergedLtmScopeLinks(
      {
        chatId: typeof book.chatId === "string" ? book.chatId : undefined,
        characterIds: Array.isArray(book.characterIds)
          ? book.characterIds.filter((value): value is string => typeof value === "string")
          : undefined,
      },
      { chatIds: typeof book.chatId === "string" ? [book.chatId] : [] },
    );
    const tags = Array.isArray(book.tags)
      ? book.tags.map((tag) => normalizeIdentifier(String(tag), "tag")).slice(0, 12)
      : [];
    const rawEntries = (await storage.listEntries(id)) as Array<Record<string, unknown>>;
    const entries: Array<{ title: string; entry: Record<string, unknown>; text: string }> = [];
    const description = typeof book.description === "string" ? book.description.trim() : "";
    if (description) entries.push({ title: "Description", entry: { id: "description" }, text: description });
    for (const entry of rawEntries) {
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (!text) continue;
      entries.push({
        title: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Entry",
        entry,
        text,
      });
    }

    for (const [entryIndex, entry] of entries.entries()) {
      const chunks = splitLorebookEntryText(entry.text);
      for (const [part, sourceText] of chunks.entries()) {
        const entryId = lorebookEntryIdentity(entry.entry, entryIndex, part);
        const sourceId = lorebookCandidateSourceId(id, entryId);
        if (sourceIds && !sourceIds.has(sourceId)) continue;
        const provenance = { kind: "lorebook", sourceId: id, entryId } satisfies LtmSourceProvenance;
        const sourceNoteId = sourceNoteIdForProvenance(provenance);
        const evidence = [
          `lorebook:${id}`,
          `lorebook_entry:${entryId}`,
          ...(chunks.length > 1 ? [`lorebook_part:${part + 1}/${chunks.length}`] : []),
        ];
        const partLabel = chunks.length > 1 ? ` (${part + 1}/${chunks.length})` : "";
        const noteId = `${prefix}_${normalizeIdentifier(entry.title, "lorebook")}_${hashShort(`${id}\0${entryId}`)}`;
        const mutation: LtmDraftMutation = {
          ...mutationBase(`Import lorebook ${name}: ${entry.title}${partLabel}`, evidence),
          kind: "create_note",
          note: {
            id: noteId,
            type,
            status: "active",
            modes,
            scope,
            tags,
            keywords: [],
            links: [],
            sections: { lore: textSection(sourceText, evidence) },
          },
        };
        candidates.push({
          title: `Lorebook — ${name}: ${entry.title}${partLabel}`,
          sourceId,
          sourceText,
          sourceNoteId,
          sourceTag: "imported_lorebook",
          evidence,
          provenance,
          modes,
          extractionMode: "roleplay",
          scope,
          response: makeDraftResponse([mutation], `Import ${name}: ${entry.title}${partLabel}`),
        });
        if (!sourceIds && candidates.length >= limit) return candidates;
      }
    }
  }
  return candidates;
}

function buildGameImportCandidate(
  chat: { id: string; name: string; groupId?: string | null; characterIds?: unknown; mode?: unknown },
  gameJournal: unknown,
  sessionSummaries: unknown[],
): ImportSourceCandidate {
  const chatName = evidenceSafeValue(chat.name) || "Game";
  const sourceText = renderGameSourceText(gameJournal as any, sessionSummaries as any);
  const provenance = { kind: "game_journal", sourceId: chat.id } satisfies LtmSourceProvenance;
  const sourceNoteId = sourceNoteIdForProvenance(provenance);
  const evidence = [
    `chat:${chat.id}`,
    "game_journal",
    `game_source_hash:${computeGameSourceHash(gameJournal as any, sessionSummaries as any)}`,
  ];
  const scope = withMergedLtmScopeLinks(
    {
      chatId: chat.id,
      groupId: typeof chat.groupId === "string" ? chat.groupId : undefined,
      characterIds: readJsonArray(chat.characterIds),
    },
    { chatIds: [chat.id] },
  );

  return {
    title: `Game Journal — ${chatName}`,
    sourceId: `${chat.id}:game_journal`,
    sourceText,
    sourceNoteId,
    legacySourceNoteIds: [
      `source_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(chat.id + "_game_journal")}`,
    ],
    sourceTag: "imported_game_journal",
    evidence,
    provenance,
    modes: ["game"],
    extractionMode: "game",
    scope,
    response: makeDraftResponse([], `Direct-ingest game journal for ${chatName}`),
  };
}

async function chatImportCandidates(
  db: DB,
  limit: number,
  sourceIds?: Set<string>,
  scope?: LtmScope,
): Promise<ImportSourceCandidate[]> {
  const chats = await createChatsStorage(db).list();
  const scopeChatIds = new Set(getLtmScopeChatIds(scope));
  const scopedChats =
    scopeChatIds.size || scope?.groupId
      ? chats.filter((chat) => {
          if (scopeChatIds.size) return scopeChatIds.has(chat.id);
          return Boolean(scope?.groupId && chat.groupId === scope.groupId);
        })
      : chats;
  const selectedChatIds = sourceIds
    ? new Set(Array.from(sourceIds, (sourceId) => sourceId.split(":", 1)[0]).filter(Boolean))
    : null;
  const rows = selectedChatIds
    ? scopedChats.filter((chat) => selectedChatIds.has(chat.id))
    : scopedChats.slice(0, limit);
  const candidates = rows.flatMap((chat) => {
    const metadata = readJsonObject(chat.metadata);
    const mode = ltmModeForChatMode(chat.mode);

    // Game-mode chats with journal data produce a single game import candidate
    // (direct ingestion, no LLM extraction needed)
    if (mode === "game") {
      const gameJournal = metadata.gameJournal ?? null;
      const sessionSummaries = Array.isArray(metadata.gamePreviousSessionSummaries)
        ? metadata.gamePreviousSessionSummaries
        : [];
      if (gameJournal || sessionSummaries.length > 0) {
        return [buildGameImportCandidate(chat, gameJournal, sessionSummaries)];
      }
    }

    const summary = typeof metadata.summary === "string" ? metadata.summary.trim() : "";
    const entries = normalizeChatSummaryEntries(metadata.summaryEntries, {
      legacySummary: summary,
      legacyFallback: Array.isArray(metadata.summaryEntries) ? false : true,
    }).filter((entry) => entry.enabled);
    if (entries.length === 0) return [];
    return entries.map((entry) => {
      const chatName = evidenceSafeValue(chat.name) || "Chat";
      const title = chatSummaryImportTitle(chatName, entry);
      const range = chatSummaryMessageRange(entry);
      const noteSeed = `${chat.id}:${entry.id}`;
      const noteId = `scene_${normalizeIdentifier(chat.name, "chat")}_${hashShort(noteSeed)}`;
      const provenance = {
        kind: "chat_summary",
        sourceId: chat.id,
        entryId: entry.id,
      } satisfies LtmSourceProvenance;
      const sourceNoteId = sourceNoteIdForProvenance(provenance);
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
          keywords: [],
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
            ? [
                `source_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(noteSeed)}`,
                `scene_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(chat.id)}`,
              ]
            : [`source_import_chat_${normalizeIdentifier(chat.name, "chat")}_${hashShort(noteSeed)}`],
        sourceTag: "imported_chat",
        evidence,
        provenance,
        modes: mutation.note.modes,
        extractionMode: mode,
        scope: mutation.note.scope,
        response: makeDraftResponse([mutation], `Import ${title}`),
      };
    });
  });
  return sourceIds ? candidates.filter((candidate) => sourceIds.has(candidate.sourceId)) : candidates.slice(0, limit);
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

function withRequestedExtractionMode(candidate: ImportSourceCandidate, mode?: LtmMode) {
  if (!mode || candidate.sourceTag === "imported_game_journal") return candidate;
  return { ...candidate, modes: [mode], extractionMode: mode };
}

function sourceScopeForImportCandidate(candidate: ImportSourceCandidate, override?: LtmScope) {
  return withMergedLtmScopeLinks({ ...(candidate.scope ?? {}), ...(override ?? {}) }, {});
}

function extractionFingerprintForImportCandidate(candidate: ImportSourceCandidate, scope: LtmScope) {
  return extractionFingerprintForLtmSourceMaterial({
    noteId: candidate.sourceNoteId,
    sourceText: candidate.sourceText,
    evidence: candidate.evidence,
    provenance: candidate.provenance,
    scope,
    modes: candidate.modes,
    extractionMode: candidate.extractionMode,
  });
}

export async function previewLongTermMemoryInterop(
  db: DB,
  source: LtmInteropSource,
  limit = 25,
  root?: string,
  scope?: LtmScope,
  mode?: LtmMode,
): Promise<LtmInteropPreviewResponse> {
  const candidates = (
    await interopImportCandidates(db, source, limit, undefined, source === "chats" ? scope : undefined)
  ).map((candidate) => withRequestedExtractionMode(candidate, mode));
  const storage = new LongTermMemoryStorage(root ?? getLongTermMemoryRoot());
  const existingNotes = await storage.getNotesByIds(
    candidates.flatMap((candidate) => [candidate.sourceNoteId, ...(candidate.legacySourceNoteIds ?? [])]),
  );
  const samples = candidates.map((candidate) => {
    const ids = [candidate.sourceNoteId, ...(candidate.legacySourceNoteIds ?? [])];
    const existing = ids.map((id) => existingNotes.get(id)).find((note): note is LtmNote => Boolean(note));
    const trimmed = candidate.sourceText.trim();
    const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    const preview = {
      sourceId: candidate.sourceId,
      title: candidate.title,
      mutationCount: candidate.response.mutations.length,
      summary: candidate.response.summary,
      snippet,
    };
    const extractionFingerprint = extractionFingerprintForImportCandidate(
      candidate,
      sourceScopeForImportCandidate(candidate, scope),
    );
    if (!existing) return { ...preview, status: "pending" as const, freshness: "new" as const };
    if (extractionFingerprintsEqual(existing.extractionFingerprint, extractionFingerprint)) {
      return {
        ...preview,
        status: "imported" as const,
        freshness: "current" as const,
        existingNoteId: existing.id,
        existingNoteTitle: existing.title?.trim() || candidate.title,
      };
    }
    return {
      ...preview,
      status: "pending" as const,
      freshness: "stale" as const,
      existingNoteId: existing.id,
      existingNoteTitle: existing.title?.trim() || candidate.title,
    };
  });
  return {
    source,
    scanned: candidates.length,
    draftable: samples.filter((sample) => sample.status === "pending").length,
    importedCount: samples.filter((sample) => sample.status === "imported").length,
    samples,
  };
}

export async function createLongTermMemoryInteropSourceNotes(
  db: DB,
  source: LtmInteropSource,
  options: LtmInteropImportOptions & { plan?: LtmInteropSourceNotePlan } = { sourceIds: [] },
  root = getLongTermMemoryRoot(),
): Promise<{
  source: LtmInteropSource;
  imported: LtmInteropSourceNoteImport[];
  writeFailures: LtmImportSourceWriteFailure[];
}> {
  return withLtmVaultLock(root, () =>
    withLtmDebugOperation(
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
        const plan = options.plan ?? (await planLongTermMemoryInteropSourceNotes(db, source, options));
        const storage = new LongTermMemoryStorage(root);
        const candidates = plan.candidates;
        const imported: LtmInteropSourceNoteImport[] = [];
        const writeFailures: LtmImportSourceWriteFailure[] = [];
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
          try {
            const now = nowIso();
            const scope = sourceScopeForImportCandidate(candidate, options.scope);
            const noteInput = {
              id: candidate.sourceNoteId,
              title: candidate.title,
              type: "source" as const,
              status: "active" as const,
              modes: candidate.modes,
              scope,
              tags: ["source_summary", candidate.sourceTag],
              keywords: [],
              links: [],
              provenance: candidate.provenance,
              sections: {
                source: {
                  ...textSection(candidate.sourceText, candidate.evidence),
                  updatedAt: now,
                },
              },
            };
            const noteIds = [...(candidate.legacySourceNoteIds ?? []), candidate.sourceNoteId];
            const existingNotes = await storage.getNotesByIds(noteIds);
            const existing = noteIds
              .map((noteId) => existingNotes.get(noteId))
              .find((note): note is LtmNote => Boolean(note));
            if (existing) {
              const canonicalExisting =
                existing.id === candidate.sourceNoteId
                  ? existing
                  : await storage.renameNoteId(existing.id, candidate.sourceNoteId, {
                      actor: "maintenance_api",
                      cause: "interop.source_identity_migration",
                      summary: `Migrated imported source identity for ${candidate.title}`,
                    });
              const titlePatch = canonicalExisting.title?.trim() ? {} : { title: candidate.title };
              const note = await storage.updateNote(
                canonicalExisting.id,
                {
                  status: "active",
                  ...titlePatch,
                  modes: noteInput.modes,
                  scope: noteInput.scope,
                  tags: Array.from(new Set([...canonicalExisting.tags, ...noteInput.tags])),
                  provenance: noteInput.provenance,
                  sections: { ...canonicalExisting.sections, ...noteInput.sections },
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
              }).catch((debugError) => {
                logger.warn(debugError, "[ltm] Failed to record refreshed import source %s", candidate.sourceId);
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
            }).catch((debugError) => {
              logger.warn(debugError, "[ltm] Failed to record created import source %s", candidate.sourceId);
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to write imported source note";
            writeFailures.push({
              sourceId: candidate.sourceId,
              title: candidate.title,
              sourceWriteStatus: "failed",
              extractionStatus: "not_started",
              retryable: true,
              error: { code: "source_write_failed", message },
            });
            await recordLtmDebugEvent({
              root,
              operationId,
              phase: "source_note",
              action: "source_note_write_failed",
              status: "error",
              source,
              sourceId: candidate.sourceId,
              sourceNoteId: candidate.sourceNoteId,
              error,
            }).catch((debugError) => {
              logger.warn(debugError, "[ltm] Failed to record import write failure for %s", candidate.sourceId);
            });
          }
        }

        return { source, imported, writeFailures };
      },
    ),
  );
}

export async function planLongTermMemoryInteropSourceNotes(
  db: DB,
  source: LtmInteropSource,
  options: LtmInteropImportOptions,
): Promise<LtmInteropSourceNotePlan> {
  const selected = new Set(options.sourceIds);
  const limit = Math.max(options.limit ?? options.sourceIds.length, options.sourceIds.length, 1);
  const resolved = await interopImportCandidates(
    db,
    source,
    limit,
    selected,
    source === "chats" ? options.scope : undefined,
  );
  const candidates = resolved
    .filter((candidate) => selected.has(candidate.sourceId))
    .map((candidate) => withRequestedExtractionMode(candidate, options.mode));
  const resolvedIds = new Set(candidates.map((candidate) => candidate.sourceId));
  return {
    source,
    requestedSourceIds: [...options.sourceIds],
    missingSourceIds: options.sourceIds.filter((sourceId) => !resolvedIds.has(sourceId)),
    requiresExtraction: candidates.some((candidate) => candidate.sourceTag !== "imported_game_journal"),
    candidates,
  };
}
