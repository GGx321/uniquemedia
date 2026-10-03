import { describe, expect, test } from "bun:test";
import { deadlineHeadroomProblem, HEADROOM_SAMPLES, headroomStats } from "./deadlineHeadroom";

const DEADLINE = 3_000;
const flat = (ms: number, n = HEADROOM_SAMPLES): number[] => Array.from({ length: n }, () => ms);

describe("deadlineHeadroomProblem", () => {
  test("accepts a runner that renders the caption in 250 ms", () => {
    expect(deadlineHeadroomProblem(flat(250), DEADLINE)).toBeUndefined();
  });

  test("accepts a loaded runner whose median reads 658 ms when its cheap renders are still near the real cost", () => {
    const times = [300, 310, 320, 330, 400, 500, 650, 658, 700, 720, 800, 900, 1000, 1200, 1500];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toBeUndefined();
  });

  test("accepts one stalled sample among otherwise ordinary ones", () => {
    const times = [...flat(250, HEADROOM_SAMPLES - 1), 2_900];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toBeUndefined();
  });

  test("rejects a deadline that is under 5x the typical cost", () => {
    expect(deadlineHeadroomProblem(flat(700), DEADLINE)).toContain("under 5x");
  });

  test("rejects a deadline that is under 3x the median when the cheap renders look fine", () => {
    const times = [...flat(250, 4), ...flat(1_100, HEADROOM_SAMPLES - 4)];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toContain("under 3x");
  });

  test("rejects a deadline that is under 1.5x the second-slowest sample", () => {
    const times = [...flat(250, HEADROOM_SAMPLES - 2), 2_100, 2_200];
    expect(deadlineHeadroomProblem(times, DEADLINE)).toContain("under 1.5x");
  });

  test("rejects NaN samples instead of passing them", () => {
    expect(deadlineHeadroomProblem(flat(Number.NaN), DEADLINE)).toBeDefined();
  });

  test("refuses to judge fewer samples than the minimum", () => {
    expect(() => deadlineHeadroomProblem(flat(250, HEADROOM_SAMPLES - 1), DEADLINE)).toThrow("at least");
  });

  test("reads the quartile, median and second-slowest off the sorted samples", () => {
    const times = Array.from({ length: 15 }, (_, i) => (15 - i) * 10); // 150 down to 10
    expect(headroomStats(times)).toEqual({ lowerQuartile: 40, median: 80, secondSlowest: 140 });
  });
});
