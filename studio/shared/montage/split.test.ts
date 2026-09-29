import { describe, expect, test } from "bun:test";
import { MAX_CLIPS, MAX_TOTAL_MS, MIN_CLIP_MS, MIN_TOTAL_MS, TIME_STEP_MS } from "../engine/montage";
import { splitEvenly } from "./split";

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

describe("splitEvenly: 100 ms units, the remainder to the first clips", () => {
  test("splits a total that divides evenly into equal clips", () => {
    expect(splitEvenly(8000, 4)).toEqual([2000, 2000, 2000, 2000]);
  });

  test("gives the remainder to the first clips, one 100 ms unit each: 10.0 s in 3 is 3400, 3300, 3300", () => {
    expect(splitEvenly(10_000, 3)).toEqual([3400, 3300, 3300]);
  });

  test("the plan's '20 photos, 0.75 s each' is impossible on the grid: 15.0 s in 20 is ten 800 ms then ten 700 ms clips", () => {
    expect(splitEvenly(15_000, 20)).toEqual([...Array.from({ length: 10 }, () => 800), ...Array.from({ length: 10 }, () => 700)]);
  });

  test("one clip takes the whole total", () => {
    expect(splitEvenly(4000, 1)).toEqual([4000]);
  });

  test("the smallest split the contract allows: 20 clips of exactly 500 ms make 10.0 s", () => {
    expect(splitEvenly(10_000, 20)).toEqual(Array.from({ length: 20 }, () => 500));
  });

  test("for every count 1..20 and every valid total the parts sum to the total, are multiples of 100 ms, at least 500 ms, and differ by at most 100 ms", () => {
    let cases = 0;
    for (let count = 1; count <= MAX_CLIPS; count++) {
      for (let total = Math.max(MIN_TOTAL_MS, count * MIN_CLIP_MS); total <= MAX_TOTAL_MS; total += TIME_STEP_MS) {
        const parts = splitEvenly(total, count);
        expect(parts).toHaveLength(count);
        expect(sum(parts)).toBe(total);
        for (const p of parts) {
          expect(p % TIME_STEP_MS).toBe(0);
          expect(p).toBeGreaterThanOrEqual(MIN_CLIP_MS);
        }
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(TIME_STEP_MS);
        // The longer parts come first, so the split is deterministic and never depends on anything but its arguments.
        expect([...parts].sort((a, b) => b - a)).toEqual(parts);
        cases++;
      }
    }
    // 8 counts x 111 totals, then 12 counts from 106 down to 51: 1830 combinations.
    expect(cases).toBe(1830);
  });

  test("refuses a total too short for the count (each clip needs 500 ms)", () => {
    expect(() => splitEvenly(4000, 9)).toThrow(RangeError);
    expect(() => splitEvenly(9900, 20)).toThrow(RangeError);
  });

  test.each([[1050, 2], [4000, 0], [4000, 1.5], [-100, 1], [Number.NaN, 1]])("refuses total %p ms in %p parts", (total, count) => {
    expect(() => splitEvenly(total, count)).toThrow(RangeError);
  });
});
