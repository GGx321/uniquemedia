import { aggregateSimilarity } from "./calibration";
import type { FaceGateConfig } from "./config";
import type { FacePose } from "./config";
import { defaultFaceGateConfig } from "./config";
import { rgbaToBgr } from "./pixels";
import type { BgrImage } from "./pixels";
import { decideFaceVerdict, prominentFaces } from "./policy";
import type { DetectedFaceBox } from "./policy";
import { alignCrop, cosine, createRecognizer, feature } from "./sface";
import type { FaceVerdict } from "./verdict";
import { createDetector, detect } from "./yunet";
import type { Detector } from "./yunet";

/** Decoded pixels handed to the gate: RGBA, whatever produced them (Chromium's job, not this module's — see index.ts). */
export interface FaceGateImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface FaceGateInput {
  pose: FacePose;
  image: FaceGateImage;
  /** The master's SFace embedding — computed once per avatar via `FaceGate.embed()` and reused across a run. */
  masterEmbedding: Float32Array;
  /** Extra accepted-frame embeddings for the "gallery" strategy (config.ts); ignored by "fixed-threshold". */
  galleryEmbeddings?: readonly Float32Array[];
}

export interface FaceGate {
  check(input: FaceGateInput): Promise<FaceVerdict>;
  /** The reference image's SFace embedding, for the caller to cache (the master, or a gallery frame). Throws if it finds no face. */
  embed(image: FaceGateImage): Promise<Float32Array>;
  /** Releases the onnxruntime-web sessions. */
  dispose(): Promise<void>;
}

function toBox(row: Float32Array): DetectedFaceBox {
  return { x: row[0] ?? 0, y: row[1] ?? 0, width: row[2] ?? 0, height: row[3] ?? 0, score: row[14] ?? 0 };
}

function largestByArea(faces: readonly Float32Array[]): Float32Array | undefined {
  return faces.reduce<Float32Array | undefined>((best, f) => {
    const area = (f[2] ?? 0) * (f[3] ?? 0);
    const bestArea = best ? (best[2] ?? 0) * (best[3] ?? 0) : -1;
    return area > bestArea ? f : best;
  }, undefined);
}

/** What `runFaceGate`'s injected `similarityFn` needs to compute one identity score. */
export interface SimilarityContext {
  bgr: BgrImage;
  /** The chosen face's raw YuNet row (for `alignCrop`). */
  face: Float32Array;
  masterEmbedding: Float32Array;
  galleryEmbeddings: readonly Float32Array[];
}
export type SimilarityFn = (ctx: SimilarityContext) => Promise<number>;
export type DetectFn = (detector: Detector, bgr: BgrImage) => Promise<Float32Array[]>;

/**
 * The gate's orchestration, with the model calls injected (`similarityFn`,
 * `detectFn`) so it is fully unit-testable without a real model — see
 * gate.test.ts. `createFaceGate` below wires the real ones in.
 *
 * Detection always runs (any pose can hit "multiple-faces"). The identity
 * embedding+cosine only runs for front/three-quarter with exactly one
 * prominent face, matching `decideFaceVerdict`'s own rule — every other path
 * (no face, profile, back, multiple faces) never touches the recognizer.
 */
export async function runFaceGate(
  bgr: BgrImage,
  input: { pose: FacePose; masterEmbedding: Float32Array; galleryEmbeddings?: readonly Float32Array[] },
  detector: Detector,
  config: FaceGateConfig,
  similarityFn: SimilarityFn,
  detectFn: DetectFn = detect,
): Promise<FaceVerdict> {
  const rawFaces = await detectFn(detector, bgr);
  const boxes = rawFaces.map(toBox);
  const prominent = prominentFaces(boxes, config.multipleFaces.minRelativeArea);

  let similarity: number | undefined;
  if ((input.pose === "front" || input.pose === "three-quarter") && prominent.length === 1) {
    const chosenBox = prominent[0];
    const face = rawFaces.find((row, i) => boxes[i] === chosenBox);
    if (face !== undefined) {
      similarity = await similarityFn({
        bgr,
        face,
        masterEmbedding: input.masterEmbedding,
        galleryEmbeddings: input.galleryEmbeddings ?? [],
      });
    }
  }

  return decideFaceVerdict({ pose: input.pose, faces: boxes, similarity, imageHeight: bgr.height }, config);
}

/**
 * The real `SimilarityFn`: aligns and embeds the chosen face, then compares
 * it to the master (and, for the "gallery" strategy, every gallery frame
 * too), aggregating per config.ts's `identity.strategy`.
 */
function realSimilarityFn(recognizer: import("onnxruntime-web").InferenceSession, config: FaceGateConfig): SimilarityFn {
  return async (ctx) => {
    const embedding = await feature(recognizer, alignCrop(ctx.bgr, ctx.face));
    const strategy = config.identity.strategy;
    if (strategy.kind === "fixed-threshold") return cosine(embedding, ctx.masterEmbedding);
    const scores = [cosine(embedding, ctx.masterEmbedding), ...ctx.galleryEmbeddings.map((g) => cosine(embedding, g))];
    return aggregateSimilarity(scores, strategy.aggregate);
  };
}

/**
 * Creates a face gate backed by real onnxruntime-web sessions. `models` are
 * raw bytes — reading them from disk (asar-safe paths, the fetch cache) is
 * the caller's job, never this module's (studio/engine's runtime rule: no
 * filesystem path resolution tied to `process`/`import.meta`).
 *
 * `wasmPaths` (packaging, plan T7b) must be set explicitly to the .wasm/.mjs
 * files' real, asar-*unpacked* location once packaged — resolving that path
 * needs `process.resourcesPath` or similar, which is exactly what this
 * module's runtime rule forbids, so the caller (T6's wiring) computes it and
 * hands it in; omitted, onnxruntime-web falls back to resolving it relative
 * to its own bundled module location, which does not survive being bundled
 * into `engine/main.js` by electron-vite.
 */
export async function createFaceGate(
  models: { yunet: Uint8Array; sface: Uint8Array },
  config: FaceGateConfig = defaultFaceGateConfig(),
  wasmPaths?: import("onnxruntime-web").Env.WasmPrefixOrFilePaths,
): Promise<FaceGate> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = config.wasm.numThreads;
  if (wasmPaths !== undefined) ort.env.wasm.wasmPaths = wasmPaths;
  const sessionOptions: import("onnxruntime-web").InferenceSession.SessionOptions = { executionProviders: ["wasm"], logSeverityLevel: 3 };
  const detector = await createDetector(models.yunet, config.detector, sessionOptions);
  const recognizer = await createRecognizer(models.sface, sessionOptions);
  const similarityFn = realSimilarityFn(recognizer, config);

  return {
    async check(input: FaceGateInput): Promise<FaceVerdict> {
      const bgr = rgbaToBgr(input.image.width, input.image.height, input.image.data);
      return runFaceGate(bgr, input, detector, config, similarityFn);
    },
    async embed(image: FaceGateImage): Promise<Float32Array> {
      const bgr = rgbaToBgr(image.width, image.height, image.data);
      const faces = await detect(detector, bgr);
      const face = largestByArea(faces);
      if (face === undefined) throw new Error("face/gate: embed() found no face in the reference image");
      return feature(recognizer, alignCrop(bgr, face));
    },
    async dispose(): Promise<void> {
      await detector.session.release();
      await recognizer.release();
    },
  };
}
