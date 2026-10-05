import { describe, expect, test } from "bun:test";
import { MAX_TOTAL_MS, MIN_CLIP_MS, MIN_TOTAL_MS } from "../engine/montage";
import { clipAtFrame, clipRanges, framesToMs, layerRange, layerVisibleAt, msToFrameFloor, msToFrames, totalFrames } from "./timeline";
import { mulberry32, randInt } from "./random.testkit";

/** Every valid duration: 100 ms to 15.0 s in 100 ms steps. */
const VALID_DURATIONS: number[] = [];
for (let ms = MIN_CLIP_MS; ms <= MAX_TOTAL_MS; ms += 100) VALID_DURATIONS.push(ms);

describe("msToFrames", () => {
  test("gives exactly 3 frames per 100 ms for every valid duration", () => {
    for (const ms of VALID_DURATIONS) {
      expect(msToFrames(ms)).toBe((ms / 100) * 3);
      expect(Number.isInteger(msToFrames(ms))).toBe(true);
    }
  });

  test("maps the boundaries: 0, the 100 ms minimum clip, 500 ms, 4.0 s and 15.0 s", () => {
    expect(msToFrames(0)).toBe(0);
    expect(msToFrames(500)).toBe(15);
    expect(msToFrames(MIN_TOTAL_MS)).toBe(120);
    expect(msToFrames(MAX_TOTAL_MS)).toBe(450);
  });

  test.each([1, 50, 99, 101, 150, 1234])("refuses %i ms, which is not a multiple of 100", (ms) => {
    expect(() => msToFrames(ms)).toThrow(RangeError);
  });

  test.each([-100, Number.NaN, Number.POSITIVE_INFINITY, 100.5])("refuses %p, which is not a whole non-negative number", (ms) => {
    expect(() => msToFrames(ms)).toThrow(RangeError);
  });
});

describe("framesToMs", () => {
  test("is the exact inverse of msToFrames on every valid duration", () => {
    for (const ms of VALID_DURATIONS) expect(framesToMs(msToFrames(ms))).toBe(ms);
  });

  test("gives the display time of a frame boundary that is not a step, rounded down to whole milliseconds", () => {
    // Frame 1 starts at 33.33 ms, frame 2 at 66.67 ms.
    expect(framesToMs(1)).toBe(33);
    expect(framesToMs(2)).toBe(66);
    expect(framesToMs(3)).toBe(100);
  });

  test("refuses a fractional or negative frame", () => {
    expect(() => framesToMs(1.5)).toThrow(RangeError);
    expect(() => framesToMs(-1)).toThrow(RangeError);
  });
});

describe("clipRanges", () => {
  test("lays clips back to back from frame 0", () => {
    const ranges = clipRanges([
      { clipId: "clip-aaaa1", durationMs: 4000 },
      { clipId: "clip-bbbb2", durationMs: 500 },
      { clipId: "clip-cccc3", durationMs: 2500 },
    ]);
    expect(ranges).toEqual([
      { clipId: "clip-aaaa1", startFrame: 0, frames: 120, endFrame: 120 },
      { clipId: "clip-bbbb2", startFrame: 120, frames: 15, endFrame: 135 },
      { clipId: "clip-cccc3", startFrame: 135, frames: 75, endFrame: 210 },
    ]);
  });

  test("returns no ranges for no clips", () => {
    expect(clipRanges([])).toEqual([]);
    expect(totalFrames([])).toBe(0);
  });

  test("a single 15.0 s clip is 450 frames and a single 4.0 s clip is 120", () => {
    expect(totalFrames([{ durationMs: 15_000 }])).toBe(450);
    expect(totalFrames([{ durationMs: 4_000 }])).toBe(120);
  });

  test("total frames equal the sum of the clips' frames, which equal total ms x 3 / 100 (random timelines)", () => {
    const rand = mulberry32(0xc11b5);
    for (let run = 0; run < 300; run++) {
      const count = randInt(rand, 1, 20);
      const clips: { clipId: string; durationMs: number }[] = [];
      for (let i = 0; i < count; i++) clips.push({ clipId: `clip-${run}-${i}`, durationMs: randInt(rand, 5, 150) * 100 });
      const ranges = clipRanges(clips);
      const sumMs = clips.reduce((s, c) => s + c.durationMs, 0);
      const last = ranges[ranges.length - 1];
      expect(totalFrames(clips)).toBe((sumMs * 3) / 100);
      expect(last?.endFrame).toBe(totalFrames(clips));
      expect(ranges.reduce((s, r) => s + r.frames, 0)).toBe(totalFrames(clips));
    }
  });

  test("ranges are contiguous: each clip starts where the previous one ends, with no gap and no overlap", () => {
    const rand = mulberry32(7);
    const clips = Array.from({ length: 20 }, (_, i) => ({ clipId: `clip-${i}`, durationMs: randInt(rand, 5, 40) * 100 }));
    const ranges = clipRanges(clips);
    expect(ranges[0]?.startFrame).toBe(0);
    ranges.forEach((r, i) => {
      expect(r.endFrame).toBe(r.startFrame + r.frames);
      if (i > 0) expect(r.startFrame).toBe(ranges[i - 1]?.endFrame);
    });
  });

  test("a clip's range does not depend on the clips after it", () => {
    const a = clipRanges([{ clipId: "clip-1", durationMs: 1000 }, { clipId: "clip-2", durationMs: 700 }]);
    const b = clipRanges([{ clipId: "clip-1", durationMs: 1000 }, { clipId: "clip-2", durationMs: 700 }, { clipId: "clip-3", durationMs: 900 }]);
    expect(b.slice(0, 2)).toEqual(a);
  });

  test("refuses a clip whose duration is not a multiple of 100 ms", () => {
    expect(() => clipRanges([{ clipId: "clip-1", durationMs: 1050 }])).toThrow(RangeError);
  });
});

