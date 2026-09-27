import { expect, test } from "bun:test";
import { defaultFaceGateConfig } from "./config";
import type { Detector } from "./yunet";
import { runFaceGate } from "./gate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const config = defaultFaceGateConfig();
const MASTER = new Float32Array([1, 0]);

// `detect` is injected into runFaceGate as its own `detectFn` parameter in
// every test below, so this fake detector's session is never actually
// called — it only needs to satisfy the `Detector` shape.
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

test("no face detected on front: no-face, similarityFn never called", async () => {
  let called = false;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "front", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 1;
    },
    async () => [],
  );
  expect(verdict).toEqual({ kind: "no-face", faces: 0 });
  expect(called).toBe(false);
});

test("profile: skipped-by-pose, similarityFn never called even with a strong face", async () => {
  let called = false;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "profile", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 1;
    },
    async () => [faceRow(0, 0, 50, 50, 0.95)],
  );
  expect(verdict.kind).toBe("skipped-by-pose");
  expect(called).toBe(false);
});

test("back with a confident face: unexpected-face, similarityFn never called", async () => {
  let called = false;
  const verdict = await runFaceGate(
    bgr(),
    { pose: "back", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 1;
    },
    async () => [faceRow(0, 0, 50, 50, config.unexpectedFace.minScore)],
  );
  expect(verdict.kind).toBe("unexpected-face");
  expect(called).toBe(false);
});

test("front with one face: similarityFn is called once with the face and master embedding, and its result decides match/mismatch", async () => {
  const face = faceRow(10, 10, 50, 50, 0.9);
  let seenFace: Float32Array | undefined;
  let seenMaster: Float32Array | undefined;
  const verdict = await runFaceGate(
    bgr(200, 200),
    { pose: "front", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async (ctx) => {
      seenFace = ctx.face;
      seenMaster = ctx.masterEmbedding;
      return 0.9; // above the default threshold
    },
    async () => [face],
  );
  expect(verdict.kind).toBe("match");
  expect(seenFace).toBe(face);
  expect(seenMaster).toBe(MASTER);
});

test("front with one face and a low similarity: mismatch", async () => {
  const face = faceRow(10, 10, 50, 50, 0.9);
  const verdict = await runFaceGate(
    bgr(200, 200),
    { pose: "front", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => 0.1,
    async () => [face],
  );
  expect(verdict.kind).toBe("mismatch");
});

test("multiple prominent faces: multiple-faces, similarityFn never called", async () => {
  let called = false;
  const faces = [faceRow(0, 0, 100, 300, 0.9), faceRow(500, 0, 100, 300, 0.9)];
  const verdict = await runFaceGate(
    bgr(700, 300),
    { pose: "front", masterEmbedding: MASTER },
    fakeDetector(),
    config,
    async () => {
      called = true;
      return 0.9;
    },
    async () => faces,
  );
  expect(verdict.kind).toBe("multiple-faces");
  expect(called).toBe(false);
});

test("gallery strategy: similarityFn receives the gallery embeddings alongside the master", async () => {
  const face = faceRow(10, 10, 50, 50, 0.9);
  const gallery = [new Float32Array([0, 1]), new Float32Array([1, 1])];
  let seenGallery: readonly Float32Array[] | undefined;
  const galleryConfig = { ...config, identity: { strategy: { kind: "gallery" as const, threshold: 0.5, aggregate: "max" as const } } };
  await runFaceGate(
    bgr(200, 200),
    { pose: "front", masterEmbedding: MASTER, galleryEmbeddings: gallery },
    fakeDetector(),
    galleryConfig,
    async (ctx) => {
      seenGallery = ctx.galleryEmbeddings;
      return 0.9;
    },
    async () => [face],
  );
  expect(seenGallery).toEqual(gallery);
});
