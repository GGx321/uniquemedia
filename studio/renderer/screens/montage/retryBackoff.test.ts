import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { ManualScheduler } from "../../engine/scheduler";
import { READ_RETRY_MS, retryDelayMs, useBackoffRetry } from "./retryBackoff";

// 5b.2, S5.WA4 round 3: a read of the draft's videos that failed is tried again on its own, sooner first, then every 30 s while the editor is open; one
// timer at a time, none once the read is not failing, none after the editor closes. The clock is the test's (ManualScheduler): no real timer runs.

describe("the delays", () => {
  test("2 s, 5 s, 15 s, then every 30 s", () => {
    expect(READ_RETRY_MS).toEqual([2_000, 5_000, 15_000, 30_000]);
    expect([1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([2_000, 5_000, 15_000, 30_000, 30_000, 30_000]);
  });
});

describe("useBackoffRetry", () => {
  test("nothing is scheduled while the read is not failing", () => {
    const scheduler = new ManualScheduler();
    let retries = 0;
    renderHook(() => useBackoffRetry(0, () => void retries++, scheduler));
    expect(scheduler.pending).toBe(0);
    expect(retries).toBe(0);
  });

  test("one failure: one try after 2 s; the n-th failure in a row waits its own delay; one timer at a time", () => {
    const scheduler = new ManualScheduler();
    let retries = 0;
    const { rerender } = renderHook(({ failures }) => useBackoffRetry(failures, () => void retries++, scheduler), { initialProps: { failures: 1 } });
    expect(scheduler.pending).toBe(1);
    scheduler.next();
    expect(retries).toBe(1);
    expect(scheduler.pending).toBe(0);
    // The try failed again: the next waits 5 s.
    rerender({ failures: 2 });
    expect(scheduler.pending).toBe(1);
    const before = retries;
    scheduler.next();
    expect(retries).toBe(before + 1);
    rerender({ failures: 5 });
    expect(scheduler.pending).toBe(1);
  });

  test("a read under way or done takes the timer back; closing the editor does too", () => {
    const scheduler = new ManualScheduler();
    let retries = 0;
    const { rerender, unmount } = renderHook(({ failures }) => useBackoffRetry(failures, () => void retries++, scheduler), { initialProps: { failures: 3 } });
    expect(scheduler.pending).toBe(1);
    rerender({ failures: 0 });
    expect(scheduler.pending).toBe(0);
    rerender({ failures: 1 });
    expect(scheduler.pending).toBe(1);
    unmount();
    expect(scheduler.pending).toBe(0);
    scheduler.runAll();
    expect(retries).toBe(0);
  });
});
