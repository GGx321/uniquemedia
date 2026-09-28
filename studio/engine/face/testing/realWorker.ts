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
// codecs) under bun: the worker's source entry, the cached models, and a few
// real images of the sizes the reviewers measured.

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const FIXTURE_IMAGE_DIR = join(HERE, "..", "fixtures", "images");
export const FACE_WORKER_SOURCE = new URL("../worker/faceWorker.ts", import.meta.url);

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
