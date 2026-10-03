import { describe, expect, test } from "bun:test";
import { boundaryAt, boundaryMs, clampZoom, clockMs, msAtFraction, rulerMarks, seekInto, snapEdge, snapPlayhead, stepPlayhead, tileCount, TIMELINE_MS } from "./timelineScale";

// 3d.3a: the timeline's scale and the playhead. The ruler always spans 0–15 s; the zoom (1–8) widens it. The
// playhead is the renderer's clock on the 100 ms grid, within the montage.

describe("the zoom", () => {
  test("whole steps from 1 to 8", () => {
    expect([0, 1, 2.4, 2.5, 8, 9, -3].map(clampZoom)).toEqual([1, 1, 2, 3, 8, 8, 1]);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe("the playhead", () => {
  test("snaps to the nearest 100 ms and stays within the montage", () => {
    expect(snapPlayhead(4_149, 9_600)).toBe(4_100);
    expect(snapPlayhead(4_150, 9_600)).toBe(4_200);
    expect(snapPlayhead(-20, 9_600)).toBe(0);
    expect(snapPlayhead(12_000, 9_600)).toBe(9_600);
    expect(snapPlayhead(15_000, 15_000)).toBe(15_000);
    expect(snapPlayhead(300, 0)).toBe(0);
  });

  test("an arrow steps from the clock's 100 ms (a playing playhead is between steps), clamped at both ends", () => {
    expect(stepPlayhead(4_100, 9_600, 100)).toBe(4_200);
    expect(stepPlayhead(4_160, 9_600, 100)).toBe(4_200);
    expect(stepPlayhead(4_160, 9_600, -100)).toBe(4_000);
    expect(stepPlayhead(0, 9_600, -100)).toBe(0);
    expect(stepPlayhead(9_500, 9_600, 1_000)).toBe(9_600);
  });

  test("the clock reads the 100 ms step the playhead is in", () => {
    expect(clockMs(4_199.9)).toBe(4_100);
    expect(clockMs(4_200)).toBe(4_200);
    expect(clockMs(-5)).toBe(0);
  });

  test("selecting an item outside the playhead brings it in: up to 1 s, or the middle of a short item", () => {
    expect(seekInto(500, 2_400, 5_600)).toBe(3_400);
    expect(seekInto(4_100, 2_400, 5_600)).toBe(4_100);
    expect(seekInto(5_600, 2_400, 5_600)).toBe(3_400);
    expect(seekInto(0, 2_400, 3_000)).toBe(2_700);
    expect(seekInto(0, 1_000, 1_500)).toBe(1_200);
  });

  test("a pointer's place on the ruler is a time on the 15 s scale", () => {
    expect(msAtFraction(0)).toBe(0);
    expect(msAtFraction(0.5)).toBe(7_500);
    expect(msAtFraction(1.2)).toBe(TIMELINE_MS);
    expect(msAtFraction(-0.1)).toBe(0);
  });
});

describe("the ruler", () => {
  test("fit (zoom 1): a tick every 0.5 s, a label every second, «0 с» … «15 с»", () => {
    const { ticks, labels } = rulerMarks(1, 9_600);
    expect(ticks).toHaveLength(31);
    expect(ticks.slice(0, 3)).toEqual([
      { ms: 0, major: true },
      { ms: 500, major: false },
      { ms: 1_000, major: true },
    ]);
    expect(labels).toHaveLength(16);
    expect(labels.map((l) => l.text).slice(0, 3)).toEqual(["0 с", "1", "2"]);
    expect(labels.at(-1)).toEqual({ ms: 15_000, text: "15 с", align: "end", after: true });
    expect(labels[0]?.align).toBe("start");
    expect(labels[5]?.align).toBe("center");
  });

  test("labels after the montage's end are dim: 9 is in a 9.6 s montage, 10 is past it", () => {
    const { labels } = rulerMarks(1, 9_600);
    expect(labels.find((l) => l.ms === 9_000)?.after).toBe(false);
    expect(labels.find((l) => l.ms === 10_000)?.after).toBe(true);
    expect(rulerMarks(1, 0).labels.find((l) => l.ms === 0)?.after).toBe(false);
  });

  test("zoomed (2–4): a tick every 0.25 s, a label every 0.5 s", () => {
    const { ticks, labels } = rulerMarks(3, 9_600);
    expect(ticks).toHaveLength(61);
    expect(ticks.slice(0, 3).map((t) => t.ms)).toEqual([0, 250, 500]);
    expect(labels).toHaveLength(31);
    expect(labels.map((l) => l.text).slice(0, 4)).toEqual(["0 с", "0.5", "1", "1.5"]);
  });

  test("zoomed far (5–8): a tick every 0.1 s, a label every 0.5 s", () => {
    const { ticks, labels } = rulerMarks(8, 9_600);
    expect(ticks).toHaveLength(151);
    expect(ticks.filter((t) => t.major)).toHaveLength(31);
    expect(labels).toHaveLength(31);
  });
});

describe("clip boundaries", () => {
  const lengths = [2_400, 3_200, 2_000, 2_000];

  test("where each boundary is: 0, the clip ends, the total", () => {
    expect([0, 1, 2, 3, 4].map((b) => boundaryMs(lengths, b))).toEqual([0, 2_400, 5_600, 7_600, 9_600]);
    expect(() => boundaryMs(lengths, 5)).toThrow(RangeError);
  });

  test("a drop goes to the nearest boundary; past the end, to the end", () => {
    expect(boundaryAt(lengths, 0)).toBe(0);
    expect(boundaryAt(lengths, 1_100)).toBe(0);
    expect(boundaryAt(lengths, 1_300)).toBe(1);
    expect(boundaryAt(lengths, 6_000)).toBe(2);
    expect(boundaryAt(lengths, 14_000)).toBe(4);
    expect(boundaryAt([], 3_000)).toBe(0);
  });

  test("an edge near a target snaps to it; one too far keeps its place", () => {
    expect(snapEdge(4_000, [4_100], 150)).toBe(4_100);
    expect(snapEdge(4_000, [4_200], 150)).toBe(4_000);
    expect(snapEdge(4_000, [3_900, 4_050], 150)).toBe(4_050);
    expect(snapEdge(4_000, [], 150)).toBe(4_000);
  });
});

describe("a clip's film strip", () => {
  test("24 px frames, one more than fit so the strip never ends short", () => {
    expect(tileCount(0)).toBe(1);
    expect(tileCount(24)).toBe(2);
    expect(tileCount(25)).toBe(3);
    expect(tileCount(170)).toBe(9);
  });
});
