// Test-only: which timers a piece of code leaves pending. `setTimeout` and `clearTimeout` are wrapped for as long as the watch lives; a timer is pending from its `setTimeout` until it fires
// or is cleared. A test asks for the pending timers of a given length, which names a loop by the interval it sleeps for (the free steps' poll, say) without reaching into it.

export interface TimerWatch {
  /** The lengths (ms) of the timers that are pending now and whose length is in `lengths`. */
  pendingOf(lengths: readonly number[]): number[];
  /** Puts the real `setTimeout` and `clearTimeout` back. Idempotent. */
  restore(): void;
}

export function watchTimers(): TimerWatch {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending = new Map<unknown, number>();
  let restored = false;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: unknown = realSet(
      (...inner: unknown[]) => {
        pending.delete(handle);
        handler(...inner);
      },
      ms,
      ...args,
    );
    pending.set(handle, ms ?? 0);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle);
    realClear(handle);
  }) as typeof clearTimeout;
  return {
    pendingOf: (lengths) => [...pending.values()].filter((ms) => lengths.includes(ms)),
    restore: () => {
      if (restored) return;
      restored = true;
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
