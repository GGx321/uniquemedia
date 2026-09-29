import { describe, expect, test } from "bun:test";
import { CONTAINER_ALLOWANCE_BYTES, ESTIMATE_AUDIO_KBPS, ESTIMATE_VIDEO_KBPS, estimateBytes, estimateBytesUpper, MAX_VIDEO_KBPS } from "./estimate";
import { mulberry32, randInt } from "./random.testkit";

const bytesAt = (kbps: number, ms: number): number => (kbps * ms) / 8;

describe("estimateBytes", () => {
  test("a montage of no clips is 0 bytes", () => {
    expect(estimateBytes([])).toBe(0);
  });

  test("uses 3300 kbit/s of video plus 192 kbit/s of audio: 15.0 s is 6,547,500 bytes", () => {
    expect([ESTIMATE_VIDEO_KBPS, ESTIMATE_AUDIO_KBPS]).toEqual([3300, 192]);
    expect(estimateBytes([{ durationMs: 15_000 }])).toBe(6_547_500);
  });

  test("4.0 s is 1,746,000 bytes", () => {
    expect(estimateBytes([{ durationMs: 4_000 }])).toBe(1_746_000);
  });

  test("covers SP1's measured busy 15 s render (5.76 MiB at medium) but stays under the 3500k cap plus audio", () => {
    const estimate = estimateBytes([{ durationMs: 15_000 }]);
    expect(MAX_VIDEO_KBPS).toBe(3500);
    expect(estimate).toBeGreaterThanOrEqual(5.76 * 1024 * 1024);
    expect(estimate).toBeLessThanOrEqual(bytesAt(MAX_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS, 15_000));
  });

  test("depends only on the total length, not on how it is split into clips", () => {
    expect(estimateBytes([{ durationMs: 2_500 }, { durationMs: 500 }, { durationMs: 1_000 }])).toBe(estimateBytes([{ durationMs: 4_000 }]));
  });

  test("is a whole number of bytes that grows with every 100 ms, for every valid total", () => {
    let previous = 0;
    for (let ms = 500; ms <= 15_000; ms += 100) {
      const bytes = estimateBytes([{ durationMs: ms }]);
      expect(Number.isInteger(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(previous);
      previous = bytes;
    }
  });

  test("never exceeds the hard cap (3500k video plus audio) for random timelines", () => {
    const rand = mulberry32(61);
    for (let run = 0; run < 200; run++) {
      const clips = Array.from({ length: randInt(rand, 1, 20) }, () => ({ durationMs: randInt(rand, 5, 40) * 100 }));
      const totalMs = clips.reduce((s, c) => s + c.durationMs, 0);
      expect(estimateBytes(clips)).toBeLessThanOrEqual(bytesAt(MAX_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS, totalMs));
    }
  });

  test("refuses a duration that is not a multiple of 100 ms", () => {
    expect(() => estimateBytes([{ durationMs: 1050 }])).toThrow(RangeError);
  });
});

describe("estimateBytesUpper (the bound for the disk check)", () => {
  test("no clips is 0 bytes", () => {
    expect(estimateBytesUpper([])).toBe(0);
  });

  test("is the encoder's cap for the whole length (3500k video + 192k audio) plus a 64 KiB container allowance: 15.0 s is 6,988,036 bytes", () => {
    expect(CONTAINER_ALLOWANCE_BYTES).toBe(65_536);
    expect(estimateBytesUpper([{ durationMs: 15_000 }])).toBe(6_922_500 + 65_536);
  });

  test("is never below the typical estimate and is a whole number, for every valid total", () => {
    for (let ms = 500; ms <= 15_000; ms += 100) {
      const clips = [{ durationMs: ms }];
      expect(Number.isInteger(estimateBytesUpper(clips))).toBe(true);
      expect(estimateBytesUpper(clips)).toBeGreaterThan(estimateBytes(clips));
    }
  });

  test("never falls below what the cap allows over the length, over random timelines", () => {
    const rand = mulberry32(62);
    for (let run = 0; run < 200; run++) {
      const clips = Array.from({ length: randInt(rand, 1, 20) }, () => ({ durationMs: randInt(rand, 5, 40) * 100 }));
      const totalMs = clips.reduce((s, c) => s + c.durationMs, 0);
      expect(estimateBytesUpper(clips)).toBeGreaterThanOrEqual(bytesAt(MAX_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS, totalMs) + CONTAINER_ALLOWANCE_BYTES);
    }
  });
});
