import { createHash, randomUUID } from "node:crypto";
import {
  withMergedLtmScopeLinks,
  type ChatMode,
  type ChatSummaryEntry,
  type LtmMode,
  type LtmNote,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import { recordLtmDebugEvent, withLtmDebugOperation } from "./debug-log.js";
import { applyLongTermMemoryDraft } from "./reconciliation.js";
import { rebuildLongTermMemoryIndexes } from "./rebuild.js";
import { extractLongTermMemoryFromSourceNote } from "./source-extraction.js";
import { LongTermMemoryStorage } from "./storage.js";

export type SummaryLtmMetadataUpdater = (
  updater: (currentMeta: Record<string, unknown>) => Record<string, unknown>,
) => Promise<Record<string, unknown> | null | undefined>;

export type SummaryLtmSyncOptions = {
  rebuildIndexes?: boolean;
  updateMetadata?: SummaryLtmMetadataUpdater;
  extraction?: {
    provider: BaseLLMProvider;
    model: string;
    enabled?: boolean;
    applyLowRisk?: boolean;
    includeExistingNotes?: boolean;
    instruction?: string;
    signal?: AbortSignal;
  };
  operationId?: string;
};

export type SummaryLtmChat = {
  id: string;
  name?: string;
  mode: ChatMode;
  characterIds?: unknown;
  groupId?: string | null;
  metadata?: unknown;
};

const SOURCE_SUMMARY_LTM_TAG = "source_summary";
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
      ltmEnabled: entry.ltm?.enabled === true,
    }),
  );
}

function noteIdForSummaryEntry(chat: SummaryLtmChat, entry: ChatSummaryEntry) {
  return `source_summary_${safeIdentifierPart(chat.id)}_${safeIdentifierPart(entry.id)}`;
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
  return withMergedLtmScopeLinks(
    {
      ...(universe ? { universe } : {}),
      ...(rpId ? { rpId } : {}),
      chatId: chat.id,
      ...(chat.groupId ? { groupId: chat.groupId } : {}),
      ...(characterIds.length > 0 ? { characterIds } : {}),
    },
    { chatIds: [chat.id] },
  );
}

function tagsForEntry(entry: ChatSummaryEntry) {
  const tags = [SOURCE_SUMMARY_LTM_TAG, SUMMARY_LTM_TAG];
  tags.push(entry.origin === "automated" ? AGENT_SUMMARY_LTM_TAG : MANUAL_SUMMARY_LTM_TAG);
  return Array.from(new Set(tags));
}

function evidenceSafeValue(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 200);
}

function summaryMessageRange(entry: ChatSummaryEntry) {
  if (entry.sourceMode === "range" && entry.rangeStartIndex && entry.rangeEndIndex) {
    return `${entry.rangeStartIndex}-${entry.rangeEndIndex}`;
  }
  if (entry.rangeStartIndex && entry.rangeEndIndex) return `${entry.rangeStartIndex}-${entry.rangeEndIndex}`;
  if (entry.messageCount) return `last ${entry.messageCount}`;
  if (entry.sourceMode === "agent") return "agent summary";
  return "last messages";
}

