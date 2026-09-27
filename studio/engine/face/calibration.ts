/**
 * Pure functions over similarity scores, used both by calibration.test.ts
 * (pinning the spike's real numbers, fixtures/spikeCosMaster.ts) and by the
 * one-off report `studio/scripts/faceCalibrationReport.ts` (real embeddings,
 * for the gallery strategy's pairwise numbers the spike never recorded).
 * None of this touches a model or a file — it only counts and aggregates
 * numbers the caller already has.
 */

export interface ThresholdEvaluation {
  threshold: number;
  truePositives: number;
  falseNegatives: number;
  truePositiveRate: number;
  falsePositives: number;
  trueNegatives: number;
  falsePositiveRate: number;
}

/** A score at or above the threshold passes (inclusive), matching policy.ts's own comparison. */
export function evaluateFixedThreshold(trueScores: readonly number[], impostorScores: readonly number[], threshold: number): ThresholdEvaluation {
  const truePositives = trueScores.filter((s) => s >= threshold).length;
  const falsePositives = impostorScores.filter((s) => s >= threshold).length;
  return {
    threshold,
    truePositives,
    falseNegatives: trueScores.length - truePositives,
    truePositiveRate: trueScores.length > 0 ? truePositives / trueScores.length : 0,
    falsePositives,
    trueNegatives: impostorScores.length - falsePositives,
    falsePositiveRate: impostorScores.length > 0 ? falsePositives / impostorScores.length : 0,
  };
}

export function sweepFixedThreshold(
  trueScores: readonly number[],
  impostorScores: readonly number[],
  thresholds: readonly number[],
): ThresholdEvaluation[] {
  return thresholds.map((threshold) => evaluateFixedThreshold(trueScores, impostorScores, threshold));
}

export type Aggregate = "max" | "mean";

/** How the "gallery" strategy (config.ts) turns several reference similarities into one. */
export function aggregateSimilarity(scores: readonly number[], aggregate: Aggregate): number {
  if (scores.length === 0) throw new Error("face/calibration: aggregateSimilarity needs at least one score");
  return aggregate === "max" ? Math.max(...scores) : scores.reduce((a, b) => a + b, 0) / scores.length;
}

export interface BestOfNEvaluation {
  n: number;
  /** Complete groups of n; a trailing partial group is dropped. */
  groups: number;
  /** Fraction of groups whose best score clears `referenceThreshold`. */
  passRate: number;
}

/**
 * Retrospective estimate for "keep-best-of-N" (plan: generate several and
 * keep the highest-scoring instead of an absolute gate): splits `scores`
 * into consecutive groups of `n` and reports how often a group's max clears
 * `referenceThreshold`. This is not a per-image gate decision (there is
 * nothing to decide until N attempts exist), so — unlike fixed-threshold and
 * gallery — it has no config.ts strategy of its own; the job queue (T6)
 * would need to actually run N attempts and keep the best.
 */
export function evaluateBestOfN(scores: readonly number[], n: number, referenceThreshold: number): BestOfNEvaluation {
  if (n <= 0) throw new Error("face/calibration: evaluateBestOfN needs n >= 1");
  const groups = Math.floor(scores.length / n);
  let passing = 0;
  for (let g = 0; g < groups; g++) {
    const chunk = scores.slice(g * n, g * n + n);
    if (Math.max(...chunk) >= referenceThreshold) passing++;
  }
  return { n, groups, passRate: groups > 0 ? passing / groups : 0 };
}
