import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { deadlineHeadroomProblem, HEADROOM_SAMPLES, headroomStats } from "./deadlineHeadroom";
useNativeGlobals();

const DEADLINE = 3_000;
const flat = (ms: number, n = HEADROOM_SAMPLES): number[] => Array.from({ length: n }, () => ms);

describe("deadlineHeadroomProblem", () => {
  test("accepts a runner that renders the caption in 250 ms", () => {
    expect(deadlineHeadroomProblem(flat(250), DEADLINE)).toBeUndefined();
  });

  test("accepts one stalled sample among otherwise ordinary ones", () => {
    const times = [...flat(250, HEADROOM_SAMPLES - 1), 2_900];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toBeUndefined();
  });

  test("accepts a loaded runner whose renders are all within 3x of the deadline's headroom (second-slowest 662 ms)", () => {
    const times = [300, 310, 320, 330, 340, 350, 360, 380, 400, 420, 450, 500, 580, 662, 640];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toBeUndefined();
  });

  test("rejects a deadline that is under 5x the typical cost", () => {
    expect(deadlineHeadroomProblem(flat(700), DEADLINE)).toContain("under 5x");
  });

  test("rejects a loaded runner whose median reads 658 ms and whose tail passes 1.2 s: a plain slow caption could trip the deadline", () => {
    const times = [300, 310, 320, 330, 400, 500, 650, 658, 700, 720, 800, 900, 1000, 1200, 1500];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toContain("under 3x");
  });

  test("rejects a regression that makes every second render 8x slower", () => {
    const times = Array.from({ length: HEADROOM_SAMPLES }, (_, i) => (i % 2 === 0 ? 156 : 1_250));
    expect(deadlineHeadroomProblem(times, DEADLINE)).toContain("under 3x");
  });

  test("rejects a regression that makes every second render 4x slower on a slower runner (485 ms to 1940 ms)", () => {
    const times = Array.from({ length: HEADROOM_SAMPLES }, (_, i) => (i % 2 === 0 ? 485 : 1_940));
    expect(deadlineHeadroomProblem(times, DEADLINE)).toBeDefined();
  });

  test("rejects two slow renders out of 15: the tail bound reads the second-slowest, so a single stall is the only one forgiven", () => {
    const times = [...flat(250, HEADROOM_SAMPLES - 2), 1_100, 2_900];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toContain("under 3x");
  });

  test("rejects NaN samples instead of passing them", () => {
    expect(deadlineHeadroomProblem(flat(Number.NaN), DEADLINE)).toBeDefined();
  });

  test("rejects one NaN or infinite sample even when the statistics would not read it", () => {
    expect(deadlineHeadroomProblem([...flat(250, HEADROOM_SAMPLES - 1), Number.NaN], DEADLINE)).toContain("not finite");
    expect(deadlineHeadroomProblem([Number.POSITIVE_INFINITY, ...flat(250, HEADROOM_SAMPLES - 1)], DEADLINE)).toContain("not finite");
  });

  test("refuses to judge fewer samples than the minimum", () => {
    expect(() => deadlineHeadroomProblem(flat(250, HEADROOM_SAMPLES - 1), DEADLINE)).toThrow("at least");
  });

  test("reads the quartile, median and second-slowest off the sorted samples", () => {
    const times = Array.from({ length: 15 }, (_, i) => (15 - i) * 10); // 150 down to 10
    expect(headroomStats(times)).toEqual({ lowerQuartile: 40, median: 80, secondSlowest: 140 });
  });
});
