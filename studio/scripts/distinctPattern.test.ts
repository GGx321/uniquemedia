import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hammingDistance } from "../../src/core/pdq/hamming";
import { computePdqHash } from "../../src/core/pdq/pdq";
import { createRealDecodeBackend } from "../engine/decode/realBackend";
import { createWasmImageDecoder } from "../engine/decode/wasmDecode";
import { createFaceGate } from "../engine/face/gate";
import { ffmpegPath } from "../node/ffmpegBinary";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { servedPoolImagePng } from "./distinctPattern";
import { faceModelPaths } from "./faceModelCache";
import { FACE_FIXTURE_PATH, facePoolImagePng } from "./facePool";
useNativeGlobals();

// T7a (merging soon): an always-on PDQ near-duplicate gate on photo runs,
// threshold 20 of 256 bits (src/core/pdq) — any pair of images that close is
// read as a duplicate and retried, and its own decode command (after its
// current fix round) is `scale=64:64:flags=area,format=gray`, raw 8-bit gray
// out.
//
// Round 1 review (HIGH): a first version of this test hashed the pattern
// rendered directly at 64x64, but the mock served it at 200x356 with
// pixel-absolute stripe math — a geometrically different image, so the test
// proved nothing about the shipped artifact (measured: per-index distance
// between "what the test hashed" and "what the real pipeline hashed" was
// 20-160 bits). This version hashes exactly what the gate will: the real
// served PNG bytes (`servedPoolImagePng`, the same function
// studio/scripts/mockOpenRouter.ts serves from), decoded with the real
// `ffmpegPath()` and the gate's own command, never a stand-in decoder or a
// direct render at the hash size.

const POOL_SIZE = 48;
const MIN_HAMMING_DISTANCE = 40;
const HASH_SIZE = 64;

/**
 * Decodes a served pool image exactly the way T7a's PDQ gate will: ffmpeg's
 * `scale=64:64:flags=area,format=gray`, raw 8-bit grayscale out — the same
 * `ffmpegPath()` every other studio test and the engine itself uses
 * (studio/node/ffmpegBinary.ts), never a stand-in. A missing or broken
 * ffmpeg fails this test loudly (spawnSync's own non-zero status, thrown
 * below), never a silent skip: the whole point of this test is proving the
 * real pipeline, and a skip would prove nothing at all.
 */
