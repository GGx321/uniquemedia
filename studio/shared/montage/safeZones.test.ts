import { describe, expect, test } from "bun:test";
import { FRAME_H, FRAME_W } from "./constants";
import { reelsSafeZones, SAFE_BOTTOM_PERCENT, SAFE_RIGHT_FROM_PERCENT, SAFE_RIGHT_PERCENT, SAFE_RIGHT_TO_PERCENT, zonesHit } from "./safeZones";

describe("reelsSafeZones: the mockup's zones (bottom 20%, right 15% from 40% to 80% of the height)", () => {
  test("the percentages are the plan's", () => {
    expect([SAFE_BOTTOM_PERCENT, SAFE_RIGHT_PERCENT, SAFE_RIGHT_FROM_PERCENT, SAFE_RIGHT_TO_PERCENT]).toEqual([20, 15, 40, 80]);
  });

  test("by default there are two zones: the bottom strip and the right strip, in pixels on 1080x1920", () => {
    expect(reelsSafeZones()).toEqual([
      { id: "bottom", rect: { x: 0, y: 1536, w: 1080, h: 384 } },
      { id: "right", rect: { x: 918, y: 768, w: 162, h: 768 } },
    ]);
  });

  test("a top zone can be added for the designer's artboards: 10% is 192 px", () => {
    const zones = reelsSafeZones({ topPercent: 10 });
    expect(zones.map((z) => z.id)).toEqual(["top", "bottom", "right"]);
    expect(zones[0]?.rect).toEqual({ x: 0, y: 0, w: 1080, h: 192 });
  });

  test("a top zone of 0 adds nothing", () => {
    expect(reelsSafeZones({ topPercent: 0 })).toEqual(reelsSafeZones());
  });

  test.each([-1, 101, 12.5, Number.NaN])("refuses a top zone of %p percent", (topPercent) => {
    expect(() => reelsSafeZones({ topPercent })).toThrow(RangeError);
  });

  test("every zone is whole pixels inside the frame", () => {
    for (const { rect } of reelsSafeZones({ topPercent: 15 })) {
      for (const v of [rect.x, rect.y, rect.w, rect.h]) expect(Number.isInteger(v)).toBe(true);
      expect(rect.x + rect.w).toBeLessThanOrEqual(FRAME_W);
      expect(rect.y + rect.h).toBeLessThanOrEqual(FRAME_H);
    }
  });

  test("returns fresh objects each call", () => {
    const first = reelsSafeZones();
    first.pop();
    expect(reelsSafeZones()).toHaveLength(2);
  });
});

describe("zonesHit", () => {
  const zones = reelsSafeZones();

  test("a box in the middle of the frame hits no zone", () => {
    expect(zonesHit({ x: 100, y: 400, w: 600, h: 200 }, zones)).toEqual([]);
  });

  test("a box overlapping the bottom strip hits it", () => {
    expect(zonesHit({ x: 100, y: 1500, w: 200, h: 100 }, zones).map((z) => z.id)).toEqual(["bottom"]);
  });

  test("a box that only touches a zone's edge does not hit it", () => {
    expect(zonesHit({ x: 0, y: 1436, w: 500, h: 100 }, zones)).toEqual([]);
    expect(zonesHit({ x: 818, y: 800, w: 100, h: 100 }, zones)).toEqual([]);
  });

  test("a box on the right strip hits it, and one there and low hits both", () => {
    expect(zonesHit({ x: 950, y: 900, w: 100, h: 100 }, zones).map((z) => z.id)).toEqual(["right"]);
    expect(zonesHit({ x: 950, y: 1500, w: 100, h: 100 }, zones).map((z) => z.id)).toEqual(["bottom", "right"]);
  });
});
