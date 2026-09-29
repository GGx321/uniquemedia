import { describe, expect, test } from "bun:test";
import { FRAME_H, FRAME_W } from "./constants";
import { DEFAULT_STICKER, DEFAULT_TEXT_Y, stickerBox, textBox } from "./layers";
import { mulberry32, pick, randInt } from "./random.testkit";

describe("plan facts from the mockup", () => {
  test("the default text row is centred at y = 0.195 (374.4 px of 1920)", () => {
    expect(DEFAULT_TEXT_Y).toBe(0.195);
    expect(DEFAULT_TEXT_Y * FRAME_H).toBeCloseTo(374.4, 9);
  });

  test("the default sticker box is centred at (0.741, 0.333) with size 0.203 of the frame width", () => {
    expect(DEFAULT_STICKER).toEqual({ x: 0.741, y: 0.333, size: 0.203 });
  });
});

describe("stickerBox: centre-anchored, size is a fraction of the frame width", () => {
  test("the mockup's sticker (0.741, 0.333, 0.203) is a 220x220 box at (690, 528)", () => {
    // width 0.203 * 1080 = 219.24 -> 220 (nearest even); x = round(800.28 - 110) = 690; y = round(639.36 - 110) = 529 -> 528 (even).
    expect(stickerBox(DEFAULT_STICKER)).toEqual({ x: 690, y: 528, w: 220, h: 220 });
  });

  test("a non-square sticker keeps its aspect: a 2:1 asset of size 0.5 is 540x270", () => {
    expect(stickerBox({ x: 0.5, y: 0.5, size: 0.5 }, { w: 200, h: 100 })).toEqual({ x: 270, y: 824, w: 540, h: 270 });
  });

  test("a sticker centred on the frame is centred", () => {
    expect(stickerBox({ x: 0.5, y: 0.5, size: 0.1 })).toEqual({ x: 486, y: 906, w: 108, h: 108 });
  });

  test("a sticker at a corner is clamped inside the frame, not cut off", () => {
    expect(stickerBox({ x: 0, y: 0, size: 0.6 })).toEqual({ x: 0, y: 0, w: 648, h: 648 });
    expect(stickerBox({ x: 1, y: 1, size: 0.6 })).toEqual({ x: 432, y: 1272, w: 648, h: 648 });
  });

  test("refuses a position outside 0..1 or a non-finite one, and an empty size", () => {
    expect(() => stickerBox({ x: 1.1, y: 0.5, size: 0.2 })).toThrow(RangeError);
    expect(() => stickerBox({ x: Number.NaN, y: 0.5, size: 0.2 })).toThrow(RangeError);
    expect(() => stickerBox({ x: 0.5, y: 0.5, size: 0 })).toThrow(RangeError);
    expect(() => stickerBox({ x: 0.5, y: 0.5, size: 0.2 }, { w: 0, h: 10 })).toThrow(RangeError);
  });

  test("random stickers: even offsets and sides, inside the frame, centred within 1.5 px unless clamped, deterministic", () => {
    const rand = mulberry32(71);
    const aspects = [{ w: 1, h: 1 }, { w: 2, h: 1 }, { w: 1, h: 2 }, { w: 720, h: 405 }, { w: 300, h: 720 }];
    for (let run = 0; run < 3000; run++) {
      const layer = { x: pick(rand, [0, 1, rand()]), y: pick(rand, [0, 1, rand()]), size: 0.05 + rand() * 0.55 };
      const aspect = pick(rand, aspects);
      const b = stickerBox(layer, aspect);
      for (const v of [b.x, b.y, b.w, b.h]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v % 2).toBe(0);
      }
      expect(b.w).toBeGreaterThanOrEqual(2);
      expect(b.h).toBeGreaterThanOrEqual(2);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(FRAME_W);
      expect(b.y + b.h).toBeLessThanOrEqual(FRAME_H);
      if (b.x > 0 && b.x + b.w < FRAME_W - 1) expect(Math.abs(b.x + b.w / 2 - layer.x * FRAME_W)).toBeLessThanOrEqual(1.5);
      if (b.y > 0 && b.y + b.h < FRAME_H - 1) expect(Math.abs(b.y + b.h / 2 - layer.y * FRAME_H)).toBeLessThanOrEqual(1.5);
      expect(stickerBox(layer, aspect)).toEqual(b);
    }
  });
});

describe("textBox: centre-anchored around the engine's rendered caption size", () => {
  // The contract carries only the box CENTRE (x, y) and a `scale`. The box size is the size of the engine's text raster
  // (3b lays out and rasterises, with `scale` already applied), so 3b passes that size in.
  test("the default text row (y = 0.195) with an 800x120 caption is at (140, 314)", () => {
    // x = round(540 - 400) = 140; y = round(374.4 - 60) = 314.
    expect(textBox({ x: 0.5, y: DEFAULT_TEXT_Y }, { w: 800, h: 120 })).toEqual({ x: 140, y: 314, w: 800, h: 120 });
  });

  test("the box keeps the raster's size exactly, even when it is odd", () => {
    const b = textBox({ x: 0.5, y: 0.5 }, { w: 801, h: 121 });
    expect([b.w, b.h]).toEqual([801, 121]);
    expect(b.x % 2).toBe(0);
    expect(b.y % 2).toBe(0);
  });

  test("a caption near an edge is clamped inside the frame", () => {
    expect(textBox({ x: 0, y: 0 }, { w: 600, h: 100 })).toEqual({ x: 0, y: 0, w: 600, h: 100 });
    expect(textBox({ x: 1, y: 1 }, { w: 600, h: 100 })).toEqual({ x: 480, y: 1820, w: 600, h: 100 });
  });

  test("a raster larger than the frame is refused", () => {
    expect(() => textBox({ x: 0.5, y: 0.5 }, { w: 1081, h: 100 })).toThrow(RangeError);
    expect(() => textBox({ x: 0.5, y: 0.5 }, { w: 100, h: 1921 })).toThrow(RangeError);
  });

  test("refuses an out-of-range centre and an empty raster", () => {
    expect(() => textBox({ x: -0.1, y: 0.5 }, { w: 100, h: 100 })).toThrow(RangeError);
    expect(() => textBox({ x: 0.5, y: 0.5 }, { w: 0, h: 100 })).toThrow(RangeError);
  });

  test("random captions: even offsets, inside the frame, centred within 1.5 px unless clamped", () => {
    const rand = mulberry32(72);
    for (let run = 0; run < 3000; run++) {
      const layer = { x: pick(rand, [0, 1, rand()]), y: pick(rand, [0, 1, rand()]) };
      const raster = { w: randInt(rand, 1, FRAME_W), h: randInt(rand, 1, 600) };
      const b = textBox(layer, raster);
      expect([b.w, b.h]).toEqual([raster.w, raster.h]);
      expect(b.x % 2).toBe(0);
      expect(b.y % 2).toBe(0);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(FRAME_W);
      expect(b.y + b.h).toBeLessThanOrEqual(FRAME_H);
      if (b.x > 0 && b.x + b.w < FRAME_W - 1) expect(Math.abs(b.x + b.w / 2 - layer.x * FRAME_W)).toBeLessThanOrEqual(1.5);
      if (b.y > 0 && b.y + b.h < FRAME_H - 1) expect(Math.abs(b.y + b.h / 2 - layer.y * FRAME_H)).toBeLessThanOrEqual(1.5);
    }
  });
});
