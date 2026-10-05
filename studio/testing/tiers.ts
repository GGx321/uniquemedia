/**
 * Test tiers (CI-4): which of Studio's tests block a push, and which run somewhere else.
 *
 * One environment variable, STUDIO_TEST_TIER, read by both runners (`bun test` through studio/scripts/realWorkerTests.ts,
 * and `node --test` under Electron's Node through studio/scripts/electronNodeTests.ts):
 *
 *   unset         the blocking run: every ordinary test, and nothing tagged for another tier
 *   "perf"        the non-blocking perf run: only the `[perf]` tests, with their tight wall-clock budgets enforced
 *   "heavy"       the scheduled run: only the `[heavy]` tests (the slow ones that a push does not need)
 *   "quarantine"  the non-blocking quarantine run: only the `[quarantine]` tests (see quarantine.ts)
 *
 * A test of another tier carries its tag in its NAME, so the runners can select it with a plain name pattern, and a
 * reader of a CI log sees which tier it ran in. Nothing here is a way to delete a check: every tagged test still runs,
 * in the tier its tag names. The rules are in studio/testing/README.md.
 *
 * This file is runtime-neutral on purpose (no bun:test, no node:test): the bun helpers live in bunTiers.ts, and the
 * Node suites are bundled for Electron's Node and may not import Bun's test module.
 */

export const TIER_ENV = "STUDIO_TEST_TIER";

export const TIERS = ["perf", "heavy", "quarantine"] as const;
export type Tier = (typeof TIERS)[number];

type Env = Readonly<Record<string, string | undefined>>;

/** The tier this process was started for, or undefined for the blocking run. An unknown value throws: a typo must not quietly run the blocking suite. */
export function tierOf(env: Env = process.env): Tier | undefined {
  const value = env[TIER_ENV];
  if (value === undefined || value === "") return undefined;
  const tier = TIERS.find((candidate) => candidate === value);
  if (tier === undefined) throw new Error(`${TIER_ENV}=${value}: not a tier (${TIERS.join(", ")}, or unset for the blocking run)`);
  return tier;
}

/** For `node:test` files: runs `register` (which registers tests) only in the run of `tier`, so another run neither runs nor counts them. */
export function inTier(tier: Tier, register: () => void, env: Env = process.env): void {
  if (tierOf(env) === tier) register();
}

/** The tag that opens the name of every test of `tier`. */
export function tierTag(tier: Tier): string {
  return `[${tier}]`;
}

/**
 * What in a test file's source marks it as holding tests of `tier`: the tag written out in a test name (a node:test file,
 * or a `[perf]` budget test written by hand), or a call of the bunTiers.ts helper that adds the tag. The runners read the
 * source for these, so a tier run opens only the files that can have its tests, not all of Studio's.
 */
export function tierMarkers(tier: Tier): readonly string[] {
  const helpers: Record<Tier, readonly string[]> = {
    perf: ["perfTest(", "perfOnlyTest("],
    heavy: ["heavyTest("],
    quarantine: ["quarantinedTest(", "inQuarantineRun("],
  };
  return [tierTag(tier), ...helpers[tier]];
}

/** The tag as a regular expression, for `bun test --test-name-pattern` and `node --test-name-pattern`. */
export function tierPattern(tier: Tier): string {
  return `\\[${tier}\\]`;
}

/**
 * What a blocking run still enforces of a wall-clock budget: far above the budget (a loaded runner must not fail it), but
 * still a bound, so a runaway (catastrophic backtracking, a wait that never ends) fails the blocking run as before.
 */
export const BLOCKING_FLOOR_MS = 2_000;
export const BLOCKING_FACTOR = 4;

export interface BudgetOptions {
  /** Replaces the blocking run's bound, for a test whose blocking bound must stay under a number the budget cannot tell apart (a serial run's total). */
  blockingMs?: number;
  env?: Env;
}

/** The bound `assertBudget` enforces in this run: the budget itself in the perf run, the generous blocking bound everywhere else. */
export function budgetBound(budgetMs: number, options: BudgetOptions = {}): number {
  if (tierOf(options.env) === "perf") return budgetMs;
  return options.blockingMs ?? Math.max(BLOCKING_FLOOR_MS, BLOCKING_FACTOR * budgetMs);
}

export interface MedianOptions {
  /** Runs made and thrown away first: the first call of a function pays for compiling, lazy tables and cold caches, which is not what a budget is about. Default 2. */
  warmups?: number;
  /** Timed runs; the answer is their median. Default 7. */
  runs?: number;
  /** The clock in milliseconds; only a test of this helper replaces it. */
  now?: () => number;
}

/**
 * The median wall time of `run`, in milliseconds, after warm-up runs: the figure to hand `assertBudget`. One timed call measures
 * the machine's worst moment as much as the code (a cold JIT, a GC pause, a neighbour on a shared runner), so a single-shot
 * budget flakes. The median of several warmed runs ignores a few such moments, yet a code that is slow on EVERY run (a
 * quadratic join) still shows in full.
 */
export function medianElapsedMs(run: () => void, options: MedianOptions = {}): number {
  const { warmups = 2, runs = 7, now = () => performance.now() } = options;
  if (runs < 1) throw new Error("medianElapsedMs needs at least one run");
  for (let i = 0; i < warmups; i++) run();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = now();
    run();
    times.push(now() - started);
  }
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return times.length % 2 === 1 ? (times[middle] ?? 0) : ((times[middle - 1] ?? 0) + (times[middle] ?? 0)) / 2;
}

/**
 * A wall-clock budget for a test that is also a correctness test. The tight `budgetMs` is a measurement of the machine as
 * much as of the code, so only the perf run (which does not block) enforces it, and prints the number. Every other run
 * enforces `budgetBound`. The test must be tagged `[perf]` (perfTest in bunTiers.ts, or the tag in a node:test name), or
 * the perf run never selects it; studio/testing/tiers.test.ts checks that.
 */
export function assertBudget(elapsedMs: number, budgetMs: number, what: string, options: BudgetOptions = {}): void {
  const perf = tierOf(options.env) === "perf";
  if (perf) console.log(`perf: ${what}: ${elapsedMs.toFixed(1)} ms (budget ${budgetMs} ms)`);
  const bound = budgetBound(budgetMs, options);
  if (elapsedMs >= bound) throw new Error(`${what} took ${elapsedMs.toFixed(0)} ms, not under ${bound} ms${perf ? "" : ` (the perf budget is ${budgetMs} ms)`}`);
}
