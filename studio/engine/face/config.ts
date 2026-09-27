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
 * The identity threshold (0.66) is the plan's "gross-drift" option, and the
 * default here — calibration.test.ts pins these against the spike's real 76
 * true / 3 impostor cosMaster scores (fixtures/spikeCosMaster.ts):
 *
 * - the impostors sit at 0.6208, 0.6479 and 0.6575; no threshold at or below
 *   0.6575 rejects all three, and one genuine true render ties that exact
 *   value, so 0.6575 itself can never cleanly separate them either;
 * - the true scores have a real gap right above it, from 0.6383 up to
 *   0.6575 and then nothing until 0.6652 — 0.66 sits in that gap, clearing
 *   the impostor ceiling with a small margin (+0.0025) rather than sitting
 *   exactly on it;
 * - at 0.66: 0 of 3 impostors pass, 52 of 76 (68%) true renders pass — far
 *   more than the plain 0.70 cutoff's 37 of 76 (49%), for the same zero
 *   false positives on this data.
 *
 * It is the most conservative strategy evaluated that still rejects every
 * known impostor; it will not catch a subtle face swap whose score lands
 * inside that gap, only gross drift (plan: "a different person" or a broken
 * generation).
 *
 * The "gallery" strategy this schema also supports was measured for real
 * (`studio/scripts/faceCalibrationReport.ts`, real embeddings, leave-one-out
 * against the master plus every other true render) and turned out worse, not
 * better: "max" lifts true-positive rate to 74/76 at 0.66, but also lets 1 of
 * the 3 known impostors through (0.7038 — a large gallery makes it likely
 * some unrelated reference happens to resemble an impostor); "mean" keeps
 * every impostor out but crashes true-positive rate to 22/76, since a true
 * render's average similarity to 75 *other* true renders (themselves an
 * imperfect match to each other) is far below its similarity to the actual
 * master. Neither is configured as the default. Keep-best-of-N (generate
 * several, keep the best) tests safe here — it only ever compares each
 * attempt to the master with this same fixed threshold, never to another
 * generated frame — and the plan's own retry budget (invariant 7: at most 3
 * paid attempts per slot) already gives it a free N=3: at 0.70, a single
 * attempt passes 37/76 (49%) of the time, but the report's real groups-of-3
 * measurement puts at-least-one-of-three at 80%; at the 0.66 default, 92%.
 */
export function defaultFaceGateConfig(): FaceGateConfig {
  return {
    detector: { scoreThreshold: 0.7, nmsThreshold: 0.3, topK: 5000 },
    identity: { strategy: { kind: "fixed-threshold", threshold: 0.66 } },
    multipleFaces: { minRelativeArea: 0.2 },
    unexpectedFace: { minScore: 0.7 },
    wasm: { numThreads: 4 },
  };
}
