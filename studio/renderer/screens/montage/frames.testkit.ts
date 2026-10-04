import { spyOn } from "bun:test";
import { act } from "@testing-library/react";

// Test support (3d.4): the window's animation frames and `performance.now()` driven by hand, so a test can play the editor's
// playhead clock (`windowFrameClock`) frame by frame. Restore it at the end of the test. Test-only.

export interface ManualFrames {
  /** Moves `performance.now()` by `ms`, then runs the frame callbacks that were waiting, inside act. */
  advance(ms: number): void;
  /** Frame callbacks waiting. */
  pending(): number;
  restore(): void;
}

export function manualFrames(startMs = 10_000): ManualFrames {
  let now = startMs;
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number): void => {
    queue.delete(id);
  };
  return {
    advance(ms: number): void {
      now += ms;
      const run = [...queue.values()];
      queue = new Map();
      act(() => {
        for (const callback of run) callback(now);
      });
    },
    pending: (): number => queue.size,
    restore(): void {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = caf;
      clock.mockRestore();
    },
  };
}
