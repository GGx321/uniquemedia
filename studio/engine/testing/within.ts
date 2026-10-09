// Test-only: a bound for a promise a test awaits. A promise that never settles (a drain whose loop was never woken, a render nobody ends) must turn into a failure that names what was awaited, never
// into a silent hang that only the CI job's own kill ends (the Windows shard that ran 900 s). The timer is cleared as soon as the promise settles, so no timer outlives the await.

export async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}
