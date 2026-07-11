import { ltmIndexStateSchema, type LtmIndexState } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { quarantineLtmIndexArtifact } from "./index-quarantine.js";
import { nowIso } from "./ltm-utils.js";
import { getLongTermMemoryDirectories, safeJoin } from "./paths.js";

const stateLocks = new Map<string, Promise<void>>();
const rebuildLocks = new Map<string, Promise<void>>();

async function withLock<T>(locks: Map<string, Promise<void>>, key: string, operation: () => Promise<T>) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  locks.set(key, tail);
  try {
    await previous.catch(() => {});
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function ltmIndexStatePath(root: string) {
  return safeJoin(getLongTermMemoryDirectories(root).indexes, "state.json");
}

async function readLtmIndexStateFromDisk(root: string) {
  return ltmIndexStateSchema.parse(await readJsonFile(ltmIndexStatePath(root), { version: 1 }));
}

async function recoverMalformedLtmIndexState(root: string, err: unknown) {
  const path = ltmIndexStatePath(root);
  logger.warn(err, "[ltm] Quarantining malformed index state");
  await quarantineLtmIndexArtifact(root, path);
  const recovered = ltmIndexStateSchema.parse({
    version: 1,
    revision: Date.now(),
    dirty: true,
    dirtyAt: nowIso(),
    rebuildState: "failed",
    rebuildCompletedAt: nowIso(),
    error: "Malformed long-term memory index state was quarantined; rebuild indexes.",
  });
  await writeJsonAtomic(path, recovered);
  return recovered;
}

async function readOrRecoverLtmIndexState(root: string) {
  try {
    return await readLtmIndexStateFromDisk(root);
  } catch (err) {
    return recoverMalformedLtmIndexState(root, err);
  }
}

export async function readLtmIndexState(root: string) {
  try {
    return await readLtmIndexStateFromDisk(root);
  } catch {
    return withLock(stateLocks, root, () => readOrRecoverLtmIndexState(root));
  }
}

async function updateLtmIndexState(root: string, update: (state: LtmIndexState) => LtmIndexState) {
  return withLock(stateLocks, root, async () => {
    const next = ltmIndexStateSchema.parse(update(await readOrRecoverLtmIndexState(root)));
    await writeJsonAtomic(ltmIndexStatePath(root), next);
    return next;
  });
}

export async function markLtmIndexesDirty(root: string) {
  return updateLtmIndexState(root, (state) => ({
    ...state,
    revision: state.revision + 1,
    dirty: true,
    dirtyAt: nowIso(),
  }));
}

export async function beginLtmIndexRebuild(root: string) {
  return updateLtmIndexState(root, (state) => ({
    ...state,
    rebuildState: "building",
    rebuildStartedAt: nowIso(),
    error: undefined,
  }));
}

export async function completeLtmIndexRebuild(root: string, expectedRevision: number, generationId: string) {
  return updateLtmIndexState(root, (state) => ({
    ...state,
    dirty: state.revision !== expectedRevision,
    dirtyAt: state.revision === expectedRevision ? undefined : state.dirtyAt ?? nowIso(),
    rebuildState: "idle",
    rebuildCompletedAt: nowIso(),
    lastPublishedGenerationId: generationId,
    error: undefined,
  }));
}

export async function failLtmIndexRebuild(root: string, error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = (raw.trim() || "Long-term memory index rebuild failed").slice(0, 2_000);
  return updateLtmIndexState(root, (state) => ({
    ...state,
    dirty: true,
    dirtyAt: state.dirtyAt ?? nowIso(),
    rebuildState: "failed",
    rebuildCompletedAt: nowIso(),
    error: message,
  }));
}

export async function withLtmIndexRebuildLock<T>(root: string, operation: () => Promise<T>) {
  return withLock(rebuildLocks, root, operation);
}
