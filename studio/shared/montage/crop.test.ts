import { describe, expect, test } from "bun:test";
import { collageRects } from "./collage";
import { FOCUS_FALLBACK } from "./constants";
import { coverCrop, resolveFocus } from "./crop";
import { mulberry32, pick, randInt } from "./random.testkit";
import type { Size } from "./types";

describe("resolveFocus", () => {
  test("uses the (0.5, 0.38) fallback when there is no focus", () => {
    expect(resolveFocus(null)).toEqual({ x: 0.5, y: 0.38 });
    expect(resolveFocus(undefined)).toEqual({ x: 0.5, y: 0.38 });
    expect(FOCUS_FALLBACK).toEqual({ x: 0.5, y: 0.38 });
  });

  test("keeps a valid focus as it is", () => {
    expect(resolveFocus({ x: 0.2, y: 0.9 })).toEqual({ x: 0.2, y: 0.9 });
    expect(resolveFocus({ x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
  });

  test("clamps a focus outside the image into 0..1", () => {
    expect(resolveFocus({ x: -3, y: 7 })).toEqual({ x: 0, y: 1 });
  });

  test("replaces a non-finite coordinate with the fallback's", () => {
    expect(resolveFocus({ x: Number.NaN, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
    expect(resolveFocus({ x: 0.1, y: Number.POSITIVE_INFINITY })).toEqual({ x: 0.1, y: 0.38 });
  });
});

describe("coverCrop: exact cases", () => {
  const full: Size = { w: 1080, h: 1920 };

  test("a source with the cell's aspect is used whole", () => {
    expect(coverCrop({ w: 720, h: 1280 }, full, null)).toEqual({ x: 0, y: 0, w: 720, h: 1280 });
  });

  test("a wider source is cropped in width, centred on the focus (1600x1000 into 1080x1920)", () => {
    // crop height 1000, width floor(1000 * 1080 / 1920) = 562, x = round(800 - 281) = 519.
    expect(coverCrop({ w: 1600, h: 1000 }, full, { x: 0.5, y: 0.5 })).toEqual({ x: 519, y: 0, w: 562, h: 1000 });
  });

  test("a taller source is cropped in height, centred on the fallback focus (1000x3000 into 1080x1920)", () => {
    // crop width 1000, height floor(1000 * 1920 / 1080) = 1777, y = round(0.38 * 3000 - 888.5) = 252.
    expect(coverCrop({ w: 1000, h: 3000 }, full, null)).toEqual({ x: 0, y: 252, w: 1000, h: 1777 });
  });

  test("focus at the left edge pins the crop to x = 0", () => {
    expect(coverCrop({ w: 1600, h: 1000 }, full, { x: 0, y: 0.5 }).x).toBe(0);
  });

  test("focus at the right edge pins the crop to the last column that fits", () => {
    const crop = coverCrop({ w: 1600, h: 1000 }, full, { x: 1, y: 0.5 });
    expect(crop.x + crop.w).toBe(1600);
  });

  test("focus at the top and bottom edges pins the crop to those edges", () => {
    const source = { w: 1000, h: 3000 };
    expect(coverCrop(source, full, { x: 0.5, y: 0 }).y).toBe(0);
    const bottom = coverCrop(source, full, { x: 0.5, y: 1 });
    expect(bottom.y + bottom.h).toBe(3000);
  });

  test("a wide cell (1080x954) crops a portrait photo in height around the focus", () => {
    const crop = coverCrop({ w: 720, h: 1280 }, { w: 1080, h: 954 }, { x: 0.5, y: 0.38 });
    expect(crop.w).toBe(720);
    expect(crop.h).toBe(636); // 720 * 954 / 1080 = 636 exactly
    expect(crop.y).toBe(Math.round(0.38 * 1280 - 636 / 2));
  });

  test("a 1x1 source and an extreme aspect never give an empty crop", () => {
    expect(coverCrop({ w: 1, h: 1 }, full, null)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const thin = coverCrop({ w: 1, h: 4000 }, { w: 1080, h: 954 }, null);
    expect(thin.w).toBe(1);
    expect(thin.h).toBeGreaterThanOrEqual(1);
  });

  test.each([
    [{ w: 0, h: 10 }, { w: 10, h: 10 }],
    [{ w: 10, h: 10.5 }, { w: 10, h: 10 }],
    [{ w: 10, h: 10 }, { w: 0, h: 10 }],
    [{ w: Number.NaN, h: 10 }, { w: 10, h: 10 }],
  ])("refuses a degenerate size (%o, %o)", (source, cell) => {
    expect(() => coverCrop(source, cell, null)).toThrow(RangeError);
  });
});

describe("coverCrop: properties over random sources, cells and focus points", () => {
  const cells: Size[] = [{ w: 1080, h: 1920 }, ...(["collage2", "collage3", "collage4"] as const).flatMap((l) => collageRects(l).map((r) => ({ w: r.w, h: r.h })))];

  test("the crop is whole pixels, non-empty and never leaves the source", () => {
    const rand = mulberry32(0xc0de);
    for (let run = 0; run < 5000; run++) {
      const source = { w: randInt(rand, 1, 6000), h: randInt(rand, 1, 8000) };
      const cell = pick(rand, cells);
      // Half the time an edge or corner focus, the rest anywhere (also slightly out of range).
      const edge = rand() < 0.5;
      const focus = edge ? { x: pick(rand, [0, 1, 0.5]), y: pick(rand, [0, 1, 0.38]) } : { x: rand() * 1.4 - 0.2, y: rand() * 1.4 - 0.2 };
      const c = coverCrop(source, cell, focus);
      for (const v of [c.x, c.y, c.w, c.h]) expect(Number.isInteger(v)).toBe(true);
      expect(c.w).toBeGreaterThanOrEqual(1);
      expect(c.h).toBeGreaterThanOrEqual(1);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(source.w);
      expect(c.y + c.h).toBeLessThanOrEqual(source.h);
    }
  });

  test("the crop has the cell's aspect within one source pixel and spans the source on one axis (cover)", () => {
    const rand = mulberry32(0xa5be);
    for (let run = 0; run < 3000; run++) {
      const source = { w: randInt(rand, 20, 6000), h: randInt(rand, 20, 8000) };
      const cell = pick(rand, cells);
      const c = coverCrop(source, cell, { x: rand(), y: rand() });
      expect(c.w === source.w || c.h === source.h).toBe(true);
      // |c.w / c.h - cell.w / cell.h| corresponds to under one pixel on the cropped side.
      expect(Math.abs(c.w * cell.h - c.h * cell.w)).toBeLessThanOrEqual(Math.max(cell.w, cell.h));
    }
  });

  test("when the crop is not pinned by an edge it is centred on the focus within half a pixel", () => {
    const rand = mulberry32(0xf0c5);
    for (let run = 0; run < 3000; run++) {
      const source = { w: randInt(rand, 50, 6000), h: randInt(rand, 50, 8000) };
      const cell = pick(rand, cells);
      const focus = { x: rand(), y: rand() };
      const c = coverCrop(source, cell, focus);
      if (c.x > 0 && c.x + c.w < source.w) expect(Math.abs(c.x + c.w / 2 - focus.x * source.w)).toBeLessThanOrEqual(0.5);
      if (c.y > 0 && c.y + c.h < source.h) expect(Math.abs(c.y + c.h / 2 - focus.y * source.h)).toBeLessThanOrEqual(0.5);
    }
  });

  test("the focus point always stays inside the crop", () => {
    const rand = mulberry32(0xf1f1);
    for (let run = 0; run < 3000; run++) {
      const source = { w: randInt(rand, 50, 6000), h: randInt(rand, 50, 8000) };
      const cell = pick(rand, cells);
      const focus = { x: rand(), y: rand() };
      const c = coverCrop(source, cell, focus);
      expect(focus.x * source.w).toBeGreaterThanOrEqual(c.x - 0.5);
      expect(focus.x * source.w).toBeLessThanOrEqual(c.x + c.w + 0.5);
      expect(focus.y * source.h).toBeGreaterThanOrEqual(c.y - 0.5);
      expect(focus.y * source.h).toBeLessThanOrEqual(c.y + c.h + 0.5);
    }
  });

  test("the same input always gives the same crop", () => {
    const a = coverCrop({ w: 4032, h: 3024 }, { w: 534, h: 954 }, { x: 0.31, y: 0.62 });
    const b = coverCrop({ w: 4032, h: 3024 }, { w: 534, h: 954 }, { x: 0.31, y: 0.62 });
    expect(a).toEqual(b);
  });
});