function decodeServedGray64(png: Uint8Array): Uint8Array {
  const result = spawnSync(
    ffmpegPath(),
    ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-vf", "scale=64:64:flags=area,format=gray", "-f", "rawvideo", "-frames:v", "1", "pipe:1"],
    { input: Buffer.from(png), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg (${ffmpegPath()}) could not decode a pool image the way the PDQ gate will: ${result.stderr.toString()}`);
  }
  const gray = new Uint8Array(result.stdout);
  if (gray.length !== HASH_SIZE * HASH_SIZE) {
    throw new Error(`expected a ${HASH_SIZE}x${HASH_SIZE} raw grayscale frame (${HASH_SIZE * HASH_SIZE} bytes), got ${gray.length}`);
  }
  return gray;
}

describe("the served pool is PDQ-distinct through the real gate pipeline", () => {
  const hashes = Array.from({ length: POOL_SIZE }, (_, index) => computePdqHash(decodeServedGray64(servedPoolImagePng(index))));

  test("every hash is PDQ's own 32 bytes (256 bits)", () => {
    for (const hash of hashes) expect(hash.length).toBe(32);
  });

  test(`every pair of the pool's ${POOL_SIZE} served images is > ${MIN_HAMMING_DISTANCE} bits apart, decoded through the real gate pipeline (PDQ's own gate: 20)`, () => {
    const tooClose: { i: number; j: number; distance: number }[] = [];
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const a = hashes[i];
        const b = hashes[j];
        if (a === undefined || b === undefined) throw new Error("unreachable: i and j are within hashes' own length");
        const distance = hammingDistance(a, b);
        if (distance <= MIN_HAMMING_DISTANCE) tooClose.push({ i, j, distance });
      }
    }
    expect(tooClose).toEqual([]);
  });
});

// T7b: the packaged E2E smoke needs the face gate to actually run and pass in
// a real photo run, without a real network call (task item 4). Plain pool
// images carry no face at all, so with the gate on every front/three-quarter
// slot would retry then fail. studio/scripts/facePool.ts composites a real
// fixture face onto each of the pool's own PDQ-distinct backgrounds
// (mockOpenRouter.ts's own "faceFixture" option serves these); this extends
// the proof above to the composited images: still PDQ-distinct through the
// real gate pipeline, AND face-detectable/matching through the real face
// gate (guarded the same way face/parity.test.ts is — real models, real
// Chromium decoding, never silently skipped in CI).
describe("the composited (face + PDQ-distinct background) pool the E2E smoke's face-gate scenario serves", () => {
  // A representative slice, not the full 48: each one needs a real Electron
  // decode plus ONNX inference, unlike the plain pool's own ffmpeg-only proof.
  const COMPOSITE_COUNT = 8;
  const composites = Array.from({ length: COMPOSITE_COUNT }, (_, i) => facePoolImagePng(i));

  test(`every pair of ${COMPOSITE_COUNT} composited images is > ${MIN_HAMMING_DISTANCE} bits apart, decoded through the real gate pipeline`, () => {
    const hashes = composites.map((png) => computePdqHash(decodeServedGray64(png)));
    const tooClose: { i: number; j: number; distance: number }[] = [];
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const a = hashes[i];
        const b = hashes[j];
        if (a === undefined || b === undefined) throw new Error("unreachable: i and j are within hashes' own length");
        const distance = hammingDistance(a, b);
        if (distance <= MIN_HAMMING_DISTANCE) tooClose.push({ i, j, distance });
      }
    }
    expect(tooClose).toEqual([]);
  });

  const FACE_ROOT = join(import.meta.dirname, "..", "..");
  const FACE_MODEL_PATHS = faceModelPaths(FACE_ROOT);
  const FACE_MODELS_PRESENT = existsSync(FACE_MODEL_PATHS.yunet) && existsSync(FACE_MODEL_PATHS.sface);
  // No Electron needed any more (T7b security review: the engine decodes
  // with its own WASM JPEG/PNG decoder — studio/engine/decode/ — never
  // Electron's nativeImage), so this guard is no longer platform-limited.
  const FACE_IS_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

  test("CI guard: the face models must be present in CI, never silently skipped", () => {
    if (FACE_IS_CI && !FACE_MODELS_PRESENT) {
      throw new Error(`facePool: models missing in CI at ${FACE_MODEL_PATHS.yunet} / ${FACE_MODEL_PATHS.sface} — the workflow's fetch-and-cache step did not run or failed silently`);
    }
    expect(true).toBe(true);
  });

  describe.skipIf(!FACE_MODELS_PRESENT)("the real face gate, real models, the engine's own WASM decode", () => {
    test("every composited image passes as a match against the master, similarity above the gate's 0.55 threshold", async () => {
      const nodeModulesDir = join(import.meta.dirname, "..", "..", "node_modules");
      const backend = await createRealDecodeBackend(nodeModulesDir);
      const decodeImage = createWasmImageDecoder(backend);
      const signal = new AbortController().signal;

      const masterBytes = new Uint8Array(readFileSync(FACE_FIXTURE_PATH));
      const masterImage = await decodeImage(masterBytes, signal);
      const compositeImages = await Promise.all(composites.map((png) => decodeImage(png, signal)));

      const models = { yunet: readFileSync(FACE_MODEL_PATHS.yunet), sface: readFileSync(FACE_MODEL_PATHS.sface) };
      const gate = await createFaceGate(models);
      try {
        const masterEmbedding = await gate.embed(masterImage);
        for (let i = 0; i < compositeImages.length; i++) {
          const image = compositeImages[i];
          if (image === undefined) throw new Error(`unreachable: composite ${i} was decoded`);
          const verdict = await gate.check({ pose: "front", image, masterEmbedding });
          if (verdict.kind !== "match") throw new Error(`composite ${i}: expected a match, got ${verdict.kind}`);
          expect(verdict.faces).toBe(1);
          expect(verdict.similarity).toBeGreaterThanOrEqual(0.55);
        }
      } finally {
        await gate.dispose();
      }
    }, 60_000);
  });

  if (!FACE_MODELS_PRESENT && !FACE_IS_CI) {
    console.warn("distinctPattern.test.ts: face models not found in the local cache — run `bun studio/scripts/faceModelCache.ts` to fetch them; the composite face-match test is skipped, not failed.");
  }
});
