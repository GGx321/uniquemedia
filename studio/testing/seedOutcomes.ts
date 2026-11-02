/**
 * A sweep over fixed seeds that also claims "the seeds between them took every path that matters". The claim is a test of its own, and
 * a test must not read what its siblings left behind: under `--randomize` (or alone, or in a shard) it would run first and see nothing.
 *
 * `seedOutcomes` makes each seed's walk a memoised function of the seed. A seed's test and the coverage test both call it; whichever
 * comes first runs the walk, the other reuses the result, so the coverage test sees every seed in any order and a walk never runs twice.
 */

/** What one walk collected, and the failure that stopped it (if any). The collection is whatever the walk gathered before it stopped. */
export interface SeedOutcome<T> {
  readonly collected: T;
  readonly failure: { readonly error: unknown } | undefined;
}

/**
 * `fresh` makes the empty collection of one walk; `walk` runs the seed and adds what it saw to it. A thrown error is kept in the outcome,
 * not thrown: the seed's own test rethrows it (`mustHold`), and the coverage test still gets what the seed collected.
 */
export function seedOutcomes<K, T>(fresh: () => T, walk: (key: K, collected: T) => Promise<void>): (key: K) => Promise<SeedOutcome<T>> {
  const cache = new Map<K, Promise<SeedOutcome<T>>>();
  return (key) => {
    const known = cache.get(key);
    if (known !== undefined) return known;
    const started = (async (): Promise<SeedOutcome<T>> => {
      const collected = fresh();
      try {
        await walk(key, collected);
        return { collected, failure: undefined };
      } catch (error) {
        return { collected, failure: { error } };
      }
    })();
    cache.set(key, started);
    return started;
  };
}

/** The collection of a walk that held; a walk that failed throws its own error, so the seed's test fails for the seed's reason. */
export async function mustHold<T>(outcome: Promise<SeedOutcome<T>>): Promise<T> {
  const settled = await outcome;
  if (settled.failure !== undefined) throw settled.failure.error;
  return settled.collected;
}
