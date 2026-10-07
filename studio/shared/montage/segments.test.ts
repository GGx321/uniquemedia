import { describe, expect, test } from "bun:test";
import { FRAME_W, MAX_CLIPS, MAX_TOTAL_MS } from "./constants";
import { mulberry32, randInt } from "./random.testkit";
import { progressSegments, SEGMENT_GAP, SEGMENT_HEIGHT, SEGMENT_MARGIN, SEGMENT_TOP, segmentFillWidth } from "./segments";
import { clipRanges } from "./timeline";

const clipsOf = (durations: number[]) => durations.map((durationMs, i) => ({ clipId: `clip-seg-${i}`, durationMs }));

describe("progressSegments (preview-only: never rendered)", () => {
  test("uses the designer's 36 px margin, 36 px top inset, 10 px bars and 14 px gaps (CF19, even-rounded)", () => {
    expect([SEGMENT_MARGIN, SEGMENT_TOP, SEGMENT_HEIGHT, SEGMENT_GAP]).toEqual([36, 36, 10, 14]);
  });

  test("no clips, no segments", () => {
    expect(progressSegments([])).toEqual([]);
  });

  test("one clip is one bar across the whole width inside the margins", () => {
    expect(progressSegments(clipsOf([8000]))).toEqual([{ clipId: "clip-seg-0", rect: { x: 36, y: 36, w: 1008, h: 10 }, startFrame: 0, endFrame: 240 }]);
  });

  test("two equal clips share the width minus the gap: 497 px each, the second starting after the gap", () => {
    const [a, b] = progressSegments(clipsOf([4000, 4000]));
    expect(a?.rect).toEqual({ x: 36, y: 36, w: 497, h: 10 });
    expect(b?.rect).toEqual({ x: 547, y: 36, w: 497, h: 10 });
  });

  test("segment frame ranges are the clip ranges", () => {
    const clips = clipsOf([1000, 2500, 500]);
    const segments = progressSegments(clips);
    expect(segments.map((s) => [s.clipId, s.startFrame, s.endFrame])).toEqual(clipRanges(clips).map((r) => [r.clipId, r.startFrame, r.endFrame]));
  });

  test("random timelines: inside the frame, ordered, exactly one gap apart, widths add up, each within 1 px of its share, none empty", () => {
    const rand = mulberry32(81);
    for (let run = 0; run < 500; run++) {
      const count = randInt(rand, 1, 20);
      const durations = Array.from({ length: count }, () => (rand() < 0.3 ? 500 : randInt(rand, 5, 150) * 100));
      const clips = clipsOf(durations);
      const segments = progressSegments(clips);
      const ranges = clipRanges(clips);
      const total = ranges[ranges.length - 1]?.endFrame ?? 1;
      const avail = FRAME_W - 2 * SEGMENT_MARGIN - SEGMENT_GAP * (count - 1);
      expect(segments).toHaveLength(count);
      expect(segments.reduce((s, seg) => s + seg.rect.w, 0)).toBe(avail);
      segments.forEach((seg, i) => {
        expect(seg.rect.w).toBeGreaterThanOrEqual(1);
        expect(seg.rect.x).toBeGreaterThanOrEqual(SEGMENT_MARGIN);
        expect(seg.rect.x + seg.rect.w).toBeLessThanOrEqual(FRAME_W - SEGMENT_MARGIN);
        expect([seg.rect.y, seg.rect.h]).toEqual([SEGMENT_TOP, SEGMENT_HEIGHT]);
        const range = ranges[i];
        expect(Math.abs(seg.rect.w - (avail * (range?.frames ?? 0)) / total)).toBeLessThan(1);
        const previous = segments[i - 1];
        if (previous) expect(seg.rect.x - (previous.rect.x + previous.rect.w)).toBe(SEGMENT_GAP);
      });
      const last = segments[count - 1];
      expect((last?.rect.x ?? 0) + (last?.rect.w ?? 0)).toBe(FRAME_W - SEGMENT_MARGIN);
    }
  });

  test("in a full montage (twenty clips, 15.0 s in all) the shortest clip, 100 ms, gets a 4 px bar: floor(742 px x 3 of 450 frames)", () => {
    const clips = clipsOf([100, 500, ...Array.from({ length: 18 }, () => 800)]);
    expect(clips).toHaveLength(MAX_CLIPS);
    expect(clips.reduce((sum, clip) => sum + clip.durationMs, 0)).toBe(MAX_TOTAL_MS);

    const segments = progressSegments(clips);

    expect(segments[0]?.rect.w).toBe(4);
    expect(segments.every((segment) => segment.rect.w >= 4)).toBe(true);
  });

  test("refuses a duration that is not a multiple of 100 ms", () => {
    expect(() => progressSegments(clipsOf([1050]))).toThrow(RangeError);
  });
});

describe("segmentFillWidth", () => {
  const [segment] = progressSegments(clipsOf([4000]));
  if (!segment) throw new Error("test setup");

  test("is 0 before and on the clip's first frame and the full width from its end frame on", () => {
    expect(segmentFillWidth(segment, 0)).toBe(0);
    expect(segmentFillWidth(segment, segment.endFrame)).toBe(segment.rect.w);
    expect(segmentFillWidth(segment, 9999)).toBe(segment.rect.w);
  });

  test("grows monotonically and never passes the bar", () => {
    let previous = -1;
    for (let f = 0; f <= segment.endFrame; f++) {
      const w = segmentFillWidth(segment, f);
      expect(w).toBeGreaterThanOrEqual(previous);
      expect(w).toBeLessThanOrEqual(segment.rect.w);
      previous = w;
    }
  });

  test("is half the bar at the clip's midpoint", () => {
    expect(segmentFillWidth(segment, 60)).toBe(504);
  });

  test("is 0 for a frame before the clip", () => {
    const [, second] = progressSegments(clipsOf([4000, 4000]));
    if (!second) throw new Error("test setup");
    expect(segmentFillWidth(second, 10)).toBe(0);
  });
});
