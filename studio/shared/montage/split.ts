import { MIN_CLIP_MS, STEP_MS } from "./constants";

// Splitting a total length into clip durations.
//
// Every clip duration is a multiple of 100 ms (the contract), so the split is
// done in 100 ms UNITS: `units = total / 100`, every clip gets
// `floor(units / count)` units, and the `units % count` leftover units go one
// each to the FIRST clips. Hence the parts differ by at most 100 ms, the longer
// ones come first, and the result depends on nothing but the arguments.

/** `count` durations in ms that sum to `totalMs`, each a multiple of 100 ms and at least `MIN_CLIP_MS`. */
export function splitEvenly(totalMs: number, count: number): number[] {
  if (!Number.isSafeInteger(totalMs) || totalMs < 0 || totalMs % STEP_MS !== 0) throw new RangeError(`totalMs must be a whole multiple of ${STEP_MS}, got ${totalMs}`);
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`count must be a whole number of at least 1, got ${count}`);
  if (totalMs < count * MIN_CLIP_MS) throw new RangeError(`${totalMs} ms cannot hold ${count} clips of at least ${MIN_CLIP_MS} ms`);
  const units = totalMs / STEP_MS;
  const base = Math.floor(units / count);
  const extra = units % count;
  return Array.from({ length: count }, (_, i) => (base + (i < extra ? 1 : 0)) * STEP_MS);
}
