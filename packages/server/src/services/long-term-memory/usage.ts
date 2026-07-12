import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import type { LtmBudgetedChunk } from "./budget.js";
import { quarantineLtmIndexArtifact } from "./index-quarantine.js";
import { isEnoent } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";

export type LtmChunkUsage = {
  chunkId: string;
  noteId: string;
  sectionKey: string;
  lastRetrievedAt: string;
  lastInjectedAt: string;
  retrievalCount: number;
  injectionCount: number;
  totalInjectedTokens: number;
};

export type LtmChatUsage = {
  chunks: Record<string, LtmChunkUsage>;
};

export type LtmUsageIndex = {
  version: 2;
  chats: Record<string, LtmChatUsage>;
  /** Read-only preservation for v1 records that lacked a chat owner. */
  legacyChunks?: Record<string, LtmChunkUsage>;
};

export type LtmInjectionReceiptChunk = {
  chunkId: string;
  noteId: string;
  sectionKey: string;
  tokenCount: number;
};

export type LtmInjectionReceipt = {
  version: 1;
  chatId: string;
  dispatchedAt: string;
  serializedTokenCount: number;
  chunks: LtmInjectionReceiptChunk[];
};

export interface RecordLongTermMemoryInjectionInput {
  chatId: string;
  chunks: LtmBudgetedChunk[];
  serializedTokenCount: number;
}

const writeLocks = new Map<string, Promise<void>>();

function emptyUsageIndex(): LtmUsageIndex {
  return { version: 2, chats: {} };
}

async function withWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  writeLocks.set(path, tail);

  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (writeLocks.get(path) === tail) writeLocks.delete(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function parseUsageEntry(value: unknown): LtmChunkUsage {
  if (!isRecord(value)) throw new Error("Malformed long-term memory usage entry.");
  const requiredStrings = ["chunkId", "noteId", "sectionKey", "lastRetrievedAt", "lastInjectedAt"] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      throw new Error(`Malformed long-term memory usage field ${key}.`);
    }
  }
  if (
    !Number.isFinite(Date.parse(value.lastRetrievedAt as string)) ||
    !Number.isFinite(Date.parse(value.lastInjectedAt as string))
  ) {
    throw new Error("Malformed long-term memory usage timestamp.");
  }
  for (const key of ["retrievalCount", "injectionCount", "totalInjectedTokens"] as const) {
    if (!isNonNegativeInteger(value[key])) throw new Error(`Malformed long-term memory usage field ${key}.`);
  }
  return {
    chunkId: value.chunkId as string,
    noteId: value.noteId as string,
    sectionKey: value.sectionKey as string,
    lastRetrievedAt: value.lastRetrievedAt as string,
    lastInjectedAt: value.lastInjectedAt as string,
    retrievalCount: value.retrievalCount as number,
    injectionCount: value.injectionCount as number,
    totalInjectedTokens: value.totalInjectedTokens as number,
  };
}

function parseChunkUsageRecord(value: unknown): Record<string, LtmChunkUsage> {
  if (!isRecord(value)) throw new Error("Malformed long-term memory usage chunk map.");
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, parseUsageEntry(entry)]));
}

function parseUsageIndex(value: unknown): LtmUsageIndex {
  if (!isRecord(value)) throw new Error("Malformed long-term memory usage index.");
  if (value.version === 1) {
    return {
      version: 2,
      chats: {},
      legacyChunks: parseChunkUsageRecord(value.chunks),
    };
  }
  if (value.version !== 2 || !isRecord(value.chats)) {
    throw new Error("Malformed long-term memory usage index version.");
  }

  const chats: Record<string, LtmChatUsage> = {};
  for (const [chatId, entry] of Object.entries(value.chats)) {
    if (!chatId.trim() || !isRecord(entry)) throw new Error("Malformed long-term memory chat usage.");
    chats[chatId] = { chunks: parseChunkUsageRecord(entry.chunks) };
  }
  const legacyChunks = value.legacyChunks === undefined ? undefined : parseChunkUsageRecord(value.legacyChunks);
  return { version: 2, chats, ...(legacyChunks && Object.keys(legacyChunks).length ? { legacyChunks } : {}) };
}

export function longTermMemoryUsagePath(root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).indexes, "usage.json");
}

export function longTermMemoryInjectionReceiptPath(chatId: string, root = getLongTermMemoryRoot()) {
  const key = createHash("sha256").update(chatId).digest("hex");
  return safeJoin(getLongTermMemoryDirectories(root).events, `receipts/${key}.json`);
}

async function recoverMalformedUsage(root: string, err: unknown) {
  const path = longTermMemoryUsagePath(root);
  logger.warn(err, "[ltm] Quarantining malformed usage data");
  await quarantineLtmIndexArtifact(root, path).catch((quarantineErr) => {
    logger.warn(quarantineErr, "[ltm] Failed to quarantine malformed usage data");
  });
  return emptyUsageIndex();
}

async function readUsageIndex(root: string) {
  try {
    return parseUsageIndex(await readJsonFile<unknown>(longTermMemoryUsagePath(root), emptyUsageIndex()));
  } catch (err) {
    return recoverMalformedUsage(root, err);
  }
}

