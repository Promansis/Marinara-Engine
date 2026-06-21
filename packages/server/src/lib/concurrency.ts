export async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
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
