const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task with the same key has settled, whether
 * it succeeded or failed. The engine is one process, so a process-wide map
 * is enough to keep read-modify-write steps on one file from interleaving.
 */
export async function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(task);
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, settled);
  try {
    return await current;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}
