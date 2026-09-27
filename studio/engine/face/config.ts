import { z } from "zod";

/**
 * A scene slot's pose (plan: "A pose-aware policy"), assigned by the scene
 * planner (a later task). front/three-quarter get a full identity check;
 * profile skips it (YuNet detects profiles poorly and SFace is unreliable on
 * them); back skips it too, but a confidently detected face is suspicious —
 * the model ignored the "from behind" instruction.
 */
export const FacePoseSchema = z.enum(["front", "three-quarter", "profile", "back"]);
export type FacePose = z.infer<typeof FacePoseSchema>;

/**
 * How a similarity score becomes a pass/fail (calibration.ts's report on the
 * spike's 76 true / 3 impostor frames). "fixed-threshold" also covers the
 * "gross-drift" option from the plan — the same comparison, at a lower,
 * deliberately permissive value. "gallery" scores against several accepted
 * reference embeddings (the master plus already-accepted frames from the
 * run) instead of the master alone, aggregating by the max or mean cosine.
 * "best-of-N" (keep the highest-scoring of several generated candidates
 * instead of gating on an absolute cutoff) is not a per-image decision this
 * gate can make on its own — it needs several candidates to compare, which is
 * the job queue's job (T6) — so calibration.ts reports its numbers but this
 * schema has no variant for it.
 */
export const IdentityStrategySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fixed-threshold"), threshold: z.number().min(-1).max(1) }),
  z.strictObject({
    kind: z.literal("gallery"),
    threshold: z.number().min(-1).max(1),
    aggregate: z.enum(["max", "mean"]),
  }),
]);
export type IdentityStrategy = z.infer<typeof IdentityStrategySchema>;

export const FaceGateConfigSchema = z.strictObject({
  /** YuNet FaceDetectorYN.create's own three parameters (face.py / the spike's DETECTOR_OPTIONS). */
  detector: z.strictObject({
    scoreThreshold: z.number().min(0).max(1),
    nmsThreshold: z.number().min(0).max(1),
    topK: z.number().int().positive(),
  }),
  identity: z.strictObject({ strategy: IdentityStrategySchema }),
  /**
   * A second detected face counts as "prominent" (plan: "more than one
   * prominent face -> multiple-faces") when its box area is at least this
   * fraction of the largest face's area; a small background face stays
   * beneath it. The largest face is always prominent (ratio 1), so this
   * alone never turns a genuine single-face photo into "no face".
   */
  multipleFaces: z.strictObject({ minRelativeArea: z.number().min(0).max(1) }),
  /**
   * Pose "back": a detected face only becomes "unexpected-face" at or above
   * this YuNet score (plan: "a face IS detected with good confidence"). Below
   * it, a stray low-confidence detection is treated the same as no face.
   */
  unexpectedFace: z.strictObject({ minScore: z.number().min(0).max(1) }),
  wasm: z.strictObject({ numThreads: z.number().int().positive() }),
});
export type FaceGateConfig = z.infer<typeof FaceGateConfigSchema>;

/**
 * Same values as face.py / the spike: FaceDetectorYN.create(..., 0.7, 0.3,
 * 5000) — 0.7 rather than the 0.9 sample default so three-quarter faces are
 * kept (spike/studio-api README, "Planner rules"... no: "face.py --help").
 *
 * The identity threshold — OWNER DECISION (2c review of this gate): a
 * hybrid, not a strict identity gate. Auto-retry (the job queue's, T6) fires
 * only on a *clear* failure: no face on a front/three-quarter shot,
 * multiple prominent faces, an unexpected face on a back shot, or — this
 * threshold — similarity below 0.55 ("gross drift": a different person, or a
 * broken generation). Every frame that clears 0.55 is a `match` and is kept,
 * never retried, and its `similarity` is always carried on the verdict (see
 * verdict.ts) so the Photos gallery can show it as a badge; the owner judges
 * the rest by eye rather than an automatic cutoff silently discarding a
 * usable photo.
 *
 * calibration.test.ts pins these against the spike's real 76 true / 3
 * impostor cosMaster scores (fixtures/spikeCosMaster.ts):
 *
 * - 0.55: 74 of 76 (97%) true renders pass — but so does every one of the 3
 *   known impostors. This threshold is *not* meant to reject a look-alike;
 *   it only catches a render clearly off (below even the worst impostor
 *   minus a further ~0.07), which the owner's eye-check backstops for
 *   anything subtler;
 * - 0.66: 52 of 76 (68%) true renders pass, 0 of 3 impostors — the impostors
 *   sit at 0.6208, 0.6479 and 0.6575 (one true render ties that last value
 *   exactly, so 0.6575 itself can never cleanly separate them), and the true
 *   scores have a real gap from 0.6383 up to 0.6575 and then nothing until
 *   0.6652, where 0.66 sits with a small margin;
 * - 0.70 (the plain spike cutoff): 37 of 76 (49%) true renders pass, 0 of 3
 *   impostors.
 *
 * 0.66 and 0.70 stay available as stricter, non-default config choices — a
 * future run could use one of them instead if the owner ever wants an
 * automatic identity gate rather than a badge-and-eyeball flow.
 *
 * The "gallery" strategy this schema also supports was measured for real
 * (`studio/scripts/faceCalibrationReport.ts`, real embeddings, leave-one-out
 * against the master plus every other true render) and turned out worse, not
 * better, than a fixed threshold: "max" lifts true-positive rate to 74/76 at
 * 0.66, but also lets 1 of the 3 known impostors through (0.7038 — a large
 * gallery makes it likely some unrelated reference happens to resemble an
 * impostor); "mean" keeps every impostor out but crashes true-positive rate
 * to 22/76, since a true render's average similarity to 75 *other* true
 * renders (themselves an imperfect match to each other) is far below its
 * similarity to the actual master. Neither is configured as the default.
 */
export function defaultFaceGateConfig(): FaceGateConfig {
  return {
    detector: { scoreThreshold: 0.7, nmsThreshold: 0.3, topK: 5000 },
    identity: { strategy: { kind: "fixed-threshold", threshold: 0.55 } },
    multipleFaces: { minRelativeArea: 0.2 },
    unexpectedFace: { minScore: 0.7 },
    wasm: { numThreads: 4 },
  };
}
