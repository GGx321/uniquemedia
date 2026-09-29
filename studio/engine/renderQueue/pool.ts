import type { RenderConcurrency } from "../../shared/engine";

/**
 * One number for every job: what a render job holds at its peak (pass 2 was
 * measured at 640-688 MiB, SP1), plus about 10% for other content and the
 * Windows build. Never 0, so the pool's division below is safe.
 */
export const PEAK_RSS_BYTES = 768 * 1024 * 1024;

/** The largest pool «Авто» ever picks; the settings' fixed choices go to 8. */
const AUTO_POOL_MAX = 4;
const FIXED_POOL_MAX = 8;
/** A quarter of the machine's memory is what renders may take. */
const MEMORY_SHARE = 0.25;

export interface Machine {
  /** `os.availableParallelism()` or the CPU count; injected so the rule is pure. */
  readonly cores: number;
  /** `os.totalmem()`, in bytes. Not `freemem()`: macOS reports only free pages (1.5 GiB on a 36 GiB Mac). */
  readonly totalMem: number;
}

/** A count the machine reported, made usable: a NaN is 0. */
const count = (n: number): number => (Number.isNaN(n) ? 0 : n);

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * How many renders run at once.
 *
 * «Авто» is `min(clamp(floor((cores - 1) / 2), 1, 4), max(1, floor(0.25 * totalmem / peakRSS)))`:
 * half the cores (one is left for the app), at most 4, and no more jobs than a
 * quarter of the memory holds. The pool is never 0.
 *
 * A number is the owner's choice (Stage 4 unlocks it), clamped to 1..8 so a
 * value the contract would have refused still cannot stop the queue.
 */
export function renderPoolSize(setting: RenderConcurrency, machine: Machine): number {
  if (setting !== "auto") return clamp(Math.floor(count(setting)), 1, FIXED_POOL_MAX);
  const byCpu = clamp(Math.floor((count(machine.cores) - 1) / 2), 1, AUTO_POOL_MAX);
  const byMemory = Math.max(1, Math.floor((MEMORY_SHARE * count(machine.totalMem)) / PEAK_RSS_BYTES));
  return Math.min(byCpu, byMemory);
}
