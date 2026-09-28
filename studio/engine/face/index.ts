/**
 * The face gate (plan T7b, slice 2c): YuNet detection + SFace identity via
 * onnxruntime-web, a pose-aware policy, and a configurable calibration
 * strategy. See config.ts, policy.ts, gate.ts and calibration.ts for the
 * pieces; parity.test.ts pins this port against the spike's OpenCV numbers.
 *
 * Not wired into the run queue: T6 (job queue) declares `QaGate`, and this
 * module is built so a `QaGate` implementation for identity can be a thin
 * adapter around `FaceGate`, once T6 exists. A plausible shape, guessed from
 * the plan's own description of T6 and T7a (the 2b PDQ gate, the other
 * `QaGate` implementor):
 *
 *   interface QaGate {
 *     check(photo: DecodedPhoto, context: SlotContext): Promise<QaVerdict>;
 *   }
 *
 * where `DecodedPhoto` is the Chromium-decoded RGBA buffer the job queue
 * already has once a candidate image is downloaded (this module never
 * decodes an image file itself — see `FaceGateImage`), and `SlotContext`
 * carries at least the slot's `pose`, the avatar's master embedding (computed
 * once per run via `FaceGate.embed()` and cached — re-aligning and
 * re-embedding the master on every one of a run's ~20 photos would be pure
 * waste) and whatever accepted-frame gallery the run has built so far, for
 * the "gallery" strategy. `FaceGate.check` already takes exactly that shape
 * (`FaceGateInput`), so a `QaGate` adapter for identity is mostly a rename;
 * the age gate (`avatars/ageCheck.ts`) and the PDQ gate (T7a) would implement
 * the same `QaGate` shape alongside it, each folding its own verdict into
 * whatever `QaVerdict` union T6 settles on.
 */
export { defaultFaceGateConfig, FaceGateConfigSchema, FacePoseSchema, IdentityStrategySchema } from "./config";
export type { FaceGateConfig, FacePose, IdentityStrategy } from "./config";
export { createFaceGate, NoFaceInReferenceError, runFaceGate } from "./gate";
export type { FaceGate, FaceGateImage, FaceGateInput, SimilarityContext, SimilarityFn } from "./gate";
export { aggregateSimilarity, evaluateBestOfN, evaluateFixedThreshold, sweepFixedThreshold } from "./calibration";
export type { Aggregate, BestOfNEvaluation, ThresholdEvaluation } from "./calibration";
export { decideFaceVerdict, prominentFaces } from "./policy";
export type { DetectedFaceBox, FaceGatePolicyInput } from "./policy";
export { FACE_PIPELINE_MAX_SIDE, normalizeForFacePipeline } from "./normalize";
export { FACE_MODELS, verifyModelBytes } from "./modelSource";
export type { FaceModelKey, FaceModelSource } from "./modelSource";
export type { FaceVerdict } from "./verdict";
