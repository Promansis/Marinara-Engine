import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { withKeyedLock } from "../../lib/concurrency.js";

const vaultLocks = new Map<string, Promise<void>>();
const activeVaultRoots = new AsyncLocalStorage<Set<string>>();

function lockKey(root: string) {
  return resolve(root);
}

export function isLtmVaultLockHeld(root: string) {
  return activeVaultRoots.getStore()?.has(lockKey(root)) ?? false;
}

/**
 * Serializes durable vault operations for one root. Nested work keeps the
 * parent lock so a multi-file mutation, snapshot, or restore stays coherent.
 */
export async function withLtmVaultLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = lockKey(root);
  const activeRoots = activeVaultRoots.getStore();
  if (activeRoots?.has(key)) return operation();

  return withKeyedLock(vaultLocks, key, () => {
    const nextRoots = new Set(activeRoots);
    nextRoots.add(key);
    return activeVaultRoots.run(nextRoots, operation);
  });
}
