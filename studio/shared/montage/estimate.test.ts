import { describe, expect, test } from "bun:test";
import { ESTIMATE_AUDIO_KBPS, ESTIMATE_VIDEO_KBPS, estimateBytes, MAX_VIDEO_KBPS } from "./estimate";
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
