import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import {
  ltmEventSchema,
  ltmNoteIdSchema,
  ltmNoteSchema,
  ltmPoliciesConfigSchema,
  ltmRetrievalConfigSchema,
  withMergedLtmScopeLinks,
  type LtmScope,
  type LtmEvent,
  type LtmNote,
  type LtmNoteType,
} from "@marinara-engine/shared";
import { appendJsonLineAtomic, createJsonFileExclusive, readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { DEFAULT_LTM_POLICIES, DEFAULT_LTM_RETRIEVAL_CONFIG } from "./default-config.js";
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

const noteWriteLocks = new Map<string, Promise<void>>();
const initLocks = new Map<string, Promise<void>>();

export type LtmListNotesFilter = {
  type?: LtmNoteType;
  status?: LtmNote["status"];
  tag?: string;
};

export type CreateLtmNoteInput = Omit<LtmNote, "createdAt" | "updatedAt" | "version" | "previousHash"> &
  Partial<Pick<LtmNote, "createdAt" | "updatedAt" | "version" | "previousHash">>;

export type UpdateLtmNotePatch = Partial<
  Omit<LtmNote, "id" | "type" | "createdAt" | "updatedAt" | "version" | "previousHash">
>;

function nowIso() {
  return new Date().toISOString();
}

function hashNote(note: LtmNote) {
  return createHash("sha256").update(JSON.stringify(note)).digest("hex");
}

function normalizeStoredScope(scope: LtmScope) {
  return withMergedLtmScopeLinks(scope, {});
}

function isSourceLikeNote(note: LtmNote) {
  return (
    note.type === "source" ||
    (note.type === "scene" && (note.tags.includes("source_summary") || note.tags.includes("chat_summary")))
  );
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

export class LongTermMemoryStorage {
  readonly root: string;

  constructor(root = getLongTermMemoryRoot()) {
    this.root = root;
  }

  private get dirs() {
    return getLongTermMemoryDirectories(this.root);
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
    const existingPolicies = ltmPoliciesConfigSchema.parse(await readJsonFile(policiesPath, DEFAULT_LTM_POLICIES));
    const existingRetrieval = ltmRetrievalConfigSchema.parse(
      await readJsonFile(retrievalPath, DEFAULT_LTM_RETRIEVAL_CONFIG),
    );

    await writeJsonIfChanged(policiesPath, existingPolicies);
    await writeJsonIfChanged(retrievalPath, existingRetrieval);
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
        const note = await this.readNoteFile(safeJoin(folderPath, entry.name), folder);
        if (filter.status && note.status !== filter.status) continue;
        if (filter.tag && !note.tags.includes(filter.tag)) continue;
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
        const note = await this.readNoteFile(safeJoin(folderPath, entry.name), folder);
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
      scope: normalizeStoredScope(input.scope),
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
      version: input.version ?? 1,
    });
    const path = notePathForId(note.id, note.type, this.root);
    return withNoteWriteLock(path, async () => {
      const existing = await this.getNote(note.id);
      if (existing) {
        throw new Error(`Long-term memory note already exists: ${note.id}`);
      }

      if (!eventContext.suppressEvent) {
        await this.appendEvent(eventFor(`${note.type}.created`, note.id, eventContext, { note }));
      }
      await createJsonFileExclusive(path, note);
      return note;
    });
  }

  async updateNote(id: string, patch: UpdateLtmNotePatch, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    return this.writeNotePatch(existing, patch, `${existing.type}.updated`, eventContext);
  }

  async archiveNote(id: string, eventContext: LtmEventContext = {}) {
    return this.updateNote(id, { status: "archived" }, eventContext);
  }

  async archiveSourceNoteWithDerived(id: string, eventContext: LtmEventContext = {}) {
    await this.initializeLtmStore();
    const existing = await this.getRequiredNote(id);
    const relatedNotes = isSourceLikeNote(existing) ? await this.listNotes() : [];
    const derived = relatedNotes.filter(
      (note) =>
        note.id !== id &&
        note.links.some((link) => link.relation === "extracted_from" && link.target === id),
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
      return current;
    });
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    const raw = JSON.parse(await readFile(path, "utf8"));
    const note = ltmNoteSchema.parse({
      ...raw,
      scope: normalizeStoredScope(raw.scope ?? {}),
    });
    if (vaultFolderForNoteType(note.type) !== folder) {
      throw new Error(`Long-term memory note ${note.id} has type ${note.type} but is stored in ${folder}.`);
    }
    return note;
  }

  private async readNoteByIdInFolder(id: string, folder: (typeof LTM_VAULT_FOLDERS)[number]) {
    try {
      return await this.readNoteFile(safeJoin(this.dirs.vault, `${folder}/${id}.json`), folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
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
      const next = ltmNoteSchema.parse({
        ...current,
        ...patch,
        scope: normalizeStoredScope(patch.scope ?? current.scope),
        links: patch.links ?? current.links,
        sections: patch.sections ?? current.sections,
        conflicts: patch.conflicts ?? current.conflicts,
        updatedAt: timestamp,
        version: current.version + 1,
        previousHash: hashNote(current),
      });

      if (!eventContext.suppressEvent) {
        await this.appendEvent(eventFor(eventType, existing.id, eventContext, { patch, note: next }));
      }
      await writeJsonAtomic(path, next);
      return next;
    });
  }
}

async function writeJsonIfChanged(path: string, value: unknown) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const current = await readFile(path, "utf8");
    if (current === next) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeJsonAtomic(path, value);
}

export async function initializeLtmStore(root?: string) {
  const storage = new LongTermMemoryStorage(root);
  await storage.initializeLtmStore();
  return storage;
}
