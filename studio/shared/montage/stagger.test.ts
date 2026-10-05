import { describe, expect, test } from "bun:test";
import { MIN_CLIP_MS } from "./constants";
import { cellAlphaPermille, cellReveal, staggerStepFrames } from "./stagger";
import { msToFrames } from "./timeline";

const CELL_COUNTS = [2, 3, 4];
/** Every valid duration: the shortest clip (100 ms) to 15.0 s in 100 ms steps. */
const DURATIONS: number[] = [];
for (let ms = MIN_CLIP_MS; ms <= 15_000; ms += 100) DURATIONS.push(ms);

describe("staggerStepFrames: min(300 ms, durationMs / (n + 1)) rounded down to a frame", () => {
  test("a 500 ms collage of 4 gets a 100 ms (3 frame) step", () => {
    expect(staggerStepFrames(500, 4)).toBe(3);
  });

  test("a long clip is capped at 300 ms (9 frames)", () => {
    expect(staggerStepFrames(4000, 4)).toBe(9);
    expect(staggerStepFrames(15_000, 2)).toBe(9);
  });

  test("rounds down to a whole frame: 700 ms / 5 = 140 ms = 4.2 frames gives 4", () => {
    expect(staggerStepFrames(700, 4)).toBe(4);
  });

  test("a 500 ms collage of 2 gets 5 frames and of 3 gets 3 frames", () => {
    expect(staggerStepFrames(500, 2)).toBe(5);
    expect(staggerStepFrames(500, 3)).toBe(3);
  });

  test("the shortest clip (100 ms = 3 frames) is too short to stagger 3 or 4 cells: the step rounds down to 0 frames, and 2 cells get 1 frame", () => {
    expect(staggerStepFrames(100, 4)).toBe(0);
    expect(staggerStepFrames(100, 3)).toBe(0);
    expect(staggerStepFrames(100, 2)).toBe(1);
  });

  test("the step is a whole 0 to 9 frames and never longer than durationMs / (n + 1), for every valid duration and collage size", () => {
    for (const ms of DURATIONS) {
      for (const n of CELL_COUNTS) {
        const step = staggerStepFrames(ms, n);
        expect(Number.isInteger(step)).toBe(true);
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(9);
        // In milliseconds: step * 100 / 3 <= min(300, ms / (n + 1)).
        expect(step * 100).toBeLessThanOrEqual(Math.min(900, (ms * 3) / (n + 1)) + 1e-9);
      }
    }
  });

  test("is the largest whole-frame step that satisfies the rule (rounding is down, not below)", () => {
    for (const ms of DURATIONS) {
      for (const n of CELL_COUNTS) {
        const step = staggerStepFrames(ms, n);
        const next = step + 1;
        // One more frame would break either the 300 ms cap or the durationMs / (n + 1) bound.
        expect(next > 9 || next * (n + 1) > msToFrames(ms)).toBe(true);
      }
    }
  });

  test("refuses a duration that is not a multiple of 100 ms and a cell count below 1", () => {
    expect(() => staggerStepFrames(550, 3)).toThrow(RangeError);
    expect(() => staggerStepFrames(1000, 0)).toThrow(RangeError);
    expect(() => staggerStepFrames(1000, 2.5)).toThrow(RangeError);
  });
});

describe("cellReveal", () => {
  test("cell k starts at k x step and fades in over one step", () => {
    // 4 s, 3 cells: step 9 frames.
    expect(cellReveal(0, 3, 4000, true)).toEqual({ startFrame: 0, frames: 9 });
    expect(cellReveal(1, 3, 4000, true)).toEqual({ startFrame: 9, frames: 9 });
    expect(cellReveal(2, 3, 4000, true)).toEqual({ startFrame: 18, frames: 9 });
  });

  test("the 500 ms collage of 4: the cells appear at frames 0, 3, 6 and 9, the last one fully in at frame 12 of 15", () => {
    const reveals = [0, 1, 2, 3].map((k) => cellReveal(k, 4, 500, true));
    expect(reveals.map((r) => r.startFrame)).toEqual([0, 3, 6, 9]);
    const last = reveals[3];
    expect((last?.startFrame ?? 0) + (last?.frames ?? 0)).toBe(12);
    expect(msToFrames(500)).toBe(15);
  });

  test("with stagger off every cell is fully visible from the first frame", () => {
    for (let k = 0; k < 4; k++) expect(cellReveal(k, 4, 500, false)).toEqual({ startFrame: 0, frames: 0 });
  });

  test("cells appear in order and each is fully in strictly before the clip ends, for every valid duration and size", () => {
    for (const ms of DURATIONS) {
      const total = msToFrames(ms);
      for (const n of CELL_COUNTS) {
        const stepped = staggerStepFrames(ms, n) > 0;
        let previousStart = -1;
        for (let k = 0; k < n; k++) {
          const r = cellReveal(k, n, ms, true);
          // A clip too short for a whole-frame step shows every cell at once, so the starts then tie at 0.
          if (stepped) expect(r.startFrame).toBeGreaterThan(previousStart);
          else expect(r.startFrame).toBeGreaterThanOrEqual(previousStart);
          expect(r.startFrame).toBeGreaterThanOrEqual(0);
          expect(r.startFrame + r.frames).toBeLessThan(total);
          previousStart = r.startFrame;
        }
      }
    }
  });

  test("a 100 ms collage of 4 shows every cell at once: a reveal of 0 frames from frame 0, fully opaque on all 3 frames", () => {
    for (let k = 0; k < 4; k++) {
      const r = cellReveal(k, 4, 100, true);
      expect(r).toEqual({ startFrame: 0, frames: 0 });
      for (let f = 0; f < 3; f++) expect(cellAlphaPermille(r, f)).toBe(1000);
    }
  });

  test("a 100 ms collage of 2 staggers by one frame: cell 1 starts on frame 1 and is in on frame 2 of 3", () => {
    expect(cellReveal(0, 2, 100, true)).toEqual({ startFrame: 0, frames: 1 });
    expect(cellReveal(1, 2, 100, true)).toEqual({ startFrame: 1, frames: 1 });
  });

  test("refuses a cell index outside 0..n-1", () => {
    expect(() => cellReveal(4, 4, 1000, true)).toThrow(RangeError);
    expect(() => cellReveal(-1, 4, 1000, true)).toThrow(RangeError);
  });
});

describe("cellAlphaPermille", () => {
  test("is 0 before the reveal and on its first frame, and 1000 once it is complete", () => {
    const reveal = { startFrame: 9, frames: 9 };
    expect(cellAlphaPermille(reveal, 0)).toBe(0);
    expect(cellAlphaPermille(reveal, 9)).toBe(0);
    expect(cellAlphaPermille(reveal, 18)).toBe(1000);
    expect(cellAlphaPermille(reveal, 400)).toBe(1000);
  });

  test("rises monotonically in between", () => {
    const reveal = { startFrame: 3, frames: 9 };
    let previous = -1;
    for (let f = 0; f <= 20; f++) {
      const a = cellAlphaPermille(reveal, f);
      expect(a).toBeGreaterThanOrEqual(previous);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1000);
      previous = a;
    }
  });

  test("a reveal of 0 frames is fully visible on every frame", () => {
    expect(cellAlphaPermille({ startFrame: 0, frames: 0 }, 0)).toBe(1000);
  });
});
