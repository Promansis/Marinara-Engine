import { createHash } from "node:crypto";
import { type ChatMode, type ChatSummaryEntry, type LtmMode, type LtmNote } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { LongTermMemoryStorage } from "./storage.js";

export type SummaryLtmMetadataUpdater = (
  updater: (currentMeta: Record<string, unknown>) => Record<string, unknown>,
) => Promise<Record<string, unknown> | null | undefined>;

export type SummaryLtmSyncOptions = {
  rebuildIndexes?: boolean;
  updateMetadata?: SummaryLtmMetadataUpdater;
};

export type SummaryLtmChat = {
  id: string;
  mode: ChatMode;
  characterIds?: unknown;
  groupId?: string | null;
  metadata?: unknown;
};

const SUMMARY_LTM_TAG = "chat_summary";
const MANUAL_SUMMARY_LTM_TAG = "summary_manual";
const AGENT_SUMMARY_LTM_TAG = "summary_agent";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeIdentifierPart(value: string) {
  const hash = sha256(value).slice(0, 16);
  return hash.replace(/^[^a-z]+/, "a") || "a";
}

function sourceHashForEntry(entry: ChatSummaryEntry) {
  return sha256(
    JSON.stringify({
      id: entry.id,
      content: entry.content,
      title: entry.title,
      enabled: entry.enabled,
      ltmEnabled: entry.ltm?.enabled === true,
    }),
  );
}

function noteIdForSummaryEntry(chat: SummaryLtmChat, entry: ChatSummaryEntry) {
  return `scene_summary_${safeIdentifierPart(chat.id)}_${safeIdentifierPart(entry.id)}`;
}

function ltmModeForChatMode(mode: ChatMode): LtmMode {
  return mode;
}

function isLtmIdentifier(value: string) {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value);
}

function normalizeCharacterIds(value: unknown): string[] {
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

function resolveChatScope(chat: SummaryLtmChat, meta: Record<string, unknown>): LtmNote["scope"] {
  const configured =
    meta.longTermMemoryScope && typeof meta.longTermMemoryScope === "object" && !Array.isArray(meta.longTermMemoryScope)
      ? (meta.longTermMemoryScope as Record<string, unknown>)
      : {};
  const universe =
    typeof configured.universe === "string" && isLtmIdentifier(configured.universe) ? configured.universe : undefined;
  const rpId = typeof configured.rpId === "string" && isLtmIdentifier(configured.rpId) ? configured.rpId : undefined;
  const characterIds = normalizeCharacterIds(chat.characterIds);
  return {
    ...(universe ? { universe } : {}),
    ...(rpId ? { rpId } : {}),
    chatId: chat.id,
    ...(chat.groupId ? { groupId: chat.groupId } : {}),
    ...(characterIds.length > 0 ? { characterIds } : {}),
  };
}

function tagsForEntry(entry: ChatSummaryEntry) {
  const tags = [SUMMARY_LTM_TAG];
  tags.push(entry.origin === "automated" ? AGENT_SUMMARY_LTM_TAG : MANUAL_SUMMARY_LTM_TAG);
  return Array.from(new Set(tags));
}

function buildSummaryNote(
  chat: SummaryLtmChat,
  meta: Record<string, unknown>,
  entry: ChatSummaryEntry,
  noteId: string,
): LtmNote {
  const timestamp = new Date().toISOString();
  return {
    id: noteId,
    type: "scene",
    status: "active",
    modes: [ltmModeForChatMode(chat.mode)],
    scope: resolveChatScope(chat, meta),
    tags: tagsForEntry(entry),
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      summary: {
        text: entry.content.trim(),
        updatedAt: timestamp,
        evidence: [`chat:${chat.id}`, `summary_entry:${entry.id}`],
      },
    },
    version: 1,
  };
}

function updateEntryLtmState(
  entries: ChatSummaryEntry[],
  entryId: string,
  ltm: NonNullable<ChatSummaryEntry["ltm"]>,
): ChatSummaryEntry[] {
  return entries.map((entry) => (entry.id === entryId ? { ...entry, ltm } : entry));
}

async function persistEntryLtmState(
  updateMetadata: SummaryLtmMetadataUpdater | undefined,
  entryId: string,
  ltm: NonNullable<ChatSummaryEntry["ltm"]>,
) {
  if (!updateMetadata) return;
  await updateMetadata((currentMeta) => {
    const entries = Array.isArray(currentMeta.summaryEntries) ? (currentMeta.summaryEntries as ChatSummaryEntry[]) : [];
    return {
      summaryEntries: updateEntryLtmState(entries, entryId, ltm),
    };
  });
}

