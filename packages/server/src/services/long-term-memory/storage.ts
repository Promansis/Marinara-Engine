import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../../lib/logger.js";
import { isEnoent, nowIso } from "./ltm-utils.js";
import {
  DEFAULT_LTM_GLOBAL_SETTINGS,
  LTM_NOTE_ID_PREFIXES_BY_TYPE,
  isLtmSourceLikeNote,
  ltmEventSchema,
  ltmExtractionDraftSchema,
  ltmGlobalSettingsSchema,
  ltmNoteIdSchema,
  ltmNoteSchema,
  ltmNoteTypeSchema,
  ltmPoliciesConfigSchema,
  ltmRetrievalConfigSchema,
  ltmDraftNoteInputSchema,
  getLtmScopeChatIds,
  matchesLtmScope,
  withMergedLtmScopeLinks,
  type LtmScope,
  type LtmEvent,
  type LtmNote,
  type LtmNoteType,
} from "@marinara-engine/shared";
import { appendJsonLineAtomic, createJsonFileExclusive, readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { DEFAULT_LTM_POLICIES, DEFAULT_LTM_RETRIEVAL_CONFIG } from "./default-config.js";
import { markLtmIndexesDirty } from "./index-state.js";
import { parseStoredLtmNote } from "./stored-note.js";
import {
  getLongTermMemoryDirectories,
  getLongTermMemoryRoot,
  LTM_VAULT_FOLDERS,
  notePathForId,
  safeJoin,
  vaultFolderForNoteType,
} from "./paths.js";

type LtmEventContext = {
  actor?: string;
  turn?: number;
  cause?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  suppressEvent?: boolean;
};

type PreparedDraftRewrite = {
  path: string;
  draft: unknown;
};

const noteWriteLocks = new Map<string, Promise<void>>();
const initLocks = new Map<string, Promise<void>>();

export type LtmListNotesFilter = {
  type?: LtmNoteType;
  status?: LtmNote["status"];
  tag?: string;
  scope?: LtmScope;
  characterIds?: string[];
  includeGlobal?: boolean;
};

export type LtmRemoveNoteScopeInput = {
  chatIds?: string[];
  groupId?: string;
  characterIds?: string[];
};

export type CreateLtmNoteInput = z.input<typeof ltmDraftNoteInputSchema>;

export type UpdateLtmNotePatch = Partial<Omit<LtmNote, "id" | "createdAt" | "updatedAt" | "version">>;



function normalizeStoredScope(scope: LtmScope) {
  return withMergedLtmScopeLinks(scope, {});
}

function normalizePatch(patch: UpdateLtmNotePatch) {
  const next = { ...patch };
  if ("title" in next && !next.title?.trim()) {
    delete next.title;
  }
  return next;
}

function normalizeRetrievalConfig(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  return {
    version: 1,
    maxChunks: input.maxChunks,
    maxTokens: input.maxTokens,
    semanticWeight: input.semanticWeight,
    lexicalWeight: input.lexicalWeight,
    graphWeight: input.graphWeight,
    keywordWeight: input.keywordWeight,
  };
}

function firstIdPrefixForType(type: LtmNoteType) {
  return LTM_NOTE_ID_PREFIXES_BY_TYPE[type][0];
}

function stripKnownIdPrefix(id: string) {
  const prefixes = Object.values(LTM_NOTE_ID_PREFIXES_BY_TYPE).flat();
  const matchingPrefix = prefixes
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((prefix) => id === prefix || id.startsWith(prefix));
  if (!matchingPrefix) return id;
  if (!matchingPrefix.endsWith("_")) return id;
  return id.slice(matchingPrefix.length);
}

function idForChangedType(id: string, type: LtmNoteType) {
  return ltmNoteIdSchema.parse(`${firstIdPrefixForType(type)}${stripKnownIdPrefix(id)}`);
}

function rewriteLinks(links: LtmNote["links"], fromId: string, toId: string) {
  return links.map((link) => (link.target === fromId ? { ...link, target: toId } : link));
}

function rewriteDraftMutationNoteIds(mutation: unknown, fromId: string, toId: string) {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) return mutation;
  const record = { ...(mutation as Record<string, unknown>) };
  if (record.noteId === fromId) record.noteId = toId;
  if (record.kind === "create_note" && record.note && typeof record.note === "object" && !Array.isArray(record.note)) {
    const note = { ...(record.note as Record<string, unknown>) };
    if (note.id === fromId) note.id = toId;
    if (Array.isArray(note.links)) note.links = rewriteLinks(note.links as LtmNote["links"], fromId, toId);
    record.note = note;
  }
  if (record.kind === "add_link" && record.link && typeof record.link === "object" && !Array.isArray(record.link)) {
    const link = { ...(record.link as Record<string, unknown>) };
    if (link.target === fromId) link.target = toId;
    record.link = link;
  }
  return record;
}

