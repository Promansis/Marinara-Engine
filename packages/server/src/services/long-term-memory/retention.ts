import { readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ltmEventSchema, ltmRetentionConfigSchema, type LtmRetentionConfig } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { DEFAULT_LTM_RETENTION_CONFIG } from "./default-config.js";
import { readLtmIndexPointer } from "./index-generation.js";
import { readLtmIndexState } from "./index-state.js";
import { isEnoent } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";
import { longTermMemoryUsagePath, parseLongTermMemoryInjectionReceipt, readLongTermMemoryUsage } from "./usage.js";
import { withLtmVaultLock } from "./vault-lock.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const lastRetentionRunAt = new Map<string, number>();

export type LtmRetentionResult = {
  ran: boolean;
  skippedPendingRecovery: boolean;
  skippedIncompleteGenerationCleanup: boolean;
  usageEntries: number;
  receipts: number;
  events: number;
  incompleteGenerations: number;
  quarantineArtifacts: number;
};

export type RunLtmRetentionOptions = {
  root?: string;
  now?: Date | string | number;
  config?: LtmRetentionConfig;
  force?: boolean;
};

function emptyResult(overrides: Partial<LtmRetentionResult> = {}): LtmRetentionResult {
  return {
    ran: false,
    skippedPendingRecovery: false,
    skippedIncompleteGenerationCleanup: false,
    usageEntries: 0,
    receipts: 0,
    events: 0,
    incompleteGenerations: 0,
    quarantineArtifacts: 0,
    ...overrides,
  };
}

function resolveNow(value: RunLtmRetentionOptions["now"]) {
  const now = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(now.getTime())) throw new Error("Long-term memory retention received an invalid current time.");
  return now;
}

function isExpired(value: string, cutoff: number) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < cutoff;
}

async function hasPendingRecovery(root: string) {
  const transactions = getLongTermMemoryDirectories(root).transactions;
  const entries = await readdir(transactions, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
}

async function pruneUsage(root: string, cutoff: number) {
  const usage = await readLongTermMemoryUsage(root);
  let removed = 0;

  for (const [chatId, chatUsage] of Object.entries(usage.chats)) {
    for (const [chunkId, entry] of Object.entries(chatUsage.chunks)) {
      if (!isExpired(entry.lastInjectedAt, cutoff)) continue;
      delete chatUsage.chunks[chunkId];
      removed += 1;
    }
    if (Object.keys(chatUsage.chunks).length === 0) delete usage.chats[chatId];
  }

  if (usage.legacyChunks) {
    for (const [chunkId, entry] of Object.entries(usage.legacyChunks)) {
      if (!isExpired(entry.lastInjectedAt, cutoff)) continue;
      delete usage.legacyChunks[chunkId];
      removed += 1;
    }
    if (Object.keys(usage.legacyChunks).length === 0) delete usage.legacyChunks;
  }

  if (removed > 0) await writeJsonAtomic(longTermMemoryUsagePath(root), usage);
  return removed;
}

async function pruneReceipts(root: string, cutoff: number) {
  const receipts = getLongTermMemoryDirectories(root).receipts;
  const entries = await readdir(receipts, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = safeJoin(receipts, entry.name);
    try {
      const receipt = parseLongTermMemoryInjectionReceipt(JSON.parse(await readFile(path, "utf8")));
      if (!isExpired(receipt.dispatchedAt, cutoff)) continue;
      await unlink(path);
      removed += 1;
    } catch (err) {
      // Corrupt receipts are forensic artifacts. Their normal read path owns
      // quarantine; retention must not erase evidence it cannot date safely.
      logger.warn(err, "[ltm] Retention kept an unreadable injection receipt at %s", path);
    }
  }
  return removed;
}

async function pruneEventLog(root: string, cutoff: number) {
  const path = getLongTermMemoryDirectories(root).eventLog;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw err;
  }

  let removed = 0;
  const retained = content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = ltmEventSchema.parse(JSON.parse(line));
      if (isExpired(event.ts, cutoff)) {
        removed += 1;
        return [];
      }
    } catch {
      // Integrity reporting owns malformed event rows. Keep them until a
      // maintainer repairs the vault rather than silently losing diagnostics.
    }
    return [line];
  });

  if (removed > 0) {
    await writeTextAtomic(path, retained.length > 0 ? `${retained.join("\n")}\n` : "");
  }
  return removed;
}

