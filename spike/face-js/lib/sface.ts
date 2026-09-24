/**
 * Port of OpenCV 5.0.0 cv::FaceRecognizerSF (modules/objdetect/src/face_recognize.cpp) on top of
 * onnxruntime-web, for face_recognition_sface_2021dec.onnx.
 *
 * alignCrop: getSimilarityTransformMatrix(5 YuNet landmarks -> the fixed 112x112 reference
 * points below), then warpAffine(..., Size(112, 112), INTER_LINEAR) with the default
 * BORDER_CONSTANT 0.
 * feature: dnn::blobFromImage(aligned, 1, Size(112, 112), Scalar(0, 0, 0), swapRB = true):
 * NCHW float32, RGB, raw 0..255 (the model normalises internally with its own Sub/Mul nodes).
 * match(FR_COSINE): L2-normalise both 128-d features, then their dot product.
 */
import * as ort from "onnxruntime-web";
import type { BgrImage } from "./decode.ts";

export const ALIGNED = 112;
const f32 = Math.fround;

/** Reference landmarks (re, le, nt, rcm, lcm) and their mean, as float literals in face_recognize.cpp. */
const DST: ReadonlyArray<readonly [number, number]> = [
  [f32(38.2946), f32(51.6963)],
  [f32(73.5318), f32(51.5014)],
  [f32(56.0252), f32(71.7366)],
  [f32(41.5493), f32(92.3655)],
  [f32(70.7299), f32(92.2041)],
];
const DST_MEAN: readonly [number, number] = [f32(56.0262), f32(71.9008)];

export async function createRecognizer(
  modelBytes: Uint8Array,
  sessionOptions: ort.InferenceSession.SessionOptions
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelBytes, sessionOptions);
}

/**
 * getSimilarityTransformMatrix: Umeyama least-squares similarity from the landmarks to DST,
 * returned as a row-major 2x3 matrix (double). OpenCV builds A = cov(dst, src), takes its SVD
 * and forms T = U * diag(1, det(A) < 0 ? -1 : 1) * Vt, scale = (s0 + d1 * s1) / var(src).
 * For a 2x2 A that product is exactly the rotation by atan2(A10 - A01, A00 + A11), and
 * s0 + d1 * s1 = hypot(A00 + A11, A10 - A01), in the rank-2 and the rank-1 branches alike;
 * the closed form is used instead of a numeric 2x2 SVD. Float32 intermediates are mirrored.
 */
export function similarityTransform(face: Float32Array): number[] {
  const src: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) src.push([face[4 + 2 * i], face[5 + 2 * i]]);
  const mean = (k: 0 | 1): number => {
    let s = src[0][k];
    for (let i = 1; i < 5; i++) s = f32(s + src[i][k]);
    return f32(s / 5);
  };
  const srcMean: [number, number] = [mean(0), mean(1)];
  const sd = src.map(([x, y]) => [f32(x - srcMean[0]), f32(y - srcMean[1])]);
  const dd = DST.map(([x, y]) => [f32(x - DST_MEAN[0]), f32(y - DST_MEAN[1])]);

  let a00 = 0, a01 = 0, a10 = 0, a11 = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < 5; i++) {
    a00 += f32(dd[i][0] * sd[i][0]);
    a01 += f32(dd[i][0] * sd[i][1]);
    a10 += f32(dd[i][1] * sd[i][0]);
    a11 += f32(dd[i][1] * sd[i][1]);
    var1 += f32(sd[i][0] * sd[i][0]);
    var2 += f32(sd[i][1] * sd[i][1]);
  }
  a00 /= 5; a01 /= 5; a10 /= 5; a11 /= 5; var1 /= 5; var2 /= 5;

  const trace = a00 + a11;
  const skew = a10 - a01;
  const norm = Math.hypot(trace, skew);
  // A == 0 (all landmarks equal): OpenCV ends up with scale 0, so the rotation does not matter.
  const cos = norm > 0 ? trace / norm : 1;
  const sin = norm > 0 ? skew / norm : 0;
  const scale = (1 / (var1 + var2)) * norm;
  const ts0 = cos * srcMean[0] - sin * srcMean[1];
  const ts1 = sin * srcMean[0] + cos * srcMean[1];
  return [scale * cos, -scale * sin, DST_MEAN[0] - scale * ts0, scale * sin, scale * cos, DST_MEAN[1] - scale * ts1];
}

