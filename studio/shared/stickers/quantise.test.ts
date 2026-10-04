import { describe, expect, test } from "bun:test";
import { clampGifDelayCs, quantiseByAccumulatedTime } from "./quantise";

const cs = (n: number) => ({ num: n, den: 100 });

describe("quantiseByAccumulatedTime", () => {
  test("a frame of exactly 1/30 s gets one slot", () => {
    expect(quantiseByAccumulatedTime([{ num: 1, den: 30 }, { num: 1, den: 30 }, { num: 1, den: 30 }])).toEqual({ slots: [1, 1, 1], loopFrames: 3 });
  });

  test("a frame of 2/30 s gets two slots", () => {
    expect(quantiseByAccumulatedTime([{ num: 2, den: 30 }, { num: 1, den: 30 }]).slots).toEqual([2, 1]);
  });

  test("seven 4 cs frames (a 25 fps GIF) become an 8 frame loop at 30 fps, none of them lost", () => {
    const result = quantiseByAccumulatedTime(Array.from({ length: 7 }, () => cs(4)));
    expect(result.slots).toEqual([1, 1, 2, 1, 1, 1, 1]);
    expect(result.loopFrames).toBe(8);
  });

  test("the error never accumulates: the loop is the whole duration rounded once", () => {
    // 100 frames of 4 cs = 4.00 s = exactly 120 frames; rounding each frame alone would give 100 or 133.
    expect(quantiseByAccumulatedTime(Array.from({ length: 100 }, () => cs(4))).loopFrames).toBe(120);
  });

  test("a frame shorter than a slot can be dropped: it gets zero slots and the loop keeps its length", () => {
    const result = quantiseByAccumulatedTime([cs(2), cs(2), cs(2)]);
    expect(result.slots).toEqual([1, 0, 1]);
    expect(result.loopFrames).toBe(2);
  });

  test("a boundary on exactly half a slot rounds up, as ffmpeg's fps filter does", () => {
    // 5 cs is 1.5 slots.
    expect(quantiseByAccumulatedTime([cs(5), cs(5)]).slots).toEqual([2, 1]);
  });

  test("denominators that do not divide 30 are exact (no floating point)", () => {
    const result = quantiseByAccumulatedTime(Array.from({ length: 7 }, () => ({ num: 1, den: 7 })));
    expect(result.slots).toEqual([4, 5, 4, 4, 4, 5, 4]);
    expect(result.loopFrames).toBe(30);
  });

  test("a delay with the largest denominator a PNG can write stays exact", () => {
    const result = quantiseByAccumulatedTime([{ num: 65535, den: 65535 }, { num: 1, den: 65535 }]);
    expect(result.slots).toEqual([30, 0]);
  });

  test("slots always add up to the loop length", () => {
    const delays = [3, 7, 2, 9, 4, 11, 5, 6].map(cs);
    const result = quantiseByAccumulatedTime(delays);
    expect(result.slots.reduce((a, b) => a + b, 0)).toBe(result.loopFrames);
  });

  test("an empty list is a loop of nothing", () => {
    expect(quantiseByAccumulatedTime([])).toEqual({ slots: [], loopFrames: 0 });
  });

  test("a zero or negative duration is refused", () => {
    expect(() => quantiseByAccumulatedTime([{ num: 0, den: 100 }])).toThrow();
    expect(() => quantiseByAccumulatedTime([{ num: 1, den: 0 }])).toThrow();
  });
});

describe("clampGifDelayCs", () => {
  test("0 and 1 cs become 10 cs, as browsers and ffmpeg's gif demuxer both do", () => {
    expect([clampGifDelayCs(0), clampGifDelayCs(1)]).toEqual([10, 10]);
  });

  test("2 cs and above are kept as they are", () => {
    expect([clampGifDelayCs(2), clampGifDelayCs(3), clampGifDelayCs(10), clampGifDelayCs(65535)]).toEqual([2, 3, 10, 65535]);
  });
});