async function pruneExpiredQuarantineTree(path: string, cutoff: number): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  let removed = 0;

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      removed += await pruneExpiredQuarantineTree(child, cutoff);
      const remaining = await readdir(child).catch((err) => {
        if (isEnoent(err)) return null;
        throw err;
      });
      if (remaining?.length === 0 && (await stat(child)).mtimeMs < cutoff) {
        await rm(child, { recursive: true, force: true });
      }
      continue;
    }
    if (!entry.isFile() || (await stat(child)).mtimeMs >= cutoff) continue;
    await unlink(child);
    removed += 1;
  }
  return removed;
}

async function pruneIncompleteGenerations(root: string, cutoff: number) {
  const state = await readLtmIndexState(root);
  if (state.rebuildState === "building") return { removed: 0, skipped: true };

  let pointer;
  try {
    pointer = await readLtmIndexPointer(root);
  } catch (err) {
    logger.warn(err, "[ltm] Retention skipped incomplete generations because the current pointer is unreadable");
    return { removed: 0, skipped: true };
  }
  const protectedIds = new Set(pointer ? [pointer.generationId, ...(pointer.fallbackGenerationIds ?? [])] : []);
  const generations = safeJoin(getLongTermMemoryDirectories(root).indexes, "generations");
  const entries = await readdir(generations, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || protectedIds.has(entry.name)) continue;
    const path = safeJoin(generations, entry.name);
    const manifestPath = join(path, "manifest.json");
    const hasManifest = await stat(manifestPath)
      .then(() => true)
      .catch((err) => {
        if (isEnoent(err)) return false;
        throw err;
      });
    if (hasManifest || (await stat(path)).mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, skipped: false };
}

export function longTermMemoryRetentionConfigPath(root = getLongTermMemoryRoot()) {
  return safeJoin(getLongTermMemoryDirectories(root).config, "retention.json");
}

export async function readLongTermMemoryRetentionConfig(root = getLongTermMemoryRoot()) {
  return ltmRetentionConfigSchema.parse(
    await readJsonFile(longTermMemoryRetentionConfigPath(root), DEFAULT_LTM_RETENTION_CONFIG),
  );
}

/**
 * Retain only dated operational artifacts. Canonical notes, active/fallback
 * index generations, and pending mutation journals are never deletion inputs.
 */
export async function runLongTermMemoryRetention(options: RunLtmRetentionOptions = {}): Promise<LtmRetentionResult> {
  const root = options.root ?? getLongTermMemoryRoot();
  const now = resolveNow(options.now);
  if (!options.force && now.getTime() - (lastRetentionRunAt.get(root) ?? 0) < RETENTION_CHECK_INTERVAL_MS) {
    return emptyResult();
  }

  return withLtmVaultLock(root, async () => {
    if (await hasPendingRecovery(root)) {
      return emptyResult({ ran: true, skippedPendingRecovery: true, skippedIncompleteGenerationCleanup: true });
    }
    const config = ltmRetentionConfigSchema.parse(options.config ?? (await readLongTermMemoryRetentionConfig(root)));
    const usageEntries = await pruneUsage(root, now.getTime() - config.usageRetentionDays * DAY_MS);
    const receipts = await pruneReceipts(root, now.getTime() - config.receiptRetentionDays * DAY_MS);
    const events = await pruneEventLog(root, now.getTime() - config.eventRetentionDays * DAY_MS);
    const incomplete = await pruneIncompleteGenerations(
      root,
      now.getTime() - config.incompleteGenerationRetentionDays * DAY_MS,
    );
    const quarantineArtifacts = await pruneExpiredQuarantineTree(
      join(getLongTermMemoryDirectories(root).root, "quarantine"),
      now.getTime() - config.quarantineRetentionDays * DAY_MS,
    );
    lastRetentionRunAt.set(root, now.getTime());
    return {
      ran: true,
      skippedPendingRecovery: false,
      skippedIncompleteGenerationCleanup: incomplete.skipped,
      usageEntries,
      receipts,
      events,
      incompleteGenerations: incomplete.removed,
      quarantineArtifacts,
    };
  });
}
