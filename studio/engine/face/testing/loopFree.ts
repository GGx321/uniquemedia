export interface TimerGap {
  maxGapMs: number;
  durationMs: number;
}

export const WORKER_RUNS = 5;
export const CONTROL_RUNS = 3;

/** The in-thread control must block at least this long, or the comparison measures nothing. */
const CONTROL_MIN_BLOCK_MS = 40;

/**
 * Whether a real 2K check through the worker left this thread's event loop free, judged against the same check run in-thread
 * (`control`, already the least blocked of its runs: noise only raises a gap, so the minimum only tightens the bound).
 *
 * Judged on the SECOND-largest gap of the worker runs: one run in five may be a stall of the runner (this thread is descheduled
 * whichever path is under test), but a path that blocks the loop in two or more of five runs, however it alternates, fails. A block in
 * exactly one of five runs is indistinguishable from such noise at N=5 and is not caught; that is the price of not failing on it.
 */
export function loopFreeProblem(workerRuns: readonly TimerGap[], control: TimerGap): string | undefined {
  if (workerRuns.length < WORKER_RUNS) throw new Error(`the loop check needs at least ${WORKER_RUNS} worker runs, got ${workerRuns.length}`);
  if (!(control.maxGapMs > CONTROL_MIN_BLOCK_MS)) return `the control blocked the loop for only ${control.maxGapMs} ms: nothing to compare against`;
  const byGap = [...workerRuns].sort((a, b) => b.maxGapMs - a.maxGapMs);
  const judged = byGap[1];
  if (judged === undefined) throw new Error("no worker runs");
  if (!(judged.maxGapMs < control.maxGapMs / 2)) {
    return `the loop was blocked in at least two of ${workerRuns.length} runs: second-largest worker gap ${judged.maxGapMs} ms against control gap ${control.maxGapMs} ms`;
  }
  if (!(judged.durationMs > judged.maxGapMs * 2)) return `duration ${judged.durationMs} ms against gap ${judged.maxGapMs} ms`;
  return undefined;
}
