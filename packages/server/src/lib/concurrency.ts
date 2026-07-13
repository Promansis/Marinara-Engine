export async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  if (limit <= 0) throw new Error("Concurrency limit must be positive");

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let error: unknown = null;

  async function worker() {
    while (nextIndex < tasks.length && error === null) {
      const index = nextIndex++;
      const task = tasks[index];
      if (!task) continue;
      try {
        results[index] = await task();
      } catch (err) {
        error = err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);

  if (error !== null) throw error;
  return results;
}

/**
 * Serialize work for one durable resource while allowing unrelated keys to
 * continue independently. The map is intentionally supplied by the owner so
 * lock lifetime remains scoped to that subsystem.
 */
export async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
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
