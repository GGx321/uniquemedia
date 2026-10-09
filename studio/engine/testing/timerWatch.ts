// Test-only: which timers a piece of code leaves pending. `setTimeout` and `clearTimeout` are wrapped for as long as the watch lives; a timer is pending from its `setTimeout` until it fires
// or is cleared. A test asks for the pending timers by the NAME of the function they run, which names a loop (the free steps' poll, say) without reaching into it and without mistaking another
// timer of the same length for it.

export interface TimerWatch {
  /** How many timers are pending now whose callback is a function named one of `names`. */
  pendingNamed(names: readonly string[]): number;
  /** Puts the real `setTimeout` and `clearTimeout` back. Idempotent. */
  restore(): void;
}

export function watchTimers(): TimerWatch {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending = new Map<unknown, string>();
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
    pending.set(handle, typeof handler === "function" ? handler.name : "");
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle);
    realClear(handle);
  }) as typeof clearTimeout;
  return {
    pendingNamed: (names) => [...pending.values()].filter((name) => names.includes(name)).length,
    restore: () => {
      if (restored) return;
      restored = true;
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
