import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Orientation } from "./exif";
import { orientedRgb } from "./orient";
useNativeGlobals();

// Turning the decoded pixels upright (3f.2): the EXIF orientation applied after decode, and the alpha flattened onto black, in one pass
// that yields the 8-bit RGB the encoder takes. The source here is 3 wide and 2 tall, pixel i holding the value i in its red channel.

const rgbaOf = (values: readonly number[]): Uint8Array => Uint8Array.from(values.flatMap((v) => [v, 0, 0, 255]));
const redsOf = (rgb: Uint8Array): number[] => Array.from({ length: rgb.length / 3 }, (_, i) => rgb[i * 3] ?? -1);

const SOURCE = rgbaOf([0, 1, 2, 3, 4, 5]);

// Row-major source indices of each result, and its size. See the EXIF spec: 2 mirrors, 3 turns 180, 4 flips, 5 transposes, 6 turns a
// quarter clockwise, 7 transverses, 8 turns a quarter counter-clockwise.
const EXPECTED: Record<Orientation, { width: number; height: number; reds: number[] }> = {
  1: { width: 3, height: 2, reds: [0, 1, 2, 3, 4, 5] },
  2: { width: 3, height: 2, reds: [2, 1, 0, 5, 4, 3] },
  3: { width: 3, height: 2, reds: [5, 4, 3, 2, 1, 0] },
  4: { width: 3, height: 2, reds: [3, 4, 5, 0, 1, 2] },
  5: { width: 2, height: 3, reds: [0, 3, 1, 4, 2, 5] },
  6: { width: 2, height: 3, reds: [3, 0, 4, 1, 5, 2] },
  7: { width: 2, height: 3, reds: [5, 2, 4, 1, 3, 0] },
  8: { width: 2, height: 3, reds: [2, 5, 1, 4, 0, 3] },
};

describe("orientedRgb", () => {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    test(`orientation ${orientation} puts every pixel where the EXIF spec says`, () => {
      const out = orientedRgb(SOURCE, 3, 2, orientation);
      const want = EXPECTED[orientation];
      expect({ width: out.width, height: out.height, reds: redsOf(out.rgb) }).toEqual(want);
    });
  }

  test("a quarter turn swaps the width and the height", () => {
    const out = orientedRgb(new Uint8Array(5 * 7 * 4), 5, 7, 6);
    expect([out.width, out.height, out.rgb.length]).toEqual([7, 5, 7 * 5 * 3]);
  });

  test("keeps the green and blue of a pixel with its red", () => {
    const out = orientedRgb(Uint8Array.from([10, 20, 30, 255]), 1, 1, 3);
    expect(Array.from(out.rgb)).toEqual([10, 20, 30]);
  });

  test("a fully transparent pixel becomes black, whatever colour it held", () => {
    const out = orientedRgb(Uint8Array.from([200, 100, 50, 0]), 1, 1, 1);
    expect(Array.from(out.rgb)).toEqual([0, 0, 0]);
  });

  test("a half transparent pixel is mixed with black in proportion", () => {
    const out = orientedRgb(Uint8Array.from([200, 100, 50, 128]), 1, 1, 1);
    expect(Array.from(out.rgb)).toEqual([Math.round((200 * 128) / 255), Math.round((100 * 128) / 255), Math.round((50 * 128) / 255)]);
  });

  test("an opaque pixel is untouched by the flattening (alpha 255 is exact)", () => {
    const out = orientedRgb(Uint8Array.from([255, 254, 1, 255]), 1, 1, 1);
    expect(Array.from(out.rgb)).toEqual([255, 254, 1]);
  });

  test("refuses pixels whose length is not width x height x 4", () => {
    expect(() => orientedRgb(new Uint8Array(11), 3, 1, 1)).toThrow(RangeError);
  });

  test("refuses a side that is not a whole positive number", () => {
    expect(() => orientedRgb(new Uint8Array(0), 0, 1, 1)).toThrow(RangeError);
    expect(() => orientedRgb(new Uint8Array(8), 1.5, 1, 1)).toThrow(RangeError);
  });

  test("does not change the pixels it was given", () => {
    const copy = SOURCE.slice();
    orientedRgb(SOURCE, 3, 2, 6);
    expect(SOURCE).toEqual(copy);
  });
});
