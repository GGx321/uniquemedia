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

/** A test that flaked: it runs in the quarantine run only. `id` must have an entry in quarantine.ts, or this throws when the file loads. */
export function quarantinedTest(id: string, name: string, fn: Body, timeout?: Timeout): void {
  test.skipIf(!inQuarantineRun(id))(`${tierTag("quarantine")} ${id}: ${name}`, fn, timeout);
}
