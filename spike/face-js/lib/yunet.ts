/**
 * Port of OpenCV 5.0.0 cv::FaceDetectorYN (modules/objdetect/src/face_detect.cpp) on top of
 * onnxruntime-web, for face_detection_yunet_2023mar.onnx.
 *
 * Followed from face_detect.cpp:
 * - padW/padH = ((size - 1) / 32 + 1) * 32; the image is padded right/bottom with zeros
 *   (padWithDivisor -> copyMakeBorder BORDER_CONSTANT 0), never resized.
 * - dnn::blobFromImage(pad_image) with defaults: NCHW float32, raw 0..255, BGR (no swapRB),
 *   no mean, scale 1.
 * - outputs cls/obj/bbox/kps for strides 8, 16, 32; cls and obj clamped to [0, 1],
 *   score = sqrt(cls * obj); rows with score < threshold are skipped.
 * - box: cx = (c + dx) * s, cy = (r + dy) * s, w = exp(dw) * s, h = exp(dh) * s, x1 = cx - w/2;
 *   landmark = (k + c|r) * s. Row layout (15 floats): x, y, w, h, re, le, nt, rcm, lcm, score.
 * - NMS only when more than one row survives: dnn::NMSBoxes over Rect2i(int(x), int(y), int(w),
 *   int(h)) with eta 1 and top_k (modules/dnn/src/nms.inl.hpp: keep score > threshold, stable
 *   sort descending, truncate to top_k, keep a box when IoU <= nms threshold vs every kept box;
 *   IoU is 1 - float(jaccardDistance) with integer Rect areas from core/types.hpp).
 * Float32 steps are mirrored with Math.fround so thresholds and int() truncation see the same
 * values OpenCV sees.
 */
import * as ort from "onnxruntime-web";
import type { BgrImage } from "./decode.ts";
import { withInputShape } from "./onnx-shape.ts";

export const FACE_ROW = 15;
const DIVISOR = 32;
const STRIDES = [8, 16, 32] as const;
const OUTPUTS = ["cls", "obj", "bbox", "kps"] as const;

export interface DetectorOptions {
  scoreThreshold: number;
  nmsThreshold: number;
  topK: number;
}

export interface Detector {
  session: ort.InferenceSession;
  options: DetectorOptions;
}

const f32 = Math.fround;

export async function createDetector(
  modelBytes: Uint8Array,
  options: DetectorOptions,
  sessionOptions: ort.InferenceSession.SessionOptions
): Promise<Detector> {
  const dynamic = withInputShape(modelBytes, "input", [1, 3, "height", "width"]);
  const session = await ort.InferenceSession.create(dynamic, sessionOptions);
  return { session, options };
}

function padded(size: number): number {
  return (Math.floor((size - 1) / DIVISOR) + 1) * DIVISOR;
}

function toBlob(img: BgrImage, padW: number, padH: number): Float32Array {
  const plane = padW * padH;
  const blob = new Float32Array(3 * plane);
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    let src = y * width * 3;
    const dstRow = y * padW;
    for (let x = 0; x < width; x++, src += 3) {
      blob[dstRow + x] = data[src];
      blob[plane + dstRow + x] = data[src + 1];
      blob[2 * plane + dstRow + x] = data[src + 2];
    }
  }
  return blob;
}

function outputData(result: ort.InferenceSession.OnnxValueMapType, name: string, expected: number): Float32Array {
  const t = result[name];
  if (!t || t.type !== "float32" || !(t.data instanceof Float32Array)) throw new Error(`yunet: missing float32 output ${name}`);
  if (t.data.length !== expected) throw new Error(`yunet: ${name} has ${t.data.length} values, expected ${expected}`);
  return t.data;
}

