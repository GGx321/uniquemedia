import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { faceModelPaths } from "../../scripts/faceModelCache";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { createRealDecodeBackend } from "../decode/realBackend";
import { createWasmImageDecoder } from "../decode/wasmDecode";
import { ortWasmPathsFrom } from "../decode/wasmPaths";
import { createFaceGate, type FaceGateImage } from "./gate";
import { ELECTRON_DECODE_HASHES } from "./fixtures/electronDecodeHashes";
import { IMPOSTOR, MASTER, TRUE_RENDERS } from "./fixtures/expected";
import { realWorkerSpawner } from "./testing/realWorker";
import { createWorkerFaceGate } from "./worker/workerGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Plan T7b, "Done when": parity with the OpenCV numbers on the spike image
// set (<= 0.001 cosine). Needs the real models (fetched into a gitignored
// cache, never committed — studio/scripts/faceModelCache.ts).
//
// Security review, T7b section A: this test decodes with the engine's own
// WASM decoder (studio/engine/decode/), never Electron — the whole point of
// the decode decision is that the engine stays Electron-free, so a test that
// still needed a real Electron app to prove parity would not actually prove
// what production does. Byte-exact parity with Electron's `nativeImage` is
// instead proven once, against committed reference hashes
// (fixtures/electronDecodeHashes.ts, produced by
// studio/scripts/generateWasmDecodeParityHashes.ts — the same
// `decodeWithElectron`/`electronDecode.mjs` harness this file used before,
// now a one-time hash generator rather than something the test suite runs).
// The face-gate cosine numbers below must therefore match `expected.ts`'s
// pinned OpenCV numbers with ZERO drift (the ≤0.001 bar stays as the
// assertion, but a real regression here means the decoders genuinely
// disagree, not a rounding difference) — never skipped silently in CI (the
// guard test below fails loudly instead).
const FACE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(FACE_DIR, "..", "..", "..");
const MODEL_PATHS = faceModelPaths(ROOT);
const MODELS_PRESENT = existsSync(MODEL_PATHS.yunet) && existsSync(MODEL_PATHS.sface);
// No Electron needed any more (the WASM decoder runs under plain bun/Node),
// so — unlike before this task — the CI guard is no longer platform-limited:
// it is enforced wherever the models are expected (.github/workflows/
// studio.yml's `build` job matrix, macOS and Windows) and would also catch a
// missing cache on Linux if that job ever fetched the models too.
const IS_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const IMAGE_DIR = join(FACE_DIR, "fixtures", "images");
const COSINE_TOLERANCE = 0.001;

/** The engine's real decode path (studio/engine/decode/), never Electron. */
async function decodeFixtures(files: readonly string[]): Promise<FaceGateImage[]> {
  const backend = await createRealDecodeBackend(join(ROOT, "node_modules"));
  const decode = createWasmImageDecoder(backend);
  const controller = new AbortController();
  const out: FaceGateImage[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(IMAGE_DIR, file));
    out.push(await decode(new Uint8Array(bytes), controller.signal));
  }
  return out;
}

test("CI guard: the face models must be present in CI, never silently skipped", () => {
  if (IS_CI && !MODELS_PRESENT) {
    throw new Error(
      `face/parity: models missing in CI at ${MODEL_PATHS.yunet} / ${MODEL_PATHS.sface} — ` +
        "the workflow's fetch-and-cache step (.github/workflows/studio.yml) did not run or failed silently",
    );
  }
  expect(true).toBe(true);
});

