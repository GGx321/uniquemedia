import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { hammingDistance } from "../../src/core/pdq/hamming";
import { computePdqHash } from "../../src/core/pdq/pdq";
import { createRealDecodeBackend } from "../engine/decode/realBackend";
import { createWasmImageDecoder } from "../engine/decode/wasmDecode";
import { createFaceGate } from "../engine/face/gate";
import { ffmpegPath } from "../node/ffmpegBinary";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { servedPoolImagePng } from "./distinctPattern";
import { faceModelPaths } from "./faceModelCache";
import { describeFfmpegRun, FACE_FIXTURE_PATH, facePoolImagePngBounded, runFfmpegBounded } from "./facePool";
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
 * One decode is tens of milliseconds; the bound only has to fit a heavily loaded Windows runner. On that runner
 * ffmpeg calls made through `spawnSync(..., { timeout })` failed twice with no message: a decode about 22 ms after
 * it started, and a face pool composite that ended ETIMEDOUT with SIGTERM about 16 ms into a 30 s bound. A timeout
 * that fires after milliseconds is not a slow run, so the cause is unknown, and the native `spawnSync` timeout is
 * the suspect. These helpers run ffmpeg through `runFfmpegBounded` (our own timer, never the native one), and a
 * failure reports the exit code, signal, spawn error and elapsed time.
 */
const DECODE_TIMEOUT_MS = 120_000;

/**
 * Decodes a served pool image exactly the way T7a's PDQ gate will: ffmpeg's
 * `scale=64:64:flags=area,format=gray`, raw 8-bit grayscale out — the same
 * `ffmpegPath()` every other studio test and the engine itself uses
 * (studio/node/ffmpegBinary.ts), never a stand-in. A missing or broken
 * ffmpeg fails this test loudly (the non-zero run, thrown below), never a
 * silent skip: the whole point of this test is proving the real pipeline,
 * and a skip would prove nothing at all.
 */
async function decodeServedGray64(png: Uint8Array): Promise<Uint8Array> {
  const run = await runFfmpegBounded(
    ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-vf", "scale=64:64:flags=area,format=gray", "-f", "rawvideo", "-frames:v", "1", "pipe:1"],
    png,
    DECODE_TIMEOUT_MS,
  );
  if (run.code !== 0) {
    throw new Error(`ffmpeg (${ffmpegPath()}) could not decode a pool image the way the PDQ gate will: ${describeFfmpegRun(run)}`);
  }
  const gray = new Uint8Array(run.stdout);
  if (gray.length !== HASH_SIZE * HASH_SIZE) {
    throw new Error(`expected a ${HASH_SIZE}x${HASH_SIZE} raw grayscale frame (${HASH_SIZE * HASH_SIZE} bytes), got ${gray.length}`);
  }
  return gray;
}

/** The PDQ hashes of these served images, decoded one at a time (in sequence: the run must not add load of its own to a slow runner). */
async function hashesOf(pngs: readonly Uint8Array[]): Promise<Uint8Array[]> {
  const hashes: Uint8Array[] = [];
  for (const png of pngs) hashes.push(computePdqHash(await decodeServedGray64(png)));
  return hashes;
}

describe("runFfmpegBounded", () => {
  test("kills a run that outlasts its own bound and reports it as timed out, with the elapsed time", async () => {
    const run = await runFfmpegBounded(["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30", "-f", "null", "-"], new Uint8Array(), 400);
    expect(run.timedOut).toBe(true);
    expect(run.code).not.toBe(0);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(350);
    expect(run.elapsedMs).toBeLessThan(10_000);
    expect(describeFfmpegRun(run)).toContain("timed out after");
  });

  test("reports a failed run's exit code and stderr, and a good run's output", async () => {
    const bad = await runFfmpegBounded(["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "null", "-"], Uint8Array.of(1, 2, 3, 4), 30_000);
    expect(bad.timedOut).toBe(false);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr.length).toBeGreaterThan(0);
    const good = await runFfmpegBounded(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=8x8", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], new Uint8Array(), 30_000);
    expect(good.code).toBe(0);
    expect(good.stdout.length).toBe(64);
  });
});

describe("the served pool is PDQ-distinct through the real gate pipeline", () => {
  // In a hook, not the describe body: a decode that fails there is a named failure, not a load error that hides which test it belongs to.
  let hashes: Uint8Array[] = [];
  beforeAll(async () => {
    hashes = await hashesOf(Array.from({ length: POOL_SIZE }, (_, index) => servedPoolImagePng(index)));
  }, 300_000);

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
  // In a hook, not the describe body: an ffmpeg call there runs at collection time, and its failure is an "Unhandled
  // error between tests" that names no test and prints no `(fail)` line.
  let composites: Uint8Array[] = [];
  beforeAll(async () => {
    composites = [];
    for (let i = 0; i < COMPOSITE_COUNT; i++) composites.push(await facePoolImagePngBounded(i));
  }, 300_000);

  test(`every pair of ${COMPOSITE_COUNT} composited images is > ${MIN_HAMMING_DISTANCE} bits apart, decoded through the real gate pipeline`, async () => {
    const hashes = await hashesOf(composites);
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
