import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import {
  ltmExtractionDraftSchema,
  ltmDraftStatusSchema,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmScope,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { LongTermMemoryStorage } from "./storage.js";

export interface LtmExtractionTurnInput {
  userMessage: string;
  assistantReply: string;
  scope?: LtmScope;
  modes: LtmMode[];
  source: LtmExtractionDraft["source"];
}

export interface StoreLtmDraftOptions extends LtmExtractionTurnInput {
  root?: string;
  summary?: string;
  response: LtmExtractionResponse;
}

export type LtmDraftListFilter = {
  status?: LtmExtractionDraft["status"];
  chatId?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function draftPathForId(id: string, root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).drafts, `${id}.json`);
}

export class LongTermMemoryDraftStore {
  readonly root: string;
  private readonly storage: LongTermMemoryStorage;

  constructor(root = getLongTermMemoryRoot()) {
    this.root = root;
    this.storage = new LongTermMemoryStorage(root);
  }

  private get dirs() {
    return getLongTermMemoryDirectories(this.root);
  }

  async initialize() {
    await this.storage.initializeLtmStore();
  }

  async createDraft(options: StoreLtmDraftOptions) {
    await this.initialize();
    if (!options.source?.sourceNoteId) {
      throw new Error("Long-term memory drafts must be tied to a source note.");
    }
    const timestamp = nowIso();
    const draft = ltmExtractionDraftSchema.parse({
      id: randomUUID(),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: options.source,
      scope: options.scope ?? {},
      modes: options.modes,
      summary: options.summary ?? options.response.summary ?? "",
      mutations: options.response.mutations,
    });
    await writeJsonAtomic(draftPathForId(draft.id, this.root), draft);
    logger.info("[ltm] Stored extraction draft %s with %d mutation(s)", draft.id, draft.mutations.length);
    return draft;
  }

  async listDrafts(filter: LtmDraftListFilter = {}) {
    await this.initialize();
    const entries = await readdir(this.dirs.drafts, { withFileTypes: true });
    const drafts: LtmExtractionDraft[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = JSON.parse(await readFile(safeJoin(this.dirs.drafts, entry.name), "utf8"));
      const parsed = ltmExtractionDraftSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn("Skipping invalid draft %s", entry.name);
        continue;
      }
      const draft = parsed.data;
      if (filter.status && draft.status !== filter.status) continue;
      if (filter.chatId && draft.source.chatId !== filter.chatId) continue;
      drafts.push(draft);
    }
    return drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async getDraft(id: string) {
    await this.initialize();
    return readJsonFile(draftPathForId(id, this.root), null).then((value) =>
      value ? ltmExtractionDraftSchema.parse(value) : null,
    );
  }

  async updateDraftStatus(id: string, status: LtmExtractionDraft["status"], patch: Partial<LtmExtractionDraft> = {}) {
    const parsedStatus = ltmDraftStatusSchema.parse(status);
    const draft = await this.getDraft(id);
    if (!draft) return null;
    const next = ltmExtractionDraftSchema.parse({
      ...draft,
      ...patch,
      status: parsedStatus,
      updatedAt: nowIso(),
    });
    await writeJsonAtomic(draftPathForId(id, this.root), next);
    return next;
  }

  async updateDraft(id: string, patch: Partial<Omit<LtmExtractionDraft, "id" | "createdAt" | "updatedAt">>) {
    const draft = await this.getDraft(id);
    if (!draft) return null;
    if (patch.status === "pending" && draft.status !== "pending" && draft.status !== "rejected") {
      throw new Error(`Long-term memory draft cannot be restored from ${draft.status}: ${id}`);
    }
    const next = ltmExtractionDraftSchema.parse({
      ...draft,
      ...patch,
      id: draft.id,
      createdAt: draft.createdAt,
      updatedAt: nowIso(),
      rejectedReason: patch.status === "pending" ? undefined : (patch.rejectedReason ?? draft.rejectedReason),
      appliedAt: patch.status === "pending" ? undefined : (patch.appliedAt ?? draft.appliedAt),
      appliedMutationIds:
        patch.status === "pending" ? undefined : (patch.appliedMutationIds ?? draft.appliedMutationIds),
      skippedMutationIds:
        patch.status === "pending" ? undefined : (patch.skippedMutationIds ?? draft.skippedMutationIds),
    });
    await writeJsonAtomic(draftPathForId(id, this.root), next);
    return next;
  }

  async deleteDraft(id: string) {
    await this.initialize();
    try {
      await unlink(draftPathForId(id, this.root));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
