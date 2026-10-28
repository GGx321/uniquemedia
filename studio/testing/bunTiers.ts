import { test } from "bun:test";
import { inQuarantineRun } from "./quarantine";
import { tierOf, tierTag, type Tier } from "./tiers";

/**
 * `bun test` helpers for the tiers (tiers.ts has the rules). A test of another tier is skipped, never dropped: in the
 * blocking run it shows as skipped, and the run of its own tier selects it by the tag in its name.
 */

type Body = Parameters<typeof test>[1];
type Timeout = Parameters<typeof test>[2];

function named(tier: Tier, name: string): string {
  return `${tierTag(tier)} ${name}`;
}

/**
 * A test that runs in EVERY run and also carries a tight wall-clock budget (`assertBudget` in tiers.ts): the blocking
 * run checks its correctness and a generous bound, the perf run enforces the budget and prints the number.
 */
export function perfTest(name: string, fn: Body, timeout?: Timeout): void {
  test(named("perf", name), fn, timeout);
}

/** A test that is only a measurement: it runs in the perf run and is skipped everywhere else. */
export function perfOnlyTest(name: string, fn: Body, timeout?: Timeout): void {
  test.skipIf(tierOf() !== "perf")(named("perf", name), fn, timeout);
}

/** A slow test a push does not need: it runs in the scheduled heavy run and is skipped everywhere else. */
export function heavyTest(name: string, fn: Body, timeout?: Timeout): void {
  test.skipIf(tierOf() !== "heavy")(named("heavy", name), fn, timeout);
}

/** The two parameter sets of a sweep: what a push runs (small, still a real sample) and what the heavy run runs (the full sweep, as it was before the diet). */
export interface SweepParams<T> {
  push: T;
  heavy: T;
}

export interface SweepVariant<T> {
  name: string;
  params: T;
  enabled: boolean;
}

/** The two tests a sweep registers in the run of `tier`: the push variant under the plain name, the heavy one tagged `[heavy]` and enabled only in the heavy run. */
export function sweepVariants<T>(name: string, params: SweepParams<T>, tier: Tier | undefined): [SweepVariant<T>, SweepVariant<T>] {
  return [
    { name, params: params.push, enabled: true },
    { name: named("heavy", name), params: params.heavy, enabled: tier === "heavy" },
  ];
}

/**
 * A sweep (seeds x sizes x categories, a fuzz, a brute force) written once and run at two sizes: a push runs `fn(params.push)` under the plain
 * name, the scheduled heavy run runs `fn(params.heavy)` under a `[heavy]` name. The heavy parameters are the sweep as it was before it was
 * made cheaper for a push, so nothing is dropped, only moved. Keep the push set a real sample (a few seeds, the sizes 1, 2, 12 and 30) and
 * under about a second; a sweep that guards money or data integrity keeps its full set in `push` too.
 */
export function sweepTest<T>(name: string, params: SweepParams<T>, fn: (params: T) => void | Promise<void>, timeout?: Timeout): void {
  const [push, heavy] = sweepVariants(name, params, tierOf());
  test(push.name, () => fn(push.params), timeout);
  test.skipIf(!heavy.enabled)(heavy.name, () => fn(heavy.params), timeout);
}

/** A test that flaked: it runs in the quarantine run only. `id` must have an entry in quarantine.ts, or this throws when the file loads. */
export function quarantinedTest(id: string, name: string, fn: Body, timeout?: Timeout): void {
  test.skipIf(!inQuarantineRun(id))(`${tierTag("quarantine")} ${id}: ${name}`, fn, timeout);
}
