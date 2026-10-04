import type { FrameClock } from "./playback";

// Test support (3d.4): a frame clock the test moves by hand. `advance(ms)` moves the time, then runs the frame callbacks that were
// waiting (each may ask for the next frame, which waits for the next `advance`). Test-only.

export interface FakeFrameClock {
  readonly clock: FrameClock;
  advance(ms: number): void;
  /** Frame callbacks waiting for the next `advance`. */
  pending(): number;
}

export function fakeFrameClock(startMs = 1_000): FakeFrameClock {
  let now = startMs;
  let callbacks: (() => void)[] = [];
  const clock: FrameClock = {
    now: () => now,
    frame: (callback) => {
      callbacks.push(callback);
      return () => {
        callbacks = callbacks.filter((c) => c !== callback);
      };
    },
  };
  return {
    clock,
    advance(ms: number): void {
      now += ms;
      const run = callbacks;
      callbacks = [];
      for (const callback of run) callback();
    },
    pending: (): number => callbacks.length,
  };
}
