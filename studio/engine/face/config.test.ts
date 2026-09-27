import { expect, test } from "bun:test";
import { FaceGateConfigSchema, defaultFaceGateConfig } from "./config";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("the default config parses as valid", () => {
  const parsed = FaceGateConfigSchema.parse(defaultFaceGateConfig());
  expect(parsed.identity.strategy.kind).toBe("fixed-threshold");
});

test("the default identity threshold is the owner's hybrid decision: 0.55, gross drift only", () => {
  // Owner decision (2c review): auto-retry only on a clear failure — no
  // face, multiple faces, an unexpected back-facing face, or similarity
  // below 0.55 (a different person). Every other frame passes and always
  // carries its similarity so the Photos gallery can show it as a badge;
  // the owner judges the rest by eye. calibration.test.ts pins the real
  // numbers (0.55: 74/76 true pass, but also every impostor; 0.66: 52/76,
  // 0 impostors; 0.70: 37/76, 0 impostors) — 0.66 and 0.70 stay available
  // as stricter config choices, just not the default.
  const config = defaultFaceGateConfig();
  expect(config.identity.strategy).toEqual({ kind: "fixed-threshold", threshold: 0.55 });
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
