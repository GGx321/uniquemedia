import { expect, test } from "bun:test";
import { defaultFaceGateConfig } from "./config";
import { runFaceGate } from "./gate";
import type { Detector } from "./yunet";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.6f (r1.3 M2): under `body` with one prominent face the similarity must be computed, or the policy would throw and stop the whole run.

const config = defaultFaceGateConfig();
const MASTER = new Float32Array([1, 0]);

function fakeDetector(): Detector {
  return { session: { run: async () => ({}) } as never, options: config.detector };
}

function bgr(width = 100, height = 100) {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

function faceRow(x: number, y: number, w: number, h: number, score: number): Float32Array {
  const row = new Float32Array(15);
  row[0] = x;
  row[1] = y;
  row[2] = w;
  row[3] = h;
  row[14] = score;
  return row;
}

test("body, one prominent face: similarityFn is called once and the verdict is marked with its score", async () => {
  let called = 0;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "body", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called++;
      return 0.4;
    },
    async () => [faceRow(0, 0, 50, 50, 0.95)],
  );
  expect(called).toBe(1);
  expect(verdict).toEqual({ kind: "marked", similarity: 0.4, faces: 1, headRatio: 0.5 });
});

test("body, no face: skipped-by-pose, similarityFn never called", async () => {
  let called = false;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "body", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 1;
    },
    async () => [],
  );
  expect(verdict).toEqual({ kind: "skipped-by-pose", faces: 0 });
  expect(called).toBe(false);
});

test("body, one prominent face but a NaN cosine: skipped-by-pose, nothing non-finite escapes the gate", async () => {
  const verdict = await runFaceGate(bgr(), { pose: "body", masterEmbedding: MASTER }, fakeDetector(), config, async () => Number.NaN, async () => [faceRow(0, 0, 50, 50, 0.95)]);
  expect(verdict).toEqual({ kind: "skipped-by-pose", faces: 1 });
});

test("body, two prominent faces: multiple-faces, similarityFn never called", async () => {
  let called = false;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "body", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 1;
    },
    async () => [faceRow(0, 0, 40, 40, 0.95), faceRow(50, 0, 40, 40, 0.95)],
  );
  expect(verdict).toEqual({ kind: "multiple-faces", faces: 2 });
  expect(called).toBe(false);
});