function eventFor(
  type: string,
  target: string | undefined,
  context: LtmEventContext = {},
  payload: Record<string, unknown> = {},
): LtmEvent {
  return ltmEventSchema.parse({
    id: randomUUID(),
    ts: nowIso(),
    type,
    target,
    actor: context.actor,
    turn: context.turn,
    cause: context.cause,
    summary: context.summary,
    payload: { ...(context.payload ?? {}), ...payload },
  });
}

async function withNoteWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = noteWriteLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  noteWriteLocks.set(path, tail);

  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (noteWriteLocks.get(path) === tail) {
      noteWriteLocks.delete(path);
    }
  }
}

function noteIdWriteLockKey(root: string, id: string) {
  return `${root}\0note:${id}`;
}

export class LongTermMemoryStorage {
  readonly root: string;

  constructor(root = getLongTermMemoryRoot()) {
    this.root = root;
  }

  private get dirs() {
    return getLongTermMemoryDirectories(this.root);
  }

  private async markIndexesDirty() {
    await markLtmIndexesDirty(this.root).catch((err) => {
      logger.warn(err, "[ltm] Failed to mark indexes dirty after a vault write");
    });
  }

  async initializeLtmStore() {
    const existingLock = initLocks.get(this.root);
    if (existingLock) {
      await existingLock;
      return;
    }

    const lock = this.initializeLtmStoreUnlocked().finally(() => {
      if (initLocks.get(this.root) === lock) {
        initLocks.delete(this.root);
      }
    });
    initLocks.set(this.root, lock);
    await lock;
  }

  private async initializeLtmStoreUnlocked() {
    const dirs = this.dirs;
    await Promise.all([
      mkdir(dirs.events, { recursive: true }),
      mkdir(dirs.indexes, { recursive: true }),
      mkdir(dirs.config, { recursive: true }),
      mkdir(dirs.drafts, { recursive: true }),
      ...LTM_VAULT_FOLDERS.map((folder) => mkdir(safeJoin(dirs.vault, folder), { recursive: true })),
    ]);

    const policiesPath = safeJoin(dirs.config, "policies.json");
    const retrievalPath = safeJoin(dirs.config, "retrieval.json");
    const settingsPath = safeJoin(dirs.config, "settings.json");
    const existingPolicies = ltmPoliciesConfigSchema.parse(await readJsonFile(policiesPath, DEFAULT_LTM_POLICIES));
    const existingRetrieval = ltmRetrievalConfigSchema.parse(
      normalizeRetrievalConfig(await readJsonFile(retrievalPath, DEFAULT_LTM_RETRIEVAL_CONFIG)),
    );
    const existingSettings = ltmGlobalSettingsSchema.parse(await readJsonFile(settingsPath, { version: 1 }));

    await writeJsonIfChanged(policiesPath, existingPolicies);
    await writeJsonIfChanged(retrievalPath, existingRetrieval);
    await writeJsonIfChanged(
      settingsPath,
      existingSettings.version === 1 ? existingSettings : DEFAULT_LTM_GLOBAL_SETTINGS,
    );
  }

