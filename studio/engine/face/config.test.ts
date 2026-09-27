import { expect, test } from "bun:test";
import { FaceGateConfigSchema, defaultFaceGateConfig } from "./config";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("the default config parses as valid", () => {
  const parsed = FaceGateConfigSchema.parse(defaultFaceGateConfig());
  expect(parsed.identity.strategy.kind).toBe("fixed-threshold");
});

test("the default strategy is the gross-drift threshold, not the naive 0.70 cutoff", () => {
  // The spike found 0.70 rejects 39/76 true renders; a lower, gross-drift-only
  // threshold is the most conservative choice that still keeps most of them
  // (calibration.test.ts pins the exact numbers). 0.70 stays available as an
  // explicit config choice, just not the default.
  const config = defaultFaceGateConfig();
  expect(config.identity.strategy.kind).toBe("fixed-threshold");
  if (config.identity.strategy.kind === "fixed-threshold") {
    expect(config.identity.strategy.threshold).toBeLessThan(0.7);
  }
});

test("rejects a negative detector score threshold", () => {
  const config = defaultFaceGateConfig();
  config.detector.scoreThreshold = -0.1;
  expect(() => FaceGateConfigSchema.parse(config)).toThrow();
});

test("rejects a cosine threshold outside -1..1", () => {
  const config = defaultFaceGateConfig();
  config.identity.strategy = { kind: "fixed-threshold", threshold: 1.5 };
  expect(() => FaceGateConfigSchema.parse(config)).toThrow();
});

test("rejects a multiple-faces area ratio outside 0..1", () => {
  const config = defaultFaceGateConfig();
  config.multipleFaces.minRelativeArea = 1.5;
  expect(() => FaceGateConfigSchema.parse(config)).toThrow();
});

test("accepts a gallery strategy with an aggregate", () => {
  const config = defaultFaceGateConfig();
  config.identity.strategy = { kind: "gallery", threshold: 0.6, aggregate: "max" };
  expect(() => FaceGateConfigSchema.parse(config)).not.toThrow();
});
