import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import type { LtmBudgetedChunk } from "./budget.js";
import { getLongTermMemoryDirectories, getLongTermMemoryRoot, safeJoin } from "./paths.js";

type LtmChunkUsage = {
  chunkId: string;
  noteId: string;
  sectionKey: string;
  lastRetrievedAt: string;
  lastInjectedAt: string;
  retrievalCount: number;
  injectionCount: number;
  totalInjectedTokens: number;
};

type LtmUsageIndex = {
  version: 1;
  chunks: Record<string, LtmChunkUsage>;
};

const usageWriteLocks = new Map<string, Promise<void>>();

async function withUsageWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = usageWriteLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  usageWriteLocks.set(path, tail);

  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (usageWriteLocks.get(path) === tail) {
      usageWriteLocks.delete(path);
    }
  }
}

function usagePathForRoot(root: string) {
  return safeJoin(getLongTermMemoryDirectories(root).indexes, "usage.json");
}

function normalizeUsageIndex(value: unknown): LtmUsageIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, chunks: {} };
  }
  const raw = value as Partial<LtmUsageIndex>;
  return {
    version: 1,
    chunks: raw.chunks && typeof raw.chunks === "object" && !Array.isArray(raw.chunks) ? raw.chunks : {},
  };
}

export async function readLongTermMemoryUsage(root = getLongTermMemoryRoot()) {
  const path = usagePathForRoot(root);
  return normalizeUsageIndex(await readJsonFile<unknown>(path, { version: 1, chunks: {} }));
}

export async function recordLongTermMemoryInjection(chunks: LtmBudgetedChunk[], root = getLongTermMemoryRoot()) {
  if (chunks.length === 0) return;

  const path = usagePathForRoot(root);
  await withUsageWriteLock(path, async () => {
    const usage = normalizeUsageIndex(await readJsonFile<unknown>(path, { version: 1, chunks: {} }));
    const now = new Date().toISOString();

    for (const item of chunks) {
      const existing = usage.chunks[item.chunk.id];
      usage.chunks[item.chunk.id] = {
        chunkId: item.chunk.id,
        noteId: item.chunk.noteId,
        sectionKey: item.chunk.sectionKey,
        lastRetrievedAt: now,
        lastInjectedAt: now,
        retrievalCount: (existing?.retrievalCount ?? 0) + 1,
        injectionCount: (existing?.injectionCount ?? 0) + 1,
        totalInjectedTokens: (existing?.totalInjectedTokens ?? 0) + item.estimatedTokens,
      };
    }

    await writeJsonAtomic(path, usage);
  });
}
