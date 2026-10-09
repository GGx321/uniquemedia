import { describe, expect, test } from "bun:test";
import { COALESCE_INTERVAL_MS, EventCoalescer } from "./coalescer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §9): `autopilot.changed` goes out at most four times a second, and the last change is never lost.

function rig() {
  let now = 1_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const fired: number[] = [];
  const coalescer = new EventCoalescer({
    intervalMs: COALESCE_INTERVAL_MS,
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    fire: () => fired.push(now),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.live && t.at <= now)) {
      timer.live = false;
      timer.run();
    }
  };
  return { coalescer, advance, fired, pending: () => timers.filter((t) => t.live).length };
}

describe("EventCoalescer", () => {
  test("the interval is four announcements a second", () => {
    expect(COALESCE_INTERVAL_MS).toBe(250);
  });

  test("the first change after a quiet moment goes out at once", () => {
    const { coalescer, fired } = rig();
    coalescer.request();
    expect(fired).toEqual([1_000]);
  });

  test("changes inside the interval become one announcement when it ends", () => {
    const { coalescer, advance, fired } = rig();
    coalescer.request();
    advance(10);
    coalescer.request();
    advance(10);
    coalescer.request();
    expect(fired).toEqual([1_000]);
    advance(229);
    expect(fired).toEqual([1_000]);
    advance(1);
    expect(fired).toEqual([1_000, 1_250]);
  });

  test("after the trailing announcement the interval starts again", () => {
    const { coalescer, advance, fired } = rig();
    coalescer.request();
    advance(10);
    coalescer.request();
    advance(240);
    expect(fired).toEqual([1_000, 1_250]);
    coalescer.request();
    expect(fired).toEqual([1_000, 1_250]);
    advance(250);
    expect(fired).toEqual([1_000, 1_250, 1_500]);
  });

  test("a change after the interval has passed goes out at once", () => {
    const { coalescer, advance, fired } = rig();
    coalescer.request();
    advance(251);
    coalescer.request();
    expect(fired).toEqual([1_000, 1_251]);
  });

  test("never more than four announcements in any second under a steady stream of changes", () => {
    const { coalescer, advance, fired } = rig();
    for (let i = 0; i < 400; i++) {
      coalescer.request();
      advance(5);
    }
    for (let i = 1; i < fired.length; i++) expect((fired[i] ?? 0) - (fired[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
  });

  test("flush announces what is waiting now and cancels its timer; with nothing waiting it does nothing", () => {
    const { coalescer, advance, fired, pending } = rig();
    coalescer.flush();
    expect(fired).toEqual([]);
    coalescer.request();
    advance(10);
    coalescer.request();
    coalescer.flush();
    expect(fired).toEqual([1_000, 1_010]);
    expect(pending()).toBe(0);
    advance(1_000);
    expect(fired).toEqual([1_000, 1_010]);
  });

  test("dispose drops what is waiting", () => {
    const { coalescer, advance, fired, pending } = rig();
    coalescer.request();
    advance(10);
    coalescer.request();
    coalescer.dispose();
    expect(pending()).toBe(0);
    advance(1_000);
    expect(fired).toEqual([1_000]);
  });
});
