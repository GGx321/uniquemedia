import type { FaceGateConfig, FacePose } from "./config";
import type { FaceVerdict } from "./verdict";

/** A detected face, independent of YuNet's raw row layout — gate.ts converts. */
export interface DetectedFaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface FaceGatePolicyInput {
  pose: FacePose;
  faces: readonly DetectedFaceBox[];
  /**
   * Required, and only meaningful, for front/three-quarter with exactly one
   * prominent face: the identity similarity the caller already computed
   * (cosine to the master, or the strategy's max/mean aggregate over a
   * gallery — the policy only ever compares one final number to the
   * configured threshold, whatever produced it).
   */
  similarity?: number;
  imageHeight: number;
}

function area(face: DetectedFaceBox): number {
  return Math.max(0, face.width) * Math.max(0, face.height);
}

/**
 * Faces big enough not to be background noise (plan: "more than one
 * prominent face"): at least `minRelativeArea` of the largest detected
 * face's area. The largest face is always included (ratio 1).
 */
export function prominentFaces(faces: readonly DetectedFaceBox[], minRelativeArea: number): DetectedFaceBox[] {
  if (faces.length === 0) return [];
  const largest = Math.max(...faces.map(area));
  if (largest <= 0) return [...faces];
  return faces.filter((f) => area(f) / largest >= minRelativeArea);
}

function headRatioOf(face: DetectedFaceBox, imageHeight: number): number {
  return imageHeight > 0 ? face.height / imageHeight : 0;
}

/**
 * The pose-aware policy (plan, "A pose-aware policy"): decides the gate's
 * verdict from what YuNet found and, for front/three-quarter, an
 * already-computed identity similarity. Pure and synchronous — every model
 * call (detection, embedding, cosine) happens in gate.ts before this runs.
 */
export function decideFaceVerdict(input: FaceGatePolicyInput, config: FaceGateConfig): FaceVerdict {
  const { pose, faces, similarity, imageHeight } = input;

  const prominent = prominentFaces(faces, config.multipleFaces.minRelativeArea);
  if (prominent.length > 1) return { kind: "multiple-faces", faces: faces.length };

  if (pose === "profile") return { kind: "skipped-by-pose", faces: faces.length };

  if (pose === "back") {
    const face = prominent[0];
    // `face.score` is a plain number, but it originated in a Float32Array
    // (YuNet's raw output, in yunet.ts's `detect`): 0.7 stored there rounds
    // to 0.699999988..., so the threshold must be frounded the same way
    // yunet.ts already fronds its own score threshold, or an intended exact
    // match reads as a rejection.
    if (face !== undefined && face.score >= Math.fround(config.unexpectedFace.minScore)) {
      return { kind: "unexpected-face", faces: faces.length, headRatio: headRatioOf(face, imageHeight) };
    }
    return { kind: "skipped-by-pose", faces: faces.length };
  }

  // front / three-quarter: full identity check.
  const face = prominent[0];
  if (face === undefined) return { kind: "no-face", faces: 0 };
  if (similarity === undefined) {
    throw new Error(`face/policy: pose "${pose}" needs a similarity score (compute the embedding and cosine before deciding)`);
  }
  const headRatio = headRatioOf(face, imageHeight);
  const isMatch = similarity >= config.identity.strategy.threshold;
  return isMatch
    ? { kind: "match", similarity, faces: faces.length, headRatio }
    : { kind: "mismatch", similarity, faces: faces.length, headRatio };
}