/** cvRound / v_round: round half to even. */
function rint(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Single-rounded float32 a * b + c, as v_fma computes it (the product is exact in double). */
function fma32(a: number, b: number, c: number): number {
  return f32(a * b + c);
}

/**
 * warpAffine(src, dst, M, Size(112, 112), INTER_LINEAR, BORDER_CONSTANT, 0) as OpenCV 5.0.0
 * runs it for CV_8UC3 with the default ALGO_HINT_ACCURATE (imgwarp.cpp + warp_kernels.simd.hpp,
 * SIMD path, which covers all 112 columns): M is inverted in double, cast to float32, source
 * coordinates come from float32 FMAs, the 2x2 neighbourhood is blended in float32 with FMAs,
 * rounded half-to-even and saturated to uint8. Neighbours outside the image read as 0.
 */
export function warpAffine112(img: BgrImage, m: readonly number[]): Uint8Array {
  let [m0, m1, m2, m3, m4, m5] = m;
  let d = m0 * m4 - m1 * m3;
  d = d !== 0 ? 1 / d : 0;
  const a11 = m4 * d;
  const a22 = m0 * d;
  m0 = a11; m1 *= -d; m3 *= -d; m4 = a22;
  const b1 = -m0 * m2 - m1 * m5;
  const b2 = -m3 * m2 - m4 * m5;
  const im = [m0, m1, b1, m3, m4, b2].map(f32);

  const { width, height, data } = img;
  const out = new Uint8Array(ALIGNED * ALIGNED * 3);
  const px = (x: number, y: number, ch: number): number =>
    x >= 0 && x < width && y >= 0 && y < height ? data[(y * width + x) * 3 + ch] : 0;

  for (let y = 0; y < ALIGNED; y++) {
    const mx = fma32(y, im[1], im[2]);
    const my = fma32(y, im[4], im[5]);
    for (let x = 0; x < ALIGNED; x++) {
      const sx = fma32(im[0], x, mx);
      const sy = fma32(im[3], x, my);
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const ax = f32(sx - ix);
      const ay = f32(sy - iy);
      const o = (y * ALIGNED + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = px(ix, iy, ch);
        const p01 = px(ix + 1, iy, ch);
        const p10 = px(ix, iy + 1, ch);
        const p11 = px(ix + 1, iy + 1, ch);
        const top = fma32(ax, p01 - p00, p00);
        const bottom = fma32(ax, p11 - p10, p10);
        const v = fma32(ay, f32(bottom - top), top);
        out[o + ch] = Math.max(0, Math.min(255, rint(v)));
      }
    }
  }
  return out;
}

export function alignCrop(img: BgrImage, face: Float32Array): Uint8Array {
  return warpAffine112(img, similarityTransform(face));
}

/** Raw 128-d SFace feature of an aligned 112x112 BGR crop. */
export async function feature(session: ort.InferenceSession, aligned: Uint8Array): Promise<Float32Array> {
  const plane = ALIGNED * ALIGNED;
  const blob = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    blob[i] = aligned[i * 3 + 2];
    blob[plane + i] = aligned[i * 3 + 1];
    blob[2 * plane + i] = aligned[i * 3];
  }
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const input = new ort.Tensor("float32", blob, [1, 3, ALIGNED, ALIGNED]);
  const result = await session.run({ [inputName]: input });
  input.dispose();
  const t = result[outputName];
  if (!t || !(t.data instanceof Float32Array)) throw new Error(`sface: missing float32 output ${outputName}`);
  const out = t.data.slice();
  t.dispose();
  return out;
}

/** match(..., FR_COSINE). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
