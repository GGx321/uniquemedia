import { expect, test } from "bun:test";
import type { BgrImage } from "./pixels";
import { ALIGNED, cosine, similarityTransform, warpAffine112 } from "./sface";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("cosine of a vector with itself is 1", () => {
  const a = Float32Array.from([1, 2, 3, 4]);
  expect(cosine(a, a)).toBeCloseTo(1, 6);
});

test("cosine of orthogonal vectors is 0", () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  expect(cosine(a, b)).toBeCloseTo(0, 6);
});

test("cosine of opposite vectors is -1", () => {
  const a = Float32Array.from([1, 2, 3]);
  const b = Float32Array.from([-1, -2, -3]);
  expect(cosine(a, b)).toBeCloseTo(-1, 6);
});

test("cosine is invariant to positive scaling of either vector", () => {
  const a = Float32Array.from([3, 4]);
  const b = Float32Array.from([3, 4]);
  const scaled = Float32Array.from([30, 40]);
  expect(cosine(a, b)).toBeCloseTo(cosine(a, scaled), 6);
});

// The 5 face_recognize.cpp reference points (re, le, nt, rcm, lcm), laid out
// the way similarityTransform reads a YuNet row (face[4..13]).
const DST_AS_FACE_ROW = new Float32Array(14);
DST_AS_FACE_ROW[4] = 38.2946;
DST_AS_FACE_ROW[5] = 51.6963;
DST_AS_FACE_ROW[6] = 73.5318;
DST_AS_FACE_ROW[7] = 51.5014;
DST_AS_FACE_ROW[8] = 56.0252;
DST_AS_FACE_ROW[9] = 71.7366;
DST_AS_FACE_ROW[10] = 41.5493;
DST_AS_FACE_ROW[11] = 92.3655;
DST_AS_FACE_ROW[12] = 70.7299;
DST_AS_FACE_ROW[13] = 92.2041;

test("similarityTransform of landmarks that already sit at the reference points is close to the identity (scale 1, no rotation)", () => {
  const [a, b, , d, e] = similarityTransform(DST_AS_FACE_ROW);
  expect(a).toBeCloseTo(1, 2);
  expect(b).toBeCloseTo(0, 2);
  expect(d).toBeCloseTo(0, 2);
  expect(e).toBeCloseTo(1, 2);
});

test("similarityTransform of landmarks scaled 2x and shifted returns a matrix that maps them back to the reference points", () => {
  const face = new Float32Array(14);
  for (let i = 0; i < 5; i++) {
    face[4 + 2 * i] = DST_AS_FACE_ROW[4 + 2 * i]! * 2 + 100;
    face[5 + 2 * i] = DST_AS_FACE_ROW[5 + 2 * i]! * 2 + 50;
  }
  const m = similarityTransform(face);
  for (let i = 0; i < 5; i++) {
    const x = face[4 + 2 * i]!;
    const y = face[5 + 2 * i]!;
    const mx = m[0]! * x + m[1]! * y + m[2]!;
    const my = m[3]! * x + m[4]! * y + m[5]!;
    expect(mx).toBeCloseTo(DST_AS_FACE_ROW[4 + 2 * i]!, 0);
    expect(my).toBeCloseTo(DST_AS_FACE_ROW[5 + 2 * i]!, 0);
  }
});

function solidImage(width: number, height: number, b: number, g: number, r: number): BgrImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = b;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = r;
  }
  return { width, height, data };
}

test("warpAffine112 with the identity matrix copies the top-left 112x112 region", () => {
  const img = solidImage(200, 200, 10, 20, 30);
  const out = warpAffine112(img, [1, 0, 0, 0, 1, 0]);
  expect(out.length).toBe(ALIGNED * ALIGNED * 3);
  expect(out[0]).toBe(10);
  expect(out[1]).toBe(20);
  expect(out[2]).toBe(30);
  expect(out[out.length - 3]).toBe(10);
});

test("warpAffine112 reads out-of-bounds neighbours as 0 (BORDER_CONSTANT)", () => {
  const img = solidImage(50, 50, 200, 200, 200);
  const out = warpAffine112(img, [1, 0, 0, 0, 1, 0]);
  // (111, 111) maps to source (111, 111), outside the 50x50 source: must be 0.
  const o = (111 * ALIGNED + 111) * 3;
  expect(out[o]).toBe(0);
  expect(out[o + 1]).toBe(0);
  expect(out[o + 2]).toBe(0);
});

test("warpAffine112 with a pure translation shifts the sampled region", () => {
  const img = new Uint8Array(4 * 4 * 3);
  // Distinct blue value per pixel so the shift is observable.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) img[(y * 4 + x) * 3] = y * 4 + x;
  const bgr: BgrImage = { width: 4, height: 4, data: img };
  // M is the forward (src -> dst) transform, as similarityTransform returns and
  // OpenCV's warpAffine expects; the function inverts it to sample. Forward
  // dst = src - 1 in x means the inverse sampling is src = dst + 1: output
  // (0,0) must sample source (1,0).
  const out = warpAffine112(bgr, [1, 0, -1, 0, 1, 0]);
  expect(out[0]).toBe(1); // output (0,0) samples source (1,0) = value 1
});
