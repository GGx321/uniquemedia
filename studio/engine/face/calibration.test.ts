import { expect, test } from "bun:test";
import { aggregateSimilarity, evaluateBestOfN, evaluateFixedThreshold, sweepFixedThreshold } from "./calibration";
import { SPIKE_IMPOSTOR_COSMASTER, SPIKE_TRUE_RENDER_COSMASTER } from "./fixtures/spikeCosMaster";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("evaluateFixedThreshold counts true/false positives and negatives from two small arrays", () => {
  const result = evaluateFixedThreshold([0.9, 0.5, 0.3], [0.4, 0.2], 0.5);
  expect(result).toEqual({
    threshold: 0.5,
    truePositives: 2, // 0.9, 0.5 (inclusive)
    falseNegatives: 1, // 0.3
    truePositiveRate: 2 / 3,
    falsePositives: 0, // neither impostor reaches 0.5
    trueNegatives: 2,
    falsePositiveRate: 0,
  });
});

test("a threshold at exactly a score counts that score as passing (inclusive)", () => {
  expect(evaluateFixedThreshold([0.5], [], 0.5).truePositives).toBe(1);
});

// Real SFace cosine-to-master values from the face spike (fixtures/spikeCosMaster.ts).
// These pin the plan's own findings and this module's own recommendation.

test("at the plain 0.70 cutoff, all 3 impostors are rejected but only 37/76 true renders pass (spike README, Recommendation section)", () => {
  const result = evaluateFixedThreshold(SPIKE_TRUE_RENDER_COSMASTER, SPIKE_IMPOSTOR_COSMASTER, 0.7);
  expect(result.truePositives).toBe(37);
  expect(result.falsePositives).toBe(0);
});

test("0.66 sits in a real gap between the impostor ceiling and the next cluster of true renders, and keeps 52/76 (config.ts's default)", () => {
  const result = evaluateFixedThreshold(SPIKE_TRUE_RENDER_COSMASTER, SPIKE_IMPOSTOR_COSMASTER, 0.66);
  expect(result.falsePositives).toBe(0);
  expect(result.truePositives).toBe(52);
});

test("no threshold at or below the impostor ceiling (0.6575) rejects every impostor: one true render ties it exactly", () => {
  // The tie (a genuine true render also scores 0.6575) means the impostor
  // ceiling and a true score coincide: 0.6575 can never cleanly separate them.
  const atCeiling = evaluateFixedThreshold(SPIKE_TRUE_RENDER_COSMASTER, SPIKE_IMPOSTOR_COSMASTER, 0.6575);
  expect(atCeiling.falsePositives).toBeGreaterThan(0);
});

test("sweepFixedThreshold reports one evaluation per threshold, in the given order", () => {
  const results = sweepFixedThreshold(SPIKE_TRUE_RENDER_COSMASTER, SPIKE_IMPOSTOR_COSMASTER, [0.55, 0.66, 0.7]);
  expect(results.map((r) => r.threshold)).toEqual([0.55, 0.66, 0.7]);
  // 0.55 is below the impostor ceiling: every impostor still passes.
  expect(results[0]!.falsePositives).toBe(3);
});

test("aggregateSimilarity 'max' picks the highest of several gallery scores", () => {
  expect(aggregateSimilarity([0.3, 0.9, 0.5], "max")).toBeCloseTo(0.9, 6);
});

test("aggregateSimilarity 'mean' averages the gallery scores", () => {
  expect(aggregateSimilarity([0.2, 0.4, 0.6], "mean")).toBeCloseTo(0.4, 6);
});

test("aggregateSimilarity throws on an empty gallery", () => {
  expect(() => aggregateSimilarity([], "max")).toThrow();
});

test("evaluateBestOfN groups scores into chunks of n and keeps each chunk's max", () => {
  // 6 true scores split into 2 groups of 3: [0.9,0.5,0.3] -> 0.9, [0.4,0.6,0.2] -> 0.6.
  const result = evaluateBestOfN([0.9, 0.5, 0.3, 0.4, 0.6, 0.2], 3, 0.7);
  expect(result.groups).toBe(2);
  expect(result.passRate).toBeCloseTo(0.5, 6); // only the first group's max (0.9) clears 0.7
});

test("evaluateBestOfN drops a trailing partial group", () => {
  const result = evaluateBestOfN([0.9, 0.5, 0.3, 0.4], 3, 0.7);
  expect(result.groups).toBe(1);
});

test("evaluateBestOfN of the spike's true renders: keeping the best of 3 clears the plain 0.70 cutoff far more often than one attempt", () => {
  const oneAttempt = evaluateFixedThreshold(SPIKE_TRUE_RENDER_COSMASTER, [], 0.7).truePositiveRate;
  const bestOfThree = evaluateBestOfN(SPIKE_TRUE_RENDER_COSMASTER, 3, 0.7);
  expect(bestOfThree.passRate).toBeGreaterThan(oneAttempt);
});