describe("layerRange (inclusive start, exclusive end)", () => {
  test("converts a layer's ms range to a half-open frame range", () => {
    expect(layerRange({ startMs: 1000, endMs: 2500 })).toEqual({ startFrame: 30, endFrame: 75, frames: 45 });
  });

  test("the shortest layer, 300 ms, spans 9 frames", () => {
    expect(layerRange({ startMs: 0, endMs: 300 }).frames).toBe(9);
  });

  test("a layer ending at the end of a 15.0 s montage ends at frame 450, which is past the last frame (449)", () => {
    expect(layerRange({ startMs: 14_700, endMs: 15_000 })).toEqual({ startFrame: 441, endFrame: 450, frames: 9 });
  });

  test("a layer is visible on its first frame and not on its end frame", () => {
    const layer = { startMs: 1000, endMs: 1300 };
    expect(layerVisibleAt(layer, 29)).toBe(false);
    expect(layerVisibleAt(layer, 30)).toBe(true);
    expect(layerVisibleAt(layer, 38)).toBe(true);
    expect(layerVisibleAt(layer, 39)).toBe(false);
  });

  test("the number of visible frames equals frames for random layers", () => {
    const rand = mulberry32(99);
    for (let run = 0; run < 200; run++) {
      const startMs = randInt(rand, 0, 146) * 100;
      const endMs = startMs + randInt(rand, 3, 150 - startMs / 100) * 100;
      const layer = { startMs, endMs };
      let visible = 0;
      for (let f = 0; f < 450; f++) if (layerVisibleAt(layer, f)) visible++;
      expect(visible).toBe(layerRange(layer).frames);
    }
  });

  test("refuses times that are not multiples of 100 ms", () => {
    expect(() => layerRange({ startMs: 10, endMs: 400 })).toThrow(RangeError);
  });
});

describe("msToFrameFloor (for scrubbing: any time, rounded down to its frame)", () => {
  test("agrees with msToFrames on every multiple of 100 ms", () => {
    for (const ms of VALID_DURATIONS) expect(msToFrameFloor(ms)).toBe(msToFrames(ms));
  });

  test("rounds down inside a step: 33 ms is frame 0, 34 ms frame 1, 99 ms frame 2, 100 ms frame 3, 133 ms frame 3, 134 ms frame 4", () => {
    expect([msToFrameFloor(0), msToFrameFloor(33), msToFrameFloor(34), msToFrameFloor(99), msToFrameFloor(100), msToFrameFloor(133), msToFrameFloor(134)]).toEqual([0, 0, 1, 2, 3, 3, 4]);
  });

  test("accepts a fractional millisecond time from a pointer position", () => {
    expect(msToFrameFloor(1234.9)).toBe(37);
  });

  test("the frame it names starts at or before the time and the next one starts after it, over random times", () => {
    const rand = mulberry32(17);
    for (let i = 0; i < 2000; i++) {
      const ms = randInt(rand, 0, 15_000);
      const frame = msToFrameFloor(ms);
      expect((frame * 1000) / 30).toBeLessThanOrEqual(ms);
      expect(((frame + 1) * 1000) / 30).toBeGreaterThan(ms);
    }
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %p", (ms) => {
    expect(() => msToFrameFloor(ms)).toThrow(RangeError);
  });
});

describe("clipAtFrame", () => {
  const ranges = clipRanges([
    { clipId: "clip-aaaa1", durationMs: 4000 },
    { clipId: "clip-bbbb2", durationMs: 500 },
    { clipId: "clip-cccc3", durationMs: 2500 },
  ]);

  test("finds the clip a frame belongs to, with its index and the frame within the clip", () => {
    expect(clipAtFrame(ranges, 0)).toEqual({ index: 0, range: ranges[0], localFrame: 0 });
    expect(clipAtFrame(ranges, 119)).toEqual({ index: 0, range: ranges[0], localFrame: 119 });
    expect(clipAtFrame(ranges, 130)).toEqual({ index: 1, range: ranges[1], localFrame: 10 });
    expect(clipAtFrame(ranges, 209)).toEqual({ index: 2, range: ranges[2], localFrame: 74 });
  });

  test("a clip's end frame belongs to the NEXT clip (half-open ranges)", () => {
    expect(clipAtFrame(ranges, 120)?.index).toBe(1);
    expect(clipAtFrame(ranges, 135)?.index).toBe(2);
  });

  test("a frame past the last one, or before the first, is in no clip", () => {
    expect(clipAtFrame(ranges, 210)).toBeNull();
    expect(clipAtFrame(ranges, -1)).toBeNull();
    expect(clipAtFrame([], 0)).toBeNull();
  });

  test("every frame of a random timeline maps to exactly the clip whose range holds it", () => {
    const rand = mulberry32(18);
    const clips = Array.from({ length: 12 }, (_, i) => ({ clipId: `clip-look-${i}`, durationMs: randInt(rand, 5, 30) * 100 }));
    const rs = clipRanges(clips);
    for (let f = 0; f < totalFrames(clips); f++) {
      const hit = clipAtFrame(rs, f);
      expect(hit).not.toBeNull();
      if (hit === null) continue;
      expect(f).toBeGreaterThanOrEqual(hit.range.startFrame);
      expect(f).toBeLessThan(hit.range.endFrame);
      expect(hit.localFrame).toBe(f - hit.range.startFrame);
    }
    expect(clipAtFrame(rs, totalFrames(clips))).toBeNull();
  });

  test("refuses a fractional frame", () => {
    expect(() => clipAtFrame(ranges, 1.5)).toThrow(RangeError);
  });
});
