import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { focusFromFace } from "./focusPoint";
useNativeGlobals();

// S8: where on the face the crop is centred. The box centre, as fractions of the
// source image (see focusPoint.ts for why not the eyes line).

describe("focusFromFace", () => {
  test("is the centre of the box as fractions of the source", () => {
    expect(focusFromFace({ x: 100, y: 200, width: 200, height: 400 }, { width: 1000, height: 2000 })).toEqual({ x: 0.2, y: 0.2 });
  });

  test("puts a face in the middle of the image at (0.5, 0.5)", () => {
    expect(focusFromFace({ x: 400, y: 900, width: 200, height: 200 }, { width: 1000, height: 2000 })).toEqual({ x: 0.5, y: 0.5 });
  });

  test("rounds each coordinate to four decimals (a stored point needs no more)", () => {
    expect(focusFromFace({ x: 0, y: 0, width: 2_000 / 3, height: 5_000 / 3 }, { width: 1000, height: 1000 })).toEqual({ x: 0.3333, y: 0.8333 });
  });

  test("clamps a box that reaches past the top-left edge into 0..1", () => {
    expect(focusFromFace({ x: -300, y: -500, width: 100, height: 100 }, { width: 1000, height: 1000 })).toEqual({ x: 0, y: 0 });
  });

  test("clamps a box that reaches past the bottom-right edge into 0..1", () => {
    expect(focusFromFace({ x: 1_200, y: 1_500, width: 100, height: 100 }, { width: 1000, height: 1000 })).toEqual({ x: 1, y: 1 });
  });

  test("keeps a box exactly touching the edges at the edge value", () => {
    expect(focusFromFace({ x: 0, y: 0, width: 1000, height: 1000 }, { width: 1000, height: 1000 })).toEqual({ x: 0.5, y: 0.5 });
  });
});