  async listNotes(filter: LtmListNotesFilter = {}) {
    await this.initializeLtmStore();
    const dirs = this.dirs;
    const folders = filter.type ? [vaultFolderForNoteType(filter.type)] : LTM_VAULT_FOLDERS;
    const notes: LtmNote[] = [];

    for (const folder of folders) {
      const folderPath = safeJoin(dirs.vault, folder);
      const entries = await readdir(folderPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        let note: LtmNote;
        try {
          note = await this.readNoteFile(safeJoin(folderPath, entry.name), folder);
        } catch (err) {
          if (isEnoent(err)) continue;
          throw err;
        }
        if (filter.status && note.status !== filter.status) continue;
        if (filter.tag && !note.tags.includes(filter.tag)) continue;
        if (filter.scope || filter.characterIds?.length || filter.includeGlobal === false) {
          if (
            !matchesLtmScope(note, {
              scope: filter.scope,
              characterIds: filter.characterIds,
              includeGlobal: filter.includeGlobal,
            })
          ) {
            continue;
          }
        }
        notes.push(note);
      }
    }

    return notes.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getNote(id: string) {
    await this.initializeLtmStore();
    const noteId = ltmNoteIdSchema.parse(id);
    for (const folder of LTM_VAULT_FOLDERS) {
      const note = await this.readNoteByIdInFolder(noteId, folder);
      if (note) return note;
    }
    return null;
  }

  async getNotesByIds(ids: string[]) {
    await this.initializeLtmStore();
    const wantedIds = new Set(ids.map((id) => ltmNoteIdSchema.parse(id)));
    const notes = new Map<string, LtmNote>();
    if (wantedIds.size === 0) return notes;

    for (const folder of LTM_VAULT_FOLDERS) {
      const folderPath = safeJoin(this.dirs.vault, folder);
      const entries = await readdir(folderPath, { withFileTypes: true });
      const matchingEntries = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".json") && wantedIds.has(entry.name.slice(0, -5)),
      );
      for (const entry of matchingEntries) {
        let note: LtmNote;
        try {
          note = await this.readNoteFile(safeJoin(folderPath, entry.name), folder);
        } catch (err) {
          if (isEnoent(err)) continue;
          throw err;
        }
        if (!notes.has(note.id)) notes.set(note.id, note);
      }
      if (notes.size === wantedIds.size) break;
    }