describe.skipIf(!MODELS_PRESENT)("parity with the spike's OpenCV numbers (real models + the engine's own WASM decode)", () => {
  test("the WASM decode is byte-identical to Electron's nativeImage (committed reference hashes)", async () => {
    const fixtures = [MASTER, IMPOSTOR, ...TRUE_RENDERS];
    const decoded = await decodeFixtures(fixtures.map((f) => f.file));
    for (let i = 0; i < fixtures.length; i++) {
      const file = fixtures[i]!.file;
      const image = decoded[i]!;
      const reference = ELECTRON_DECODE_HASHES[file];
      if (reference === undefined) throw new Error(`no committed reference hash for ${file} — run generateWasmDecodeParityHashes.ts`);
      expect({ width: image.width, height: image.height }).toEqual({ width: reference.width, height: reference.height });
      const sha256 = createHash("sha256").update(image.data).digest("hex");
      expect(sha256).toBe(reference.sha256);
    }
  }, 30_000);

  test("matches within 0.001 cosine (measured: 0 drift), exact face count and headRatio, on the spike's true renders, impostor and master", async () => {
    const models = {
      yunet: readFileSync(MODEL_PATHS.yunet),
      sface: readFileSync(MODEL_PATHS.sface),
    };
    const fixtures = [MASTER, IMPOSTOR, ...TRUE_RENDERS];
    const decoded = await decodeFixtures(fixtures.map((f) => f.file));

    const gate = await createFaceGate(models);
    try {
      const [masterImage] = decoded;
      if (!masterImage) throw new Error("no master image decoded");
      const masterEmbedding = await gate.embed(masterImage);

      for (let i = 0; i < fixtures.length; i++) {
        const expected = fixtures[i]!;
        const image = decoded[i]!;
        const verdict = await gate.check({ pose: "front", image, masterEmbedding });
        expect(verdict.faces).toBe(expected.faces);
        if (verdict.kind !== "match" && verdict.kind !== "mismatch") throw new Error(`${expected.file}: unexpected verdict ${verdict.kind}`);
        expect(Math.abs(verdict.similarity - expected.cosMaster)).toBeLessThanOrEqual(COSINE_TOLERANCE);
        expect(Math.abs(verdict.headRatio - expected.headRatio)).toBeLessThanOrEqual(0.001);
      }
    } finally {
      await gate.dispose();
    }
  }, 60_000);

  // T7c: the SAME numbers through the production path — bytes in, the face
  // worker thread decoding and inferring, a small verdict out. The worker
  // runs the identical decode + gate code, so this is not a second
  // calibration: it pins that nothing about the worker boundary (transfer,
  // structured clone of the embedding, zod at both ends) moved a single
  // digit, at the same zero-drift bar as the in-thread test above.
  test("T7c: through the worker thread the results are identical — same cosines, face counts and headRatios", async () => {
    const fixtures = [MASTER, IMPOSTOR, ...TRUE_RENDERS];
    const gate = createWorkerFaceGate({ spawnWorker: realWorkerSpawner() });
    const live = new AbortController().signal;
    try {
      const inThreadModels = { yunet: readFileSync(MODEL_PATHS.yunet), sface: readFileSync(MODEL_PATHS.sface) };
      const decoded = await decodeFixtures(fixtures.map((f) => f.file));
      const inThread = await createFaceGate(inThreadModels);
      try {
        const [masterImage] = decoded;
        if (!masterImage) throw new Error("no master image decoded");
        const inThreadMaster = await inThread.embed(masterImage);
        const masterBytes = new Uint8Array(readFileSync(join(IMAGE_DIR, MASTER.file)));
        const viaWorkerMaster = await gate.embed(masterBytes, live);
        expect(Array.from(viaWorkerMaster)).toEqual(Array.from(inThreadMaster)); // bit-identical, not merely close

        for (let i = 0; i < fixtures.length; i++) {
          const expected = fixtures[i]!;
          const bytes = new Uint8Array(readFileSync(join(IMAGE_DIR, expected.file)));
          const viaWorker = await gate.check({ pose: "front", bytes, masterEmbedding: viaWorkerMaster }, live);
          const direct = await inThread.check({ pose: "front", image: decoded[i]!, masterEmbedding: inThreadMaster });
          expect(viaWorker).toEqual(direct);
          expect(viaWorker.faces).toBe(expected.faces);
          if (viaWorker.kind !== "match" && viaWorker.kind !== "mismatch") throw new Error(`${expected.file}: unexpected verdict ${viaWorker.kind}`);
          expect(Math.abs(viaWorker.similarity - expected.cosMaster)).toBeLessThanOrEqual(COSINE_TOLERANCE);
          expect(Math.abs(viaWorker.headRatio - expected.headRatio)).toBeLessThanOrEqual(0.001);
        }
      } finally {
        await inThread.dispose();
      }
    } finally {
      await gate.dispose();
    }
  }, 60_000);

  // Round 3, small item a: every existing candidate fixture (TRUE_RENDERS)
  // is already at or below FACE_PIPELINE_MAX_SIDE, so normalizeForFacePipeline()
  // is a no-op on all of them — a mutation that deleted the normalize() call
  // from check() specifically (leaving embed()'s untouched) would not be
  // caught by any test above. A genuine close-up candidate WELL above the
  // cap (master.jpg upscaled 2x, 1728x2304 — its face already occupies a
  // large fraction of the frame at headRatio 0.482, so 2x pushes it past
  // the ~630px "undetected at full scale" measurement from the round 2
  // re-review) fails detection entirely without normalization and matches
  // cleanly with it — verified against a temporarily-reverted check() while
  // writing this test.
  test("M1 (a): check() normalizes the CANDIDATE, not just embed()'s master — a 2x close-up candidate still matches", async () => {
    const masterPath = join(IMAGE_DIR, MASTER.file);
    const upscaled = spawnSync(
      ffmpegPath(),
      ["-y", "-hide_banner", "-loglevel", "error", "-i", masterPath, "-vf", "scale=1728:2304", "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg", "pipe:1"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    if (upscaled.status !== 0) throw new Error(`ffmpeg could not upscale the master fixture: ${upscaled.stderr.toString()}`);

    const models = { yunet: readFileSync(MODEL_PATHS.yunet), sface: readFileSync(MODEL_PATHS.sface) };
    const gate = await createFaceGate(models);
    try {
      const [masterImage, bigCandidate] = await Promise.all([
        decodeFixtures([MASTER.file]).then((r) => r[0]!),
        (async () => {
          const backend = await createRealDecodeBackend(join(ROOT, "node_modules"));
          const decode = createWasmImageDecoder(backend);
          return decode(new Uint8Array(upscaled.stdout), new AbortController().signal);
        })(),
      ]);
      expect(bigCandidate.width).toBeGreaterThan(1280);
      const masterEmbedding = await gate.embed(masterImage);
      const verdict = await gate.check({ pose: "front", image: bigCandidate, masterEmbedding });
      expect(verdict.kind).toBe("match");
    } finally {
      await gate.dispose();
    }
  }, 30_000);

  test("createFaceGate honours an explicit wasmPaths (packaging: the asar-unpacked location) and still initializes", async () => {
    // Points at the real files node_modules already has, standing in for the
    // asar-unpacked path T6's wiring will compute — proves the override is
    // applied and onnxruntime-web still loads from it, without needing a
    // packaged build here. A path to nowhere would make session creation
    // itself fail, so this is a real behavioural check, not just a getter.
    // file:// URLs (H4): pins the same form main.ts's real wiring must use.
    const wasmPaths = ortWasmPathsFrom(join(ROOT, "node_modules", "onnxruntime-web", "dist"));
    const models = { yunet: readFileSync(MODEL_PATHS.yunet), sface: readFileSync(MODEL_PATHS.sface) };
    const ort = await import("onnxruntime-web");
    // ort.env.wasm.wasmPaths is module-level, global, mutable state (bun runs
    // every test file in one process): createFaceGate only ever SETS it, on a
    // defined wasmPaths (gate.ts's own `if (wasmPaths !== undefined)`), never
    // restores it — so leaving this test's own override in place would leak
    // into every later test in the SAME process that creates a face gate
    // with the default (undefined) wasmPaths, e.g. distinctPattern.test.ts's
    // own composite face-match test. Captured and restored here so this
    // test's own override never outlives it.
    const previousWasmPaths = ort.env.wasm.wasmPaths;
    const gate = await createFaceGate(models, undefined, wasmPaths);
    try {
      expect(ort.env.wasm.wasmPaths).toEqual(wasmPaths);
      const [decoded] = await decodeFixtures([MASTER.file]);
      if (!decoded) throw new Error("no image decoded");
      const embedding = await gate.embed(decoded);
      expect(embedding.length).toBeGreaterThan(0);
    } finally {
      await gate.dispose();
      ort.env.wasm.wasmPaths = previousWasmPaths;
    }
  }, 30_000);
});

if (!MODELS_PRESENT && !IS_CI) {
  console.warn(
    "face/parity: models not found in the local cache — run `bun studio/scripts/faceModelCache.ts` to fetch them; the parity test is skipped, not failed.",
  );
}
