import { describe, expect, test } from "bun:test";
import { largestFaceInSource } from "./largestFace";
import { FACE_ROW } from "./yunet";

// S8: detect-only. Picks the largest face YuNet found and maps its box from the
// image detection ran on (normalised to at most 1280 px) back to the SOURCE image.

function row(x: number, y: number, width: number, height: number, score = 0.9): Float32Array {
  const r = new Float32Array(FACE_ROW);
  r[0] = x;
  r[1] = y;
  r[2] = width;
  r[3] = height;
  r[14] = score;
  return r;
}

const same = { width: 400, height: 800 };

describe("largestFaceInSource", () => {
  test("returns null when nothing was detected", () => {
    expect(largestFaceInSource([], same, same)).toBeNull();
  });

  test("returns the box unchanged when detection ran on the source itself", () => {
    expect(largestFaceInSource([row(100, 200, 50, 60)], same, same)).toEqual({ x: 100, y: 200, width: 50, height: 60 });
  });

  test("picks the face with the largest area, not the first or the best-scored", () => {
    const rows = [row(10, 10, 20, 20, 0.99), row(100, 100, 80, 90, 0.7), row(300, 300, 30, 30, 0.95)];
    expect(largestFaceInSource(rows, same, same)).toEqual({ x: 100, y: 100, width: 80, height: 90 });
  });

  test("keeps the first of two equal-area faces (NMS order is score descending)", () => {
    const rows = [row(10, 10, 40, 40, 0.95), row(200, 200, 40, 40, 0.8)];
    expect(largestFaceInSource(rows, same, same)).toEqual({ x: 10, y: 10, width: 40, height: 40 });
  });

  test("scales the box back to source pixels when detection ran on a downscaled copy", () => {
    // A 4000x3000 source detected at 1280x960 (scale 3.125).
    const box = largestFaceInSource([row(640, 480, 128, 96)], { width: 1280, height: 960 }, { width: 4000, height: 3000 });
    expect(box).toEqual({ x: 2000, y: 1500, width: 400, height: 300 });
  });

  test("scales each axis by its own ratio (rounding of the normalised size makes them differ slightly)", () => {
    const box = largestFaceInSource([row(10, 10, 10, 10)], { width: 100, height: 50 }, { width: 200, height: 150 });
    expect(box).toEqual({ x: 20, y: 30, width: 20, height: 30 });
  });

  test("ignores a row with no area", () => {
    expect(largestFaceInSource([row(10, 10, 0, 50), row(10, 10, 50, 0)], same, same)).toBeNull();
  });

  test("ignores a row holding a non-finite number", () => {
    expect(largestFaceInSource([row(Number.NaN, 10, 50, 50)], same, same)).toBeNull();
  });

  test("keeps a box that reaches past the image edge (YuNet boxes do)", () => {
    expect(largestFaceInSource([row(-5, -3, 50, 60)], same, same)).toEqual({ x: -5, y: -3, width: 50, height: 60 });
  });
});