    return notes;
  }

  async createNote(input: CreateLtmNoteInput, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const timestamp = nowIso();
    const note = ltmNoteSchema.parse({
      ...input,
      scope: normalizeStoredScope(input.scope ?? {}),
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
      version: input.version ?? 1,
    });
    const path = notePathForId(note.id, note.type, this.root);
    return withNoteWriteLock(noteIdWriteLockKey(this.root, note.id), async () => {
      const existing = await this.getNote(note.id);
      if (existing) {
        throw new Error(`Long-term memory note already exists: ${note.id}`);
      }

      if (!eventContext.suppressEvent) {
        await this.appendEvent(eventFor(`${note.type}.created`, note.id, eventContext, { note }));
      }
      await createJsonFileExclusive(path, note);
      await this.markIndexesDirty();
      return note;
    });
  }

  async updateNote(id: string, patch: UpdateLtmNotePatch, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    if (patch.type && patch.type !== existing.type) {
      const { type, ...restPatch } = patch;
      return this.changeNoteType(existing, type, restPatch, eventContext);
    }
    return this.writeNotePatch(existing, patch, `${existing.type}.updated`, eventContext);
  }

  async renameNoteId(id: string, nextId: string, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const currentId = ltmNoteIdSchema.parse(id);
    const parsedNextId = ltmNoteIdSchema.parse(nextId);
    if (currentId === parsedNextId) return this.getRequiredNote(currentId);

    const [firstId, secondId] = currentId < parsedNextId
      ? [currentId, parsedNextId]
      : [parsedNextId, currentId];
    return withNoteWriteLock(noteIdWriteLockKey(this.root, firstId), () =>
      withNoteWriteLock(noteIdWriteLockKey(this.root, secondId), async () => {
        const current = await this.getRequiredNote(currentId);
        if (await this.getNote(parsedNextId)) {
          throw new Error(`Long-term memory note already exists: ${parsedNextId}`);
        }

        const timestamp = nowIso();
        const next = ltmNoteSchema.parse({
          ...current,
          id: parsedNextId,
          links: rewriteLinks(current.links, currentId, parsedNextId),
          updatedAt: timestamp,
          version: current.version + 1,
        });
        const oldPath = notePathForId(currentId, current.type, this.root);
        const newPath = notePathForId(parsedNextId, current.type, this.root);
        const draftRewrites = await this.prepareDraftReferenceRewrites(currentId, parsedNextId);

        await createJsonFileExclusive(newPath, next);
        try {
          await unlink(oldPath);
        } catch (err) {
          await unlink(newPath).catch(() => {});
          throw err;
        }
        await this.writePreparedDraftRewrites(draftRewrites);
        await this.rewriteNoteReferences(currentId, parsedNextId, eventContext);
        if (!eventContext.suppressEvent) {
          await this.appendEvent(eventFor(`${current.type}.renamed`, parsedNextId, eventContext, {
            previousNoteId: currentId,
            note: next,
          }));
        }
        await this.markIndexesDirty();
        return next;
      }),
    );
  }

  async archiveNote(id: string, eventContext: LtmEventContext = {}) {
    return this.updateNote(id, { status: "archived" }, eventContext);
  }

  async archiveSourceNoteWithDerived(id: string, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    const relatedNotes = isLtmSourceLikeNote(existing) ? await this.listNotes() : [];
    const derived = relatedNotes.filter(
      (note) => note.id !== id && note.links.some((link) => link.relation === "extracted_from" && link.target === id),
    );
    const archiveContext = {
      ...eventContext,
      payload: {
        ...(eventContext.payload ?? {}),
        cascadeFromSourceNoteId: id,
      },
    };

    const archived: LtmNote[] = [];
    archived.push(await this.updateNote(existing.id, { status: "archived" }, eventContext));
    for (const note of derived) {
      archived.push(await this.updateNote(note.id, { status: "archived" }, archiveContext));
    }

    return archived;
  }

  async deleteNote(id: string, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    const path = notePathForId(existing.id, existing.type, this.root);
    return withNoteWriteLock(path, async () => {
      const current = await this.getRequiredNote(id);
      if (!eventContext.suppressEvent) {
        await this.appendEvent(eventFor(`${current.type}.deleted`, current.id, eventContext, { note: current }));
      }
      await unlink(path);
      await this.markIndexesDirty();
      return current;
    });
  }

  async deleteNotesPermanently(ids: string[], eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const wantedIds = [...new Set(ids.map((id) => ltmNoteIdSchema.parse(id)))];
    const existingNotes = await this.getNotesByIds(wantedIds);
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const deletedNotes: LtmNote[] = [];

    for (const id of wantedIds) {
      const existing = existingNotes.get(id);
      if (!existing) {
        failedIds.push(id);
        continue;
      }

      const path = notePathForId(existing.id, existing.type, this.root);
      const deleted = await withNoteWriteLock(path, async () => {
        const current = await this.readNoteByIdInFolder(existing.id, vaultFolderForNoteType(existing.type));
        if (!current) return null;
        if (!eventContext.suppressEvent) {
          await this.appendEvent(eventFor(`${current.type}.deleted`, current.id, eventContext, { note: current }));
        }
        try {
          await unlink(path);
        } catch (err) {
          if (isEnoent(err)) return null;
          throw err;
        }
        return current;
      });

      if (deleted) {
        deletedIds.push(deleted.id);
        deletedNotes.push(deleted);
      } else {
        failedIds.push(id);
      }
    }

    if (deletedIds.length > 0) await this.markIndexesDirty();

    return { deletedIds, failedIds, deletedNotes };
  }

  async removeNoteFromScope(
    id: string,
    scopeToRemove: LtmRemoveNoteScopeInput,
    eventContext: LtmEventContext = {},
  ): Promise<{ note: LtmNote | null; deleted: boolean; changed: boolean }> {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    const chatIdsToRemove = new Set(scopeToRemove.chatIds ?? []);
    const characterIdsToRemove = new Set(scopeToRemove.characterIds ?? []);

    const existingChatIds = getLtmScopeChatIds(existing.scope);
    const existingCharacterIds = existing.scope.characterIds ?? [];
    const remainingChatIds = existingChatIds.filter((chatId) => !chatIdsToRemove.has(chatId));
    const remainingCharacterIds = existingCharacterIds.filter(
      (characterId) => !characterIdsToRemove.has(characterId),
    );
    const removeGroupId = Boolean(scopeToRemove.groupId && existing.scope.groupId === scopeToRemove.groupId);
    const remainingGroupId = removeGroupId ? undefined : existing.scope.groupId;
    const changed =
      remainingChatIds.length !== existingChatIds.length ||
      remainingCharacterIds.length !== existingCharacterIds.length ||
      removeGroupId;

    if (!changed) return { note: existing, deleted: false, changed: false };

    // If removing the requested scope would leave the note with no scope at all,
    // permanently delete it instead of leaving an orphaned global note.
    if (remainingChatIds.length === 0 && !remainingGroupId && remainingCharacterIds.length === 0) {
      const deleted = await this.deleteNote(id, {
        ...eventContext,
        cause: eventContext.cause ?? "api.unscope",
        summary: eventContext.summary ?? "Removed from last scope via long-term memory API",
      });
      return { note: null, deleted: true, changed: true };
    }

    const nextScope: LtmScope = { ...existing.scope };
    if (remainingChatIds.length > 0) {
      nextScope.chatIds = remainingChatIds;
      nextScope.chatId = remainingChatIds[0];
    } else {
      delete nextScope.chatIds;
      delete nextScope.chatId;
    }
    if (remainingGroupId) nextScope.groupId = remainingGroupId;
    else delete nextScope.groupId;
    if (remainingCharacterIds.length > 0) nextScope.characterIds = remainingCharacterIds;
    else delete nextScope.characterIds;

    const note = await this.updateNote(id, { scope: nextScope }, {
      ...eventContext,
      cause: eventContext.cause ?? "api.unscope",
      summary: eventContext.summary ?? "Removed from scope via long-term memory API",
    });
    return { note, deleted: false, changed: true };
  }

  /**
   * Remove a note from the given chat scope(s). If the note has no remaining
   * scope after removal, it is permanently deleted instead.
   */
  async removeNoteFromChatScope(
    id: string,
    chatIdsToRemove: string[],
    eventContext: LtmEventContext = {},
  ): Promise<{ note: LtmNote | null; deleted: boolean; changed: boolean }> {
    return this.removeNoteFromScope(id, { chatIds: chatIdsToRemove }, eventContext);
  }

  async appendEvent(event: LtmEvent) {
    const parsed = ltmEventSchema.parse(event);
    await appendJsonLineAtomic(this.dirs.eventLog, parsed);
    return parsed;
  }

  async readEvents(options: { limit?: number; target?: string } = {}) {
    await this.initializeLtmStore();
    let content = "";
    try {
      content = await readFile(this.dirs.eventLog, "utf8");
    } catch (err) {
      if (!isEnoent(err)) {
        logger.warn(err, "[ltm] Failed to read events from %s", this.dirs.eventLog);
        throw err;
      }
      return [];
    }

    const events = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ltmEventSchema.parse(JSON.parse(line)))
      .filter((event) => !options.target || event.target === options.target);

    return typeof options.limit === "number" ? events.slice(-options.limit) : events;
  }

  private async getRequiredNote(id: string) {
    const note = await this.getNote(id);
    if (!note) {
      throw new Error(`Long-term memory note not found: ${id}`);
    }
    return note;
  }

  private async readNoteFile(path: string, folder: (typeof LTM_VAULT_FOLDERS)[number]) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if (isEnoent(err)) throw err;
      logger.warn(err, "[ltm] Failed to read note file %s", path);
      throw err;
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      logger.warn(err, "[ltm] Failed to parse note file %s", path);
      throw err;
    }

    let note: LtmNote;
    try {
      note = parseStoredLtmNote(raw);
    } catch (err) {
      logger.warn(err, "[ltm] Failed to parse note file %s", path);
      throw err;
    }

    if (vaultFolderForNoteType(note.type) !== folder) {
      logger.warn("[ltm] Note %s has type %s but stored in folder %s", note.id, note.type, folder);
      throw new Error(`Long-term memory note ${note.id} has type ${note.type} but is stored in ${folder}.`);
    }
    return note;
  }

  private async readNoteByIdInFolder(id: string, folder: (typeof LTM_VAULT_FOLDERS)[number]) {
    try {
      return await this.readNoteFile(safeJoin(this.dirs.vault, `${folder}/${id}.json`), folder);
    } catch (err) {
      if (isEnoent(err)) return null;
      logger.warn(err, "[ltm] Failed to read note %s in folder %s", id, folder);
      throw err;
    }
  }

  private async writeNotePatch(
    existing: LtmNote,
    patch: UpdateLtmNotePatch,
    eventType: string,
    eventContext: LtmEventContext,
  ) {
    const path = notePathForId(existing.id, existing.type, this.root);
    return withNoteWriteLock(path, async () => {
      const current = await this.getRequiredNote(existing.id);
      const timestamp = nowIso();
      const normalizedPatch = normalizePatch(patch);
      const titlePatch = "title" in patch ? { title: normalizedPatch.title } : {};
      const next = ltmNoteSchema.parse({
        ...current,
        ...normalizedPatch,
        ...titlePatch,
        scope: normalizeStoredScope(normalizedPatch.scope ?? current.scope),
        links: normalizedPatch.links ?? current.links,
        sections: normalizedPatch.sections ?? current.sections,
        conflicts: normalizedPatch.conflicts ?? current.conflicts,
        updatedAt: timestamp,
        version: current.version + 1,
      });

      if (!eventContext.suppressEvent) {
        await this.appendEvent(eventFor(eventType, existing.id, eventContext, { patch: normalizedPatch, note: next }));
      }
      await writeJsonAtomic(path, next);
      await this.markIndexesDirty();
      return next;
    });
  }

  private async changeNoteType(
    existing: LtmNote,
    type: LtmNoteType,
    patch: Omit<UpdateLtmNotePatch, "type">,
    eventContext: LtmEventContext,
  ) {
    const nextType = ltmNoteTypeSchema.parse(type);
    if (isLtmSourceLikeNote(existing) || nextType === "source") {
      throw new Error("Long-term memory source notes cannot change type.");
    }
    const nextId = idForChangedType(existing.id, nextType);
    if (nextId !== existing.id && (await this.getNote(nextId))) {
      throw new Error(`Long-term memory note already exists: ${nextId}`);
    }

    const oldPath = notePathForId(existing.id, existing.type, this.root);
    const newPath = notePathForId(nextId, nextType, this.root);
    const [firstPath, secondPath] = oldPath < newPath ? [oldPath, newPath] : [newPath, oldPath];
    return withNoteWriteLock(firstPath, () =>
      withNoteWriteLock(secondPath, async () => {
        const current = await this.getRequiredNote(existing.id);
        if (isLtmSourceLikeNote(current)) {
          throw new Error("Long-term memory source notes cannot change type.");
        }
        const timestamp = nowIso();
        const normalizedPatch = normalizePatch(patch);
        const titlePatch = "title" in patch ? { title: normalizedPatch.title } : {};
        const nextSubjects =
          nextType === "character"
            ? normalizedPatch.subjects?.length === 1
              ? normalizedPatch.subjects
              : current.subjects?.length === 1
                ? current.subjects
                : undefined
            : nextType === "relationship"
              ? normalizedPatch.subjects?.length === 2
                ? normalizedPatch.subjects
                : current.subjects?.length === 2
                  ? current.subjects
                  : undefined
              : undefined;
        const next = ltmNoteSchema.parse({
          ...current,
          ...normalizedPatch,
          ...titlePatch,
          id: nextId,
          type: nextType,
          scope: normalizeStoredScope(normalizedPatch.scope ?? current.scope),
          links: normalizedPatch.links
            ? rewriteLinks(normalizedPatch.links, current.id, nextId)
            : rewriteLinks(current.links, current.id, nextId),
          sections: normalizedPatch.sections ?? current.sections,
          conflicts: normalizedPatch.conflicts ?? current.conflicts,
          subjects: nextSubjects,
          updatedAt: timestamp,
          version: current.version + 1,
        });
        const draftRewrites = await this.prepareDraftReferenceRewrites(current.id, next.id);

        if (!eventContext.suppressEvent) {
          const moveContext = {
            ...eventContext,
            payload: {
              ...(eventContext.payload ?? {}),
              previousNoteId: current.id,
              previousType: current.type,
              draftRewriteCount: draftRewrites.length,
            },
          };
          await this.appendEvent(eventFor(`${current.type}.deleted`, current.id, moveContext, { note: current }));
          await this.appendEvent(
            eventFor(`${next.type}.created`, next.id, moveContext, {
              note: next,
              patch: { ...normalizedPatch, type: nextType },
            }),
          );
        }
        await createJsonFileExclusive(newPath, next);
        await unlink(oldPath);
        await this.writePreparedDraftRewrites(draftRewrites);
        await this.rewriteNoteReferences(current.id, next.id, eventContext);
        await this.markIndexesDirty();
        return next;
      }),
    );
  }

  private async rewriteNoteReferences(fromId: string, toId: string, eventContext: LtmEventContext) {
    const notes = await this.listNotes();
    let count = 0;
    for (const note of notes) {
      if (note.id === toId) continue;
      const links = rewriteLinks(note.links, fromId, toId);
      if (links.every((link, index) => link.target === note.links[index]?.target)) continue;
      await this.writeNotePatch(note, { links }, `${note.type}.updated`, {
        ...eventContext,
        summary: eventContext.summary ?? `Updated links for moved memory ${fromId}`,
        payload: {
          ...(eventContext.payload ?? {}),
          movedNoteId: fromId,
          replacementNoteId: toId,
        },
      });
      count += 1;
    }
    return count;
  }

  private async prepareDraftReferenceRewrites(fromId: string, toId: string): Promise<PreparedDraftRewrite[]> {
    const entries = await readdir(this.dirs.drafts, { withFileTypes: true });
    const rewrites: PreparedDraftRewrite[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = safeJoin(this.dirs.drafts, entry.name);
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      let changed = false;
      const next = { ...raw };
      if (next.source && typeof next.source === "object" && !Array.isArray(next.source)) {
        const source = { ...(next.source as Record<string, unknown>) };
        if (source.sourceNoteId === fromId) {
          source.sourceNoteId = toId;
          next.source = source;
          changed = true;
        }
      }
      if (Array.isArray(next.mutations)) {
        const mutations = next.mutations.map((mutation) => rewriteDraftMutationNoteIds(mutation, fromId, toId));
        changed ||= JSON.stringify(mutations) !== JSON.stringify(next.mutations);
        next.mutations = mutations;
      }
      if (!changed) continue;
      const parsed = ltmExtractionDraftSchema.parse({ ...next, updatedAt: nowIso() });
      rewrites.push({ path, draft: parsed });
    }
    return rewrites;
  }

  private async writePreparedDraftRewrites(rewrites: PreparedDraftRewrite[]) {
    for (const rewrite of rewrites) {
      await writeJsonAtomic(rewrite.path, rewrite.draft);
    }
  }
}

async function writeJsonIfChanged(path: string, value: unknown) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const current = await readFile(path, "utf8");
    if (current === next) return;
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn(err, "[ltm] Failed to read config for write-if-changed at %s", path);
      throw err;
    }
  }
  await writeJsonAtomic(path, value);
}

export async function initializeLtmStore(root?: string) {
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  return storage;
}
