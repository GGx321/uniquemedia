import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { faceModelPaths } from "../../scripts/faceModelCache";
import { createFaceGate } from "./gate";
import { IMPOSTOR, MASTER, TRUE_RENDERS } from "./fixtures/expected";
import { decodeImagesWithElectron } from "./testing/decodeWithElectron";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Plan T7b, "Done when": parity with the OpenCV numbers on the spike image
// set (<= 0.001 cosine). Needs the real models (fetched into a gitignored
// cache, never committed — studio/scripts/faceModelCache.ts) and real
// Chromium decoding (spike/face-js/README.md: only Chromium/nativeImage
// decoding reaches <= 0.001; ffmpeg drifts up to 0.03) — never skipped
// silently in CI (the guard test below fails loudly instead).
const FACE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(FACE_DIR, "..", "..", "..");
const MODEL_PATHS = faceModelPaths(ROOT);
const MODELS_PRESENT = existsSync(MODEL_PATHS.yunet) && existsSync(MODEL_PATHS.sface);
// Decoding needs a real Electron app (nativeImage), which needs a desktop
// session; GitHub's macOS and Windows runners have one (as the packaged-app
// smoke test in .github/workflows/studio.yml already relies on), but
// ubuntu-latest (the `canary` job) does not, and is not the job this parity
// check is meant to guard — it is a Bun-version-drift smoke, not a T7b
// concern. So the CI guard below is enforced only where the models are
// actually expected to be fetched (.github/workflows/studio.yml's `build`
// job matrix): macOS and Windows.
const IS_CI = (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.platform !== "linux";
const IMAGE_DIR = join(FACE_DIR, "fixtures", "images");
const COSINE_TOLERANCE = 0.001;

test("CI guard: the face models must be present in CI, never silently skipped", () => {
  if (IS_CI && !MODELS_PRESENT) {
    throw new Error(
      `face/parity: models missing in CI at ${MODEL_PATHS.yunet} / ${MODEL_PATHS.sface} — ` +
        "the workflow's fetch-and-cache step (.github/workflows/studio.yml) did not run or failed silently",
    );
  }
  expect(true).toBe(true);
});

describe.skipIf(!MODELS_PRESENT)("parity with the spike's OpenCV numbers (real models + real Chromium decoding)", () => {
  test("matches within 0.001 cosine, exact face count and headRatio, on the spike's true renders, impostor and master", async () => {
    const models = {
      yunet: readFileSync(MODEL_PATHS.yunet),
      sface: readFileSync(MODEL_PATHS.sface),
    };
    const fixtures = [MASTER, IMPOSTOR, ...TRUE_RENDERS];
    const decoded = await decodeImagesWithElectron(fixtures.map((f) => join(IMAGE_DIR, f.file)));

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

  test("createFaceGate honours an explicit wasmPaths (packaging: the asar-unpacked location) and still initializes", async () => {
    // Points at the real files node_modules already has, standing in for the
    // asar-unpacked path T6's wiring will compute — proves the override is
    // applied and onnxruntime-web still loads from it, without needing a
    // packaged build here. A path to nowhere would make session creation
    // itself fail, so this is a real behavioural check, not just a getter.
    const ortDist = join(ROOT, "node_modules", "onnxruntime-web", "dist");
    const wasmPaths = { wasm: join(ortDist, "ort-wasm-simd-threaded.wasm"), mjs: join(ortDist, "ort-wasm-simd-threaded.mjs") };
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
      const [decoded] = await decodeImagesWithElectron([join(IMAGE_DIR, MASTER.file)]);
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
