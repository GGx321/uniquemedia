import { expect, test } from "bun:test";
import type { BgrImage } from "./pixels";
import { detect, FACE_ROW } from "./yunet";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const STRIDES = [8, 16, 32] as const;
const OUTPUTS = ["cls", "obj", "bbox", "kps"] as const;
const WIDTHS_PER_OUTPUT = [1, 1, 4, 10] as const;

interface Cell {
  stride: 8 | 16 | 32;
  col: number;
  row: number;
  cls: number;
  obj: number;
  /** [dx, dy, dw, dh] as YuNet's raw box regression (before the stride/exp transform). */
  bbox: readonly [number, number, number, number];
  /** 5 landmark offsets (re, le, nt, rcm, lcm), each [kx, ky] relative to the cell. */
  kps: ReadonlyArray<readonly [number, number]>;
}

/** A fake ort.InferenceSession.run() result: zero everywhere except the given cells. */
function fakeOutputs(padW: number, padH: number, cells: readonly Cell[]): Record<string, { type: "float32"; data: Float32Array; dispose: () => void }> {
  const out: Record<string, { type: "float32"; data: Float32Array; dispose: () => void }> = {};
  for (const stride of STRIDES) {
    const cols = Math.floor(padW / stride);
    const rows = Math.floor(padH / stride);
    const n = cols * rows;
    for (let oi = 0; oi < OUTPUTS.length; oi++) {
      const name = `${OUTPUTS[oi]}_${stride}`;
      out[name] = { type: "float32", data: new Float32Array(n * WIDTHS_PER_OUTPUT[oi]!), dispose: () => {} };
    }
    for (const cell of cells) {
      if (cell.stride !== stride) continue;
      const idx = cell.row * cols + cell.col;
      out[`cls_${stride}`]!.data[idx] = cell.cls;
      out[`obj_${stride}`]!.data[idx] = cell.obj;
      out[`bbox_${stride}`]!.data.set(cell.bbox, idx * 4);
      const kpsFlat = cell.kps.flatMap(([x, y]) => [x, y]);
      out[`kps_${stride}`]!.data.set(kpsFlat, idx * 10);
    }
  }
  return out;
}

const NO_LANDMARKS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];

function fakeDetector(padW: number, padH: number, cells: readonly Cell[], options = { scoreThreshold: 0.7, nmsThreshold: 0.3, topK: 5000 }) {
  return {
    session: {
      run: async () => fakeOutputs(padW, padH, cells),
    } as unknown as import("onnxruntime-web").InferenceSession,
    options,
  };
}

function bgrImage(width: number, height: number): BgrImage {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

test("returns no faces when every cell scores below threshold", async () => {
  const detector = fakeDetector(32, 32, []);
  const faces = await detect(detector, bgrImage(32, 32));
  expect(faces).toEqual([]);
});

test("returns one face for one cell above threshold, decoded to a box and 5 landmarks", async () => {
  // stride 32, single cell (0,0): score = sqrt(0.95*0.95) = 0.95.
  const detector = fakeDetector(32, 32, [{ stride: 32, col: 0, row: 0, cls: 0.95, obj: 0.95, bbox: [0.5, 0.5, 0, 0], kps: NO_LANDMARKS }]);
  const faces = await detect(detector, bgrImage(32, 32));
  expect(faces).toHaveLength(1);
  const face = faces[0]!;
  expect(face).toHaveLength(FACE_ROW);
  // cx = (0 + 0.5) * 32 = 16, cy = 16, w = exp(0) * 32 = 32, h = 32; x1 = cx - w/2 = 0.
  expect(face[0]).toBeCloseTo(0, 4);
  expect(face[1]).toBeCloseTo(0, 4);
  expect(face[2]).toBeCloseTo(32, 4);
  expect(face[3]).toBeCloseTo(32, 4);
  expect(face[14]).toBeCloseTo(0.95, 4);
});

test("clamps cls/obj to [0, 1] before taking their score", async () => {
  // Both above 1: clamped to 1 each, score = sqrt(1*1) = 1.
  const detector = fakeDetector(32, 32, [{ stride: 32, col: 0, row: 0, cls: 5, obj: 5, bbox: [0.5, 0.5, 0, 0], kps: NO_LANDMARKS }]);
  const faces = await detect(detector, bgrImage(32, 32));
  expect(faces).toHaveLength(1);
  expect(faces[0]![14]).toBeCloseTo(1, 4);
});

test("keeps two faces that do not overlap", async () => {
  const detector = fakeDetector(64, 32, [
    { stride: 32, col: 0, row: 0, cls: 0.9, obj: 0.9, bbox: [0.5, 0.5, 0, 0], kps: NO_LANDMARKS },
    { stride: 32, col: 1, row: 0, cls: 0.8, obj: 0.8, bbox: [0.5, 0.5, 0, 0], kps: NO_LANDMARKS },
  ]);
  const faces = await detect(detector, bgrImage(64, 32));
  expect(faces).toHaveLength(2);
});

test("NMS drops the lower-scoring of two heavily overlapping boxes, keeping the higher score", async () => {
  // Two cells one stride-32 pixel apart, same size box (32x32): they overlap almost entirely.
  const detector = fakeDetector(64, 32, [
    { stride: 32, col: 0, row: 0, cls: 0.99, obj: 0.99, bbox: [0.5, 0.5, 0, 0], kps: NO_LANDMARKS },
    { stride: 32, col: 1, row: 0, cls: 0.75, obj: 0.75, bbox: [-0.4, 0.5, 0, 0], kps: NO_LANDMARKS },
  ]);
  const faces = await detect(detector, bgrImage(64, 32));
  expect(faces).toHaveLength(1);
  expect(faces[0]![14]).toBeCloseTo(0.99, 4);
});

test("decodes 5 landmarks relative to the cell and stride", async () => {
  const detector = fakeDetector(32, 32, [
    {
      stride: 32,
      col: 0,
      row: 0,
      cls: 0.9,
      obj: 0.9,
      bbox: [0.5, 0.5, 0, 0],
      kps: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4], [0.5, 0.5]],
    },
  ]);
  const faces = await detect(detector, bgrImage(32, 32));
  const face = faces[0]!;
  // landmark k = (kx + c) * stride = (0.1 + 0) * 32 = 3.2 for the first point's x.
  expect(face[4]).toBeCloseTo(3.2, 3);
  expect(face[5]).toBeCloseTo(3.2, 3);
});