function evidenceForEntry(chat: SummaryLtmChat, entry: ChatSummaryEntry) {
  return [
    `chat:${chat.id}`,
    ...(chat.name?.trim() ? [`chat_name:${evidenceSafeValue(chat.name)}`] : []),
    `summary_entry:${entry.id}`,
    `message_range:${summaryMessageRange(entry)}`,
  ];
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
    type: "source",
    status: "dormant",
    modes: [ltmModeForChatMode(chat.mode)],
    scope: resolveChatScope(chat, meta),
    tags: tagsForEntry(entry),
    createdAt: timestamp,
    updatedAt: timestamp,
    links: [],
    sections: {
      source: {
        text: entry.content.trim(),
        updatedAt: timestamp,
        evidence: evidenceForEntry(chat, entry),
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
  return withLtmDebugOperation(
    {
      operationId: options.operationId,
      phase: "summary_sync",
      action: "sync_summary_entry",
      source: "chat_summary",
      sourceId: entry.id,
      message: "Sync chat summary entry to long-term memory source note",
      details: { chatId: chat.id, enabled: entry.ltm?.enabled === true },
    },
    async (operationId) => syncChatSummaryEntryToLongTermMemoryInner(chat, entry, { ...options, operationId }),
  );
}

async function syncChatSummaryEntryToLongTermMemoryInner(
  chat: SummaryLtmChat,
  entry: ChatSummaryEntry,
  options: SummaryLtmSyncOptions & { operationId: string },
) {
  const shouldRebuild = options.rebuildIndexes !== false;
  const storage = new LongTermMemoryStorage();
  const meta = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : (chat.metadata ?? {});
  const noteId = entry.ltm?.noteId || noteIdForSummaryEntry(chat, entry);
  const sourceHash = sourceHashForEntry(entry);
  const enabled = entry.ltm?.enabled === true;
  let mutated = false;
  let nextLtm: NonNullable<ChatSummaryEntry["ltm"]> | null = null;

  try {
    if (!enabled) {
      if (entry.ltm?.noteId) {
        const existing = await storage.getNote(entry.ltm.noteId);
        if (existing && existing.status !== "archived") {
          await storage.archiveNote(entry.ltm.noteId, {
            actor: "summary_ltm_sync",
            cause: "summary_ltm_disabled",
            summary: "Archived chat summary source note",
          });
          await recordLtmDebugEvent({
            operationId: options.operationId,
            phase: "source_note",
            action: "summary_source_note_archived",
            status: "ok",
            source: "chat_summary",
            sourceId: entry.id,
            sourceNoteId: entry.ltm.noteId,
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
      if (mutated && shouldRebuild) {
        const result = await rebuildLongTermMemoryIndexes();
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "rebuild",
          action: "summary_sync_rebuild",
          status: "ok",
          source: "chat_summary",
          sourceId: entry.id,
          counts: { notes: result.noteCount, chunks: result.chunkCount },
        });
      }
      return { noteId, synced: false, mutated };
    }

    const nextNote = buildSummaryNote(chat, meta as Record<string, unknown>, entry, noteId);
    const existing = await storage.getNote(noteId);
    if (existing) {
      const nextSourceSection = nextNote.sections.source;
      if (!nextSourceSection) throw new Error(`Summary source note is missing source section: ${noteId}`);
      if (
        existing.type !== "source" &&
        existing.tags.some((tag) => tag === SOURCE_SUMMARY_LTM_TAG || tag === SUMMARY_LTM_TAG)
      ) {
        await storage.deleteNote(noteId, {
          actor: "summary_ltm_sync",
          cause: "summary_ltm_source_type_migrated",
          summary: "Migrated chat summary source note to source type",
          suppressEvent: true,
        });
        await storage.createNote(
          {
            ...nextNote,
            createdAt: existing.createdAt,
            sections: { ...existing.sections, source: nextSourceSection },
          },
          {
            actor: "summary_ltm_sync",
            cause: "summary_ltm_source_type_migrated",
            summary: "Migrated chat summary source note to source type",
          },
        );
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "source_note",
          action: "summary_source_note_type_migrated",
          status: "ok",
          source: "chat_summary",
          sourceId: entry.id,
          sourceNoteId: noteId,
          counts: { sourceChars: entry.content.trim().length },
        });
        mutated = true;
      } else {
        const sourceSectionNeedsUpdate =
          !existing.sections.source ||
          existing.sections.source.text !== nextSourceSection.text ||
          JSON.stringify(existing.sections.source.evidence ?? []) !== JSON.stringify(nextSourceSection.evidence ?? []);
        const nextSections = sourceSectionNeedsUpdate
          ? { ...existing.sections, source: nextSourceSection }
          : existing.sections;
        if (
          existing.status !== "dormant" ||
          JSON.stringify(existing.modes) !== JSON.stringify(nextNote.modes) ||
          JSON.stringify(existing.scope) !== JSON.stringify(nextNote.scope) ||
          JSON.stringify(existing.tags) !== JSON.stringify(nextNote.tags) ||
          sourceSectionNeedsUpdate
        ) {
          await storage.updateNote(
            noteId,
            {
              status: "dormant",
              modes: nextNote.modes,
              scope: nextNote.scope,
              tags: nextNote.tags,
              links: nextNote.links,
              sections: nextSections,
            },
            {
              actor: "summary_ltm_sync",
              cause: "summary_ltm_updated",
              summary: "Updated chat summary source note",
            },
          );
          await recordLtmDebugEvent({
            operationId: options.operationId,
            phase: "source_note",
            action: "summary_source_note_updated",
            status: "ok",
            source: "chat_summary",
            sourceId: entry.id,
            sourceNoteId: noteId,
            counts: { sourceChars: entry.content.trim().length },
          });
          mutated = true;
        }
      }
    } else {
      await storage.createNote(nextNote, {
        actor: "summary_ltm_sync",
        cause: "summary_ltm_created",
        summary: "Created chat summary source note",
      });
      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "source_note",
        action: "summary_source_note_created",
        status: "ok",
        source: "chat_summary",
        sourceId: entry.id,
        sourceNoteId: noteId,
        counts: { sourceChars: entry.content.trim().length },
      });
      mutated = true;
    }

    const ltm = {
      ...(entry.ltm ?? {}),
      enabled: true,
      noteId,
      syncedAt: new Date().toISOString(),
      sourceHash,
    };
    nextLtm = ltm;
    await persistEntryLtmState(options.updateMetadata, entry.id, nextLtm);
    if (mutated && shouldRebuild) {
      const result = await rebuildLongTermMemoryIndexes();
      await recordLtmDebugEvent({
        operationId: options.operationId,
        phase: "rebuild",
        action: "summary_sync_rebuild",
        status: "ok",
        source: "chat_summary",
        sourceId: entry.id,
        sourceNoteId: noteId,
        counts: { notes: result.noteCount, chunks: result.chunkCount },
      });
    }
    if (
      options.extraction?.enabled === true &&
      nextLtm.extractedSourceHash !== sourceHash &&
      options.extraction.provider
    ) {
      try {
        const extractionOperationId = randomUUID();
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "extraction",
          action: "summary_auto_extraction_started",
          status: "started",
          source: "chat_summary",
          sourceId: entry.id,
          sourceNoteId: noteId,
          details: { extractionOperationId },
        });
        const result = await extractLongTermMemoryFromSourceNote({
          noteId,
          provider: options.extraction.provider,
          model: options.extraction.model,
          scope: nextNote.scope,
          modes: nextNote.modes,
          instruction: options.extraction.instruction,
          includeExistingNotes: options.extraction.includeExistingNotes,
          signal: options.extraction.signal,
          operationId: extractionOperationId,
        });
        const applyResult =
          options.extraction.applyLowRisk && result.draft
            ? await applyLongTermMemoryDraft(result.draft.id, {
                actor: "summary_ltm_sync",
                autoApplyLowRiskOnly: true,
                autoApplyPolicy: "source_extraction",
                operationId: extractionOperationId,
              })
            : null;
        nextLtm = {
          ...nextLtm,
          extractedAt: new Date().toISOString(),
          extractedSourceHash: sourceHash,
          ...(result.draft ? { extractionDraftId: result.draft.id } : {}),
          appliedMutationIds: applyResult?.appliedMutationIds ?? [],
          skippedMutationIds: applyResult?.skippedMutationIds ?? [],
        };
        await persistEntryLtmState(options.updateMetadata, entry.id, nextLtm);
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "extraction",
          action: "summary_auto_extraction_finished",
          status: "ok",
          source: "chat_summary",
          sourceId: entry.id,
          sourceNoteId: noteId,
          draftId: result.draft?.id,
          counts: {
            diagnostics: result.diagnostics.length,
            mutations: result.response.mutations.length,
            appliedMutations: applyResult?.appliedMutationIds.length ?? 0,
            skippedMutations: applyResult?.skippedMutationIds.length ?? 0,
          },
        });
      } catch (err) {
        logger.warn(err, "[ltm] Failed to extract summary source note %s", noteId);
        await recordLtmDebugEvent({
          operationId: options.operationId,
          phase: "extraction",
          action: "summary_auto_extraction_failed",
          status: "error",
          source: "chat_summary",
          sourceId: entry.id,
          sourceNoteId: noteId,
          error: err,
        });
      }
    }
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
