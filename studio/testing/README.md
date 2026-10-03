# Studio test tiers

CI runs Studio's tests in tiers, so a push is blocked by correctness only, and timing noise cannot turn `main` red.
One environment variable, `STUDIO_TEST_TIER`, is read by both runners (`bun test`, through
`studio/scripts/realWorkerTests.ts`, and `node --test` under Electron's Node, through
`studio/scripts/electronNodeTests.ts`). Nothing is deleted by a tier: a test is only moved, and runs in the tier its tag names.

| `STUDIO_TEST_TIER` | Runs in CI                                         | Blocks | What runs                                                                    |
| ------------------ | -------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| unset              | `build` (macOS, Windows), every push to main, tags | yes    | every ordinary test; tagged tests of other tiers are skipped (or not registered) |
| `perf`             | `perf` (ubuntu, Windows), every push to main       | no     | the `[perf]` tests, with their tight wall-clock budgets enforced and printed |
| `quarantine`       | `quarantine` (macOS, Windows), every push to main  | no     | the `[quarantine]` tests; the job is skipped while the list is empty         |
| `heavy`            | `heavy` (ubuntu), weekly cron and manual dispatch  | weekly | the `[heavy]` tests: the slow ones a push does not need                      |

Locally: `STUDIO_TEST_TIER=perf bun run test:studio:suite ./studio` and `STUDIO_TEST_TIER=perf bun run test:studio:electron-node`
(PowerShell: `$env:STUDIO_TEST_TIER = "perf"`). A tier run opens only the files that can hold its tests. An unknown value throws.

The helpers are in `tiers.ts` (runtime-neutral), `bunTiers.ts` (for `bun:test`) and `quarantine.ts`.

## A wall-clock budget: `[perf]`

A test that is a correctness test AND carries a tight time bound (`expect(elapsed).toBeLessThan(20)`) is written with
`perfTest` (bun) or a `[perf]` name (node:test), and checks the time with `assertBudget(elapsedMs, budgetMs, what)`.
It runs in every tier. The perf run enforces `budgetMs` and prints the number; every other run enforces only a generous
bound (the larger of 2 s and 4x the budget, or `{ blockingMs }` where the generous bound must stay under a number the
budget cannot tell apart, such as a serial run's total), so a runaway still fails a push. A test that is only a measurement
(an event-loop gap, a deadline headroom over the runner's speed) is `perfOnlyTest` (bun) or registered inside
`inTier("perf", ...)` (node:test): it exists in the perf run alone.

Keep a bound blocking when it guards a product guarantee and is generous: "an aborted request ends before the 20 s timer",
the 768 MiB RSS gate in the packaged smoke. Move it when it measures how fast the machine is.

## Quarantine

A test that flakes ONCE goes into `quarantine.ts`: its `id`, the `runId` of the failing GitHub Actions run, the `date`, and what
flaked. In the same change, the test is written with `quarantinedTest("<id>", name, fn)` (bun) or registered under
`if (inQuarantineRun("<id>"))` (node:test; raise the suite's `tierTests.quarantine` count in `electronNodeTests.ts`, and lower
`minTests`). It is skipped in the blocking run and runs in the non-blocking `quarantine` job, so the signal stays and `main`
stops going red.

Quarantine is never a fix. The entry leaves the list when the test is made reliable: delete the entry and the tag together, and the
test blocks again. `tiers.test.ts` fails on a tag with no entry and on an entry with no tag. The list is empty today.

## Moving a test between tiers

Say so in the commit. For a node suite, `minTests` is the blocking count and `tierTests[tier]` the tier's count: a move changes
both, on purpose (`electronNodeTests.test.ts` pins them).

## Never hand a DOM node to a matcher that prints it

A failing `expect(screen.queryByText("x")).toBeNull()` makes Bun print the node's whole happy-dom graph, without end, and the
shard hangs to its bound. Assert on a boolean or on text: `expect(screen.queryByText("x") === null).toBe(true)`.
`domMatchers.test.ts` scans every test file and fails on the pattern.
