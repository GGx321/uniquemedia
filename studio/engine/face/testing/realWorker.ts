import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { faceModelPaths } from "../../../scripts/faceModelCache";
import { ffmpegPath } from "../../../node/ffmpegBinary";
import { ortWasmPathsFrom } from "../../decode/wasmPaths";
import { defaultFaceGateConfig } from "../config";
import { MASTER } from "../fixtures/expected";
import type { FaceWorkerInit } from "../worker/protocol";
import { createWorkerFaceGate, type WorkerFaceGate } from "../worker/workerGate";
import { createFaceWorkerSpawner } from "../worker/spawn";

// Test support for anything that runs the REAL face worker (real models, real
// codecs): the worker's entry, the cached models, and a few real images of the
// sizes the reviewers measured. It serves two runners. Under `bun test` the
// paths come from this file's own place and the worker is the .ts source. As a
// bundle of a `*.node-test.ts` (studio/scripts/electronNodeTests.ts, Electron's
// Node) this file sits in a temp directory, so the runner's STUDIO_ROOT says
// where the repo is and the built worker (`faceWorker.js`) is next to the bundle.
// Which of the two it is comes from the module itself (a `.ts` source, or the
// bundle's `.mjs`), never from whether STUDIO_ROOT happens to be in the
// environment: a stray STUDIO_ROOT must not move a `bun test` run, and a bundle
// without one must fail at once instead of looking for the repo in a temp folder.

/** Where the repo and the worker entry are, for the module at `moduleUrl` and the runner's `studioRoot`. */
export function locateRealWorker(moduleUrl: string, studioRoot: string | undefined): { repoRoot: string; workerUrl: URL } {
  const bundled = !/\.[cm]?tsx?$/.test(new URL(moduleUrl).pathname);
  if (bundled) {
    if (studioRoot === undefined || studioRoot === "") {
      throw new Error("testing/realWorker was bundled but STUDIO_ROOT is not set: run the suite through studio/scripts/electronNodeTests.ts");
    }
    return { repoRoot: studioRoot, workerUrl: new URL("./faceWorker.js", moduleUrl) };
  }
  return { repoRoot: join(dirname(fileURLToPath(moduleUrl)), "..", "..", "..", ".."), workerUrl: new URL("../worker/faceWorker.ts", moduleUrl) };
}

const LOCATION = locateRealWorker(import.meta.url, process.env.STUDIO_ROOT);
export const REPO_ROOT = LOCATION.repoRoot;
export const FIXTURE_IMAGE_DIR = join(REPO_ROOT, "studio", "engine", "face", "fixtures", "images");
export const FACE_WORKER_SOURCE = LOCATION.workerUrl;

const MODEL_PATHS = faceModelPaths(REPO_ROOT);
export const MODELS_PRESENT = existsSync(MODEL_PATHS.yunet) && existsSync(MODEL_PATHS.sface);

export function realWorkerInit(overrides: Partial<FaceWorkerInit> = {}): FaceWorkerInit {
  return {
    models: { yunetPath: MODEL_PATHS.yunet, sfacePath: MODEL_PATHS.sface },
    nodeModulesDir: join(REPO_ROOT, "node_modules"),
    wasmPaths: ortWasmPathsFrom(join(REPO_ROOT, "node_modules", "onnxruntime-web", "dist")),
    config: defaultFaceGateConfig(),
    ...overrides,
  };
}

export function realWorkerSpawner(overrides: Partial<FaceWorkerInit> = {}) {
  return createFaceWorkerSpawner(FACE_WORKER_SOURCE, realWorkerInit(overrides));
}

let shared: WorkerFaceGate | undefined;

/**
 * One real face worker gate for the whole test process, created on first use
 * and never disposed (the process exit ends its worker). A real worker holds
 * an onnxruntime-web heap plus its own pthreads' shared memory, and `bun
 * test` runs every file in ONE process: a dozen workers spawned and
 * terminated across the suite exhausted its address space ("RangeError: Out
 * of memory" while a worker loaded, seen only in the full run) - so tests
 * that just need a working real gate share this one. A test that kills the
 * worker (a cancel) is fine: the gate respawns it. Tests that need their own
 * gate (failure at load, spawn counts) build one with `realWorkerSpawner`.
 */
export function sharedRealFaceGate(): WorkerFaceGate {
  shared ??= createWorkerFaceGate({ spawnWorker: realWorkerSpawner() });
  return shared;
}

/** The fixture master (864x1152, a face filling much of the frame) as a JPEG of exactly `width` x `height`, letterboxed on grey so the face keeps its proportions. */
export function letterboxedMasterJpeg(width: number, height: number): Uint8Array {
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=gray`;
  const result = spawnSync(
    ffmpegPath(),
    ["-y", "-hide_banner", "-loglevel", "error", "-i", join(FIXTURE_IMAGE_DIR, MASTER.file), "-vf", filter, "-c:v", "mjpeg", "-q:v", "2", "-f", "mjpeg", "pipe:1"],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ffmpeg could not build a ${width}x${height} test image: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

/** A 2K portrait render (1536x2752, what the image model returns at 2K). */
export const twoKJpeg = (): Uint8Array => letterboxedMasterJpeg(1536, 2752);
/** A 12 MP phone import (3024x4032). */
export const twelveMegapixelJpeg = (): Uint8Array => letterboxedMasterJpeg(3024, 4032);
