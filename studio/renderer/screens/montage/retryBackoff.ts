import { useEffect, useRef } from "react";
import type { Scheduler } from "../../engine/scheduler";

// 5b.2, S5.WA4 round 3: a read that failed (the draft's videos: `media.list` by id) is tried again on its own — sooner first, then every 30 s while the
// editor is open. One timer at a time; none while the read is under way or done; none once the editor closes. The editor also tries again when the window
// comes back and on «Повторить».

/** The waits before the 1st, 2nd, 3rd try after a failure; every later try waits the last. */
export const READ_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/** How long to wait after the `failures`-th failure in a row (1 is the first). */
export function retryDelayMs(failures: number): number {
  const at = Math.min(Math.max(1, failures), READ_RETRY_MS.length) - 1;
  return READ_RETRY_MS[at] ?? 30_000;
}

/**
 * Tries again (`retry`) after `retryDelayMs(failures)` while `failures` (failures in a row, 0 while the read is under way or done) is above 0. A new count
 * replaces the timer; 0 and unmounting take it back.
 */
export function useBackoffRetry(failures: number, retry: () => void, scheduler: Scheduler): void {
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (failures <= 0) return;
    return scheduler.schedule(retryDelayMs(failures), () => latest.current());
  }, [failures, scheduler]);
}