function parseReceipt(value: unknown): LtmInjectionReceipt {
  if (!isRecord(value) || value.version !== 1 || typeof value.chatId !== "string" || !value.chatId.trim()) {
    throw new Error("Malformed long-term memory injection receipt.");
  }
  if (typeof value.dispatchedAt !== "string" || !Number.isFinite(Date.parse(value.dispatchedAt))) {
    throw new Error("Malformed long-term memory injection receipt timestamp.");
  }
  if (!isNonNegativeInteger(value.serializedTokenCount) || !Array.isArray(value.chunks)) {
    throw new Error("Malformed long-term memory injection receipt accounting.");
  }
  const chunks = value.chunks.map((chunk) => {
    if (!isRecord(chunk)) throw new Error("Malformed long-term memory receipt chunk.");
    if (
      typeof chunk.chunkId !== "string" ||
      !chunk.chunkId ||
      typeof chunk.noteId !== "string" ||
      !chunk.noteId ||
      typeof chunk.sectionKey !== "string" ||
      !chunk.sectionKey ||
      !isNonNegativeInteger(chunk.tokenCount)
    ) {
      throw new Error("Malformed long-term memory receipt chunk fields.");
    }
    return {
      chunkId: chunk.chunkId,
      noteId: chunk.noteId,
      sectionKey: chunk.sectionKey,
      tokenCount: chunk.tokenCount,
    };
  });
  return {
    version: 1,
    chatId: value.chatId,
    dispatchedAt: value.dispatchedAt,
    serializedTokenCount: value.serializedTokenCount,
    chunks,
  };
}

async function quarantineMalformedReceipt(root: string, chatId: string, path: string, err: unknown) {
  logger.warn(err, "[ltm] Quarantining malformed injection receipt for chat %s", chatId);
  const quarantinePath = safeJoin(
    getLongTermMemoryDirectories(root).root,
    `quarantine/receipts/${Date.now()}-${randomUUID()}.json`,
  );
  try {
    await mkdir(dirname(quarantinePath), { recursive: true });
    await rename(path, quarantinePath);
  } catch (quarantineErr) {
    if (!isEnoent(quarantineErr)) {
      logger.warn(quarantineErr, "[ltm] Failed to quarantine malformed injection receipt");
    }
  }
}

export async function readLongTermMemoryUsage(root = getLongTermMemoryRoot()) {
  return readUsageIndex(root);
}

export async function readLongTermMemoryInjectionReceipt(chatId: string, root = getLongTermMemoryRoot()) {
  const path = longTermMemoryInjectionReceiptPath(chatId, root);
  try {
    const raw = await readJsonFile<unknown>(path, null);
    if (raw === null) return null;
    const receipt = parseReceipt(raw);
    if (receipt.chatId !== chatId) {
      throw new Error("Long-term memory injection receipt chat ID does not match its receipt path.");
    }
    return receipt;
  } catch (err) {
    await quarantineMalformedReceipt(root, chatId, path, err);
    return null;
  }
}

function uniqueChunks(chunks: LtmBudgetedChunk[]) {
  const seen = new Set<string>();
  return chunks.filter((item) => {
    if (seen.has(item.chunk.id)) return false;
    seen.add(item.chunk.id);
    return true;
  });
}

export async function recordLongTermMemoryInjection(
  input: RecordLongTermMemoryInjectionInput,
  root = getLongTermMemoryRoot(),
): Promise<LtmInjectionReceipt | null> {
  const chatId = input.chatId.trim();
  const chunks = uniqueChunks(input.chunks);
  if (!chatId || chunks.length === 0) return null;

  const serializedTokenCount =
    typeof input.serializedTokenCount === "number" && Number.isFinite(input.serializedTokenCount)
      ? Math.max(0, Math.floor(input.serializedTokenCount))
      : 0;
  const now = new Date().toISOString();
  const usagePath = longTermMemoryUsagePath(root);
  const receiptPath = longTermMemoryInjectionReceiptPath(chatId, root);
  const receipt: LtmInjectionReceipt = {
    version: 1,
    chatId,
    dispatchedAt: now,
    serializedTokenCount,
    chunks: chunks.map((item) => ({
      chunkId: item.chunk.id,
      noteId: item.chunk.noteId,
      sectionKey: item.chunk.sectionKey,
      tokenCount: Math.max(0, Math.floor(item.estimatedTokens)),
    })),
  };

  await Promise.all([
    withWriteLock(usagePath, async () => {
      const usage = await readUsageIndex(root);
      const chatUsage = usage.chats[chatId] ?? { chunks: {} };
      for (const item of chunks) {
        const existing = chatUsage.chunks[item.chunk.id];
        chatUsage.chunks[item.chunk.id] = {
          chunkId: item.chunk.id,
          noteId: item.chunk.noteId,
          sectionKey: item.chunk.sectionKey,
          lastRetrievedAt: now,
          lastInjectedAt: now,
          retrievalCount: (existing?.retrievalCount ?? 0) + 1,
          injectionCount: (existing?.injectionCount ?? 0) + 1,
          totalInjectedTokens: (existing?.totalInjectedTokens ?? 0) + Math.max(0, Math.floor(item.estimatedTokens)),
        };
      }
      usage.chats[chatId] = chatUsage;
      await writeJsonAtomic(usagePath, usage);
    }),
    withWriteLock(receiptPath, () => writeJsonAtomic(receiptPath, receipt)),
  ]);

  return receipt;
}
