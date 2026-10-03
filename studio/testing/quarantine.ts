import { tierOf } from "./tiers";

/**
 * Quarantine: a test that flaked on CI is moved out of the blocking run until it is fixed, so main stops going red on it,
 * and keeps running in the non-blocking `quarantine` job, so the signal is not lost.
 *
 * The rule (also in studio/testing/README.md and the workflow's comment):
 *   - A test that flakes ONCE is added here, with the run id of the failure and the date. Add it in the same change that
 *     tags the test (`quarantinedTest` in bunTiers.ts, or `inQuarantineRun` around a node:test).
 *   - Quarantine is never a fix. The entry names the reason, and the entry goes when the test is made reliable: delete
 *     the entry and the tag together, and the test is blocking again.
 *   - tiers.test.ts fails on a tag with no entry and on an entry with no tag, so the list cannot rot.
 */
export interface QuarantineEntry {
  /** The id the tagged test names: short, unique, and greppable. */
  id: string;
  /** The GitHub Actions run id of the failure that put it here. */
  runId: string;
  /** When it was quarantined, `YYYY-MM-DD`. */
  date: string;
  /** What flaked and what the fix needs. */
  reason: string;
}

/** Empty on purpose: every test the CI-3 pass found flaky was fixed there. */
export const QUARANTINE: readonly QuarantineEntry[] = [];

/** The entry for `id`; throws when there is none, so a tag cannot outlive (or precede) its entry. */
export function quarantineEntry(id: string, list: readonly QuarantineEntry[] = QUARANTINE): QuarantineEntry {
  const entry = list.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`quarantine: no entry for "${id}" in studio/testing/quarantine.ts`);
  return entry;
}

/** Whether the quarantined test `id` runs in this process: only in the quarantine run. Throws for an id with no entry. */
export function inQuarantineRun(id: string, env: Readonly<Record<string, string | undefined>> = process.env, list: readonly QuarantineEntry[] = QUARANTINE): boolean {
  quarantineEntry(id, list);
  return tierOf(env) === "quarantine";
}