interface IntRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** (a & b).area() per core/types.hpp operator&=, integer rects. */
function intersectionArea(a: IntRect, b: IntRect): number {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return 0;
  const xMin = a.x < b.x ? a : b;
  const xMax = a.x < b.x ? b : a;
  const yMin = a.y < b.y ? a : b;
  const yMax = a.y < b.y ? b : a;
  if ((xMin.x < 0 && xMin.x + xMin.w < xMax.x) || (yMin.y < 0 && yMin.y + yMin.h < yMax.y)) return 0;
  const w = Math.min(xMin.w - (xMax.x - xMin.x), xMax.w);
  const h = Math.min(yMin.h - (yMax.y - yMin.y), yMax.h);
  return w <= 0 || h <= 0 ? 0 : w * h;
}

/** rectOverlap in nms.cpp: 1.f - float(jaccardDistance(a, b)). */
function overlap(a: IntRect, b: IntRect): number {
  const aa = a.w * a.h;
  const ab = b.w * b.h;
  if (aa + ab <= 0) return 1;
  const aab = intersectionArea(a, b);
  return f32(1 - f32(1 - aab / (aa + ab - aab)));
}

/** scoreThreshold is already float32; scores come from a Float32Array. */
function nmsBoxes(boxes: IntRect[], scores: number[], scoreThreshold: number, nmsThreshold: number, topK: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] > scoreThreshold) order.push(i);
  order.sort((i, j) => scores[j] - scores[i] || i - j);
  if (topK > 0 && topK < order.length) order.length = topK;
  const keep: number[] = [];
  const thr = f32(nmsThreshold);
  for (const idx of order) {
    let ok = true;
    for (let k = 0; k < keep.length && ok; k++) ok = overlap(boxes[idx], boxes[keep[k]]) <= thr;
    if (ok) keep.push(idx);
  }
  return keep;
}

/** Faces in OpenCV's row layout, in NMS output order (score descending). */
export async function detect(detector: Detector, img: BgrImage): Promise<Float32Array[]> {
  const { scoreThreshold, nmsThreshold, topK } = detector.options;
  const padW = padded(img.width);
  const padH = padded(img.height);
  const input = new ort.Tensor("float32", toBlob(img, padW, padH), [1, 3, padH, padW]);
  const result = await detector.session.run({ input });
  input.dispose();

  const thr = f32(scoreThreshold);
  const faces: Float32Array[] = [];
  for (const stride of STRIDES) {
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
    const n = cols * rows;
    const [cls, obj, bbox, kps] = OUTPUTS.map((o, i) => outputData(result, `${o}_${stride}`, n * [1, 1, 4, 10][i]));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const clsScore = Math.max(Math.min(cls[idx], 1), 0);
        const objScore = Math.max(Math.min(obj[idx], 1), 0);
        const score = f32(Math.sqrt(f32(clsScore * objScore)));
        if (score < thr) continue;
        const cx = f32(f32(c + bbox[idx * 4]) * stride);
        const cy = f32(f32(r + bbox[idx * 4 + 1]) * stride);
        const w = f32(f32(Math.exp(bbox[idx * 4 + 2])) * stride);
        const h = f32(f32(Math.exp(bbox[idx * 4 + 3])) * stride);
        const face = new Float32Array(FACE_ROW);
        face[0] = cx - w / 2;
        face[1] = cy - h / 2;
        face[2] = w;
        face[3] = h;
        for (let k = 0; k < 5; k++) {
          face[4 + 2 * k] = f32(f32(kps[idx * 10 + 2 * k] + c) * stride);
          face[5 + 2 * k] = f32(f32(kps[idx * 10 + 2 * k + 1] + r) * stride);
        }
        face[14] = score;
        faces.push(face);
      }
    }
  }
  for (const name of Object.keys(result)) result[name].dispose();

  if (faces.length <= 1) return faces;
  const boxes = faces.map((f) => ({ x: Math.trunc(f[0]), y: Math.trunc(f[1]), w: Math.trunc(f[2]), h: Math.trunc(f[3]) }));
  const keep = nmsBoxes(boxes, faces.map((f) => f[14]), thr, nmsThreshold, topK);
  return keep.map((i) => faces[i]);
}
