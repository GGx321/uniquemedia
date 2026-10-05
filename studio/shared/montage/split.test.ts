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

  test("20 clips of exactly 500 ms make 10.0 s", () => {
    expect(splitEvenly(10_000, 20)).toEqual(Array.from({ length: 20 }, () => 500));
  });

  test("the smallest split the contract allows: 20 clips of exactly 100 ms make 2.0 s, and one more step goes to the first clip", () => {
    expect(splitEvenly(2_000, 20)).toEqual(Array.from({ length: 20 }, () => 100));
    expect(splitEvenly(2_100, 20)).toEqual([200, ...Array.from({ length: 19 }, () => 100)]);
  });

  test("a 4.0 s montage in 20 clips is 200 ms each, and in 2 clips of a 100 ms floor 100 ms is never needed", () => {
    expect(splitEvenly(4_000, 20)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(splitEvenly(100, 1)).toEqual([100]);
  });

  test("for every count 1..20 and every valid total the parts sum to the total, are multiples of 100 ms, at least 100 ms, and differ by at most 100 ms", () => {
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
    // Every count has room from 4.0 s (a clip needs only 100 ms): 20 counts x 111 totals.
    expect(cases).toBe(2220);
  });

  test("refuses a total too short for the count (each clip needs 100 ms)", () => {
    expect(() => splitEvenly(1_900, 20)).toThrow(RangeError);
    expect(() => splitEvenly(100, 2)).toThrow(RangeError);
    expect(() => splitEvenly(0, 1)).toThrow(RangeError);
  });

  test.each([[1050, 2], [4000, 0], [4000, 1.5], [-100, 1], [Number.NaN, 1]])("refuses total %p ms in %p parts", (total, count) => {
    expect(() => splitEvenly(total, count)).toThrow(RangeError);
  });
});