export async function syncChatSummaryEntryToLongTermMemory(
  chat: SummaryLtmChat,
  entry: ChatSummaryEntry,
  options: SummaryLtmSyncOptions = {},
) {
  const shouldRebuild = options.rebuildIndexes !== false;
  const storage = new LongTermMemoryStorage();
  const meta = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : (chat.metadata ?? {});
  const noteId = entry.ltm?.noteId || noteIdForSummaryEntry(chat, entry);
  const sourceHash = sourceHashForEntry(entry);
  const enabled = entry.enabled === true && entry.ltm?.enabled === true;
  let mutated = false;

  try {
    if (!enabled) {
      if (entry.ltm?.noteId) {
        const existing = await storage.getNote(entry.ltm.noteId);
        if (existing && existing.status !== "archived") {
          await storage.archiveNote(entry.ltm.noteId, {
            actor: "summary_ltm_sync",
            cause: "summary_ltm_disabled",
            summary: "Archived chat summary LTM note",
          });
          mutated = true;
        }
      }
      await persistEntryLtmState(options.updateMetadata, entry.id, {
        enabled: false,
        noteId,
        syncedAt: new Date().toISOString(),
        sourceHash,
      });
      if (mutated && shouldRebuild) await rebuildLongTermMemoryIndexes();
      return { noteId, synced: false, mutated };
    }

    const nextNote = buildSummaryNote(chat, meta as Record<string, unknown>, entry, noteId);
    const existing = await storage.getNote(noteId);
    if (existing) {
      if (
        existing.status !== "active" ||
        JSON.stringify(existing.modes) !== JSON.stringify(nextNote.modes) ||
        JSON.stringify(existing.scope) !== JSON.stringify(nextNote.scope) ||
        JSON.stringify(existing.tags) !== JSON.stringify(nextNote.tags) ||
        existing.sections.summary?.text !== nextNote.sections.summary?.text ||
        JSON.stringify(existing.sections.summary?.evidence ?? []) !==
          JSON.stringify(nextNote.sections.summary?.evidence ?? [])
      ) {
        await storage.updateNote(
          noteId,
          {
            status: "active",
            modes: nextNote.modes,
            scope: nextNote.scope,
            tags: nextNote.tags,
            links: nextNote.links,
            sections: nextNote.sections,
          },
          {
            actor: "summary_ltm_sync",
            cause: "summary_ltm_updated",
            summary: "Updated chat summary LTM note",
          },
        );
        mutated = true;
      }
    } else {
      await storage.createNote(nextNote, {
        actor: "summary_ltm_sync",
        cause: "summary_ltm_created",
        summary: "Created chat summary LTM note",
      });
      mutated = true;
    }

    const ltm = {
      enabled: true,
      noteId,
      syncedAt: new Date().toISOString(),
      sourceHash,
    };
    await persistEntryLtmState(options.updateMetadata, entry.id, ltm);
    if (mutated && shouldRebuild) await rebuildLongTermMemoryIndexes();
    return { noteId, synced: true, mutated };
  } catch (err) {
    logger.warn(err, "[ltm] Failed to sync chat summary entry %s", entry.id);
    const ltm = {
      enabled,
      noteId,
      sourceHash,
    };
    await persistEntryLtmState(options.updateMetadata, entry.id, ltm);
    throw err;
  }
}

export async function syncChatSummaryEntriesToLongTermMemory(
  chat: SummaryLtmChat,
  entries: ChatSummaryEntry[],
  options: SummaryLtmSyncOptions = {},
) {
  const results = [];
  let mutated = false;
  for (const entry of entries) {
    const result = await syncChatSummaryEntryToLongTermMemory(chat, entry, {
      ...options,
      rebuildIndexes: false,
    });
    results.push(result);
    mutated = mutated || result.mutated;
  }
  if (mutated && options.rebuildIndexes !== false) {
    await rebuildLongTermMemoryIndexes();
  }
  return { results, mutated };
}

export function markSummaryEntryForLtmIfEnabled(
  meta: Record<string, unknown>,
  entry: ChatSummaryEntry,
): ChatSummaryEntry {
  if (meta.summaryLongTermMemoryEnabled !== true) return entry;
  if (entry.ltm?.enabled === true) return entry;
  return {
    ...entry,
    ltm: {
      ...(entry.ltm ?? {}),
      enabled: true,
    },
  };
}

export function createLtmMetadataUpdaterFromPatchMetadata(
  patchMetadata: (
    updater: (currentMeta: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<{ metadata?: unknown } | Record<string, unknown> | null | undefined>,
): SummaryLtmMetadataUpdater {
  return async (updater) => {
    const updated = await patchMetadata(updater);
    if (!updated) return null;
    if ("metadata" in updated) {
      return typeof updated.metadata === "string"
        ? JSON.parse(updated.metadata)
        : ((updated.metadata ?? {}) as Record<string, unknown>);
    }
    return updated as Record<string, unknown>;
  };
}
