import { createHash } from "node:crypto";

/**
 * Pinned model sources (plan T7b, packaging): both hashes were verified by
 * hand against `opencv/opencv_zoo`'s `main` branch on 2026-09-27, and against
 * the copies the face spike (`spike/face-js/`, `spike/studio-api/`) already
 * downloaded and validated. Neither the `.onnx` file itself nor this hash is
 * ever expected to change — a future model update needs a new pinned entry,
 * not an edit to these two.
 *
 * These bytes are never committed to git (38.7 MB + 233 KB): production and
 * CI fetch them into a gitignored cache keyed by this same hash
 * (`studio/scripts/fetchFaceModels.ts`), and the engine itself only ever
 * receives already-verified bytes as a parameter (its own runtime rule
 * forbids resolving a filesystem path itself).
 */
export interface FaceModelSource {
  /** The file name the cache and the packaged app use. */
  file: string;
  url: string;
  sha256: string;
  /** For a fetch progress bar and a sanity check after download; not enforced. */
  approxBytes: number;
}

export const FACE_MODELS = {
  yunet: {
    file: "face_detection_yunet_2023mar.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    approxBytes: 233_000,
  },
  sface: {
    file: "face_recognition_sface_2021dec.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    approxBytes: 38_700_000,
  },
} as const satisfies Record<string, FaceModelSource>;

export type FaceModelKey = keyof typeof FACE_MODELS;

/** Throws with `label` in the message if `bytes`'s sha256 does not match `expectedSha256`. */
export function verifyModelBytes(bytes: Uint8Array, expectedSha256: string, label: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`face/modelSource: ${label} hash mismatch (expected ${expectedSha256}, got ${actual})`);
  }
}
