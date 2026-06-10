import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import {
  ltmExtractionDraftSchema,
  ltmExtractionResponseSchema,
  ltmDraftStatusSchema,
  type LtmExtractionDraft,
  type LtmExtractionResponse,
  type LtmMode,
  type LtmNote,
  type LtmScope,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { LongTermMemoryStorage } from "./storage.js";

const EXTRACTION_MAX_TOKENS = 1800;
const MAX_CONTEXT_NOTE_CHARS = 12_000;

export interface LtmExtractionTurnInput {
  userMessage: string;
  assistantReply: string;
  scope?: LtmScope;
  modes: LtmMode[];
  source?: LtmExtractionDraft["source"];
  existingNotes?: LtmNote[];
}

export interface RunLtmExtractionOptions extends LtmExtractionTurnInput {
  provider: BaseLLMProvider;
  model: string;
  root?: string;
  signal?: AbortSignal;
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

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function parseExtractionJson(text: string) {
  return ltmExtractionResponseSchema.parse(JSON.parse(extractJsonObject(text)));
}

function formatExistingNotes(notes: LtmNote[]) {
  let used = 0;
  const lines: string[] = [];
  for (const note of notes) {
    const sectionLines = Object.entries(note.sections).map(([key, section]) => `${key}: ${section.text}`);
    const block = [
      `id: ${note.id}`,
      `type: ${note.type}`,
      `status: ${note.status}`,
      `tags: ${note.tags.join(", ") || "(none)"}`,
      `sections:\n${sectionLines.join("\n")}`,
    ].join("\n");
    if (used + block.length > MAX_CONTEXT_NOTE_CHARS) break;
    used += block.length;
    lines.push(block);
  }
  return lines.length ? lines.join("\n\n---\n\n") : "(no relevant notes)";
}

function buildExtractionMessages(input: LtmExtractionTurnInput): ChatMessage[] {
  const scope = input.scope ?? {};
  return [
    {
      role: "system",
      content: [
        "You extract draft long-term memory mutations for a local roleplay/chat memory vault.",
        "Return only strict JSON. Do not explain.",
        "Create drafts, not final writes. Favor no mutation when the turn contains no durable continuity.",
        "Use mutation ids as UUIDs.",
        "Allowed mutation kinds: create_note, append_section, update_section, add_link, set_status, flag_conflict.",
        "Low risk is only: scene append, neutral metadata/link, or high-confidence callback setup with no conflict.",
        "Keep secrets, character traits, relationship facts, and world facts medium/high risk.",
        "Evidence strings must reference the supplied message ids when present.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        outputShape: {
          summary: "short summary of proposed memory changes",
          mutations: [
            {
              id: "uuid",
              kind: "append_section",
              risk: "low|medium|high",
              confidence: 0.0,
              summary: "what changes",
              evidence: ["user:<id>", "assistant:<id>"],
            },
          ],
        },
        scope,
        modes: input.modes,
        source: input.source ?? {},
        existingNotes: formatExistingNotes(input.existingNotes ?? []),
        latestUserMessage: input.userMessage,
        assistantReply: input.assistantReply,
      }),
    },
  ];
}

export async function runLongTermMemoryExtraction(options: RunLtmExtractionOptions): Promise<LtmExtractionResponse> {
  const messages = buildExtractionMessages(options);
  const result = await options.provider.chatComplete(messages, {
    model: options.model,
    temperature: 0,
    maxTokens: options.provider.maxTokensOverrideValue ?? EXTRACTION_MAX_TOKENS,
    stream: false,
    signal: options.signal,
  });

  const content = result.content?.trim() ?? "";
  if (!content) return { summary: "", mutations: [] };
  return parseExtractionJson(content);
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
    const timestamp = nowIso();
    const draft = ltmExtractionDraftSchema.parse({
      id: randomUUID(),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: options.source ?? {},
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
      const draft = ltmExtractionDraftSchema.parse(
        JSON.parse(await readFile(safeJoin(this.dirs.drafts, entry.name), "utf8")),
      );
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
