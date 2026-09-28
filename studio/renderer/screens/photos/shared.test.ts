import { expect, test } from "bun:test";
import { defaultFaceGateConfig } from "../../../engine/face/config";
import { FALLBACK_IMAGE_MODEL } from "../../../engine/runs/plan";
import { FACE_GATE_THRESHOLD, SEEDREAM_FALLBACK_IMAGE_MODEL } from "./shared";

// L2: FACE_GATE_THRESHOLD is not in the contract, so it is a copy of the
// engine's own identity threshold (engine/face/config.ts's
// defaultFaceGateConfig) kept only for the gallery's low-score badge. A
// read-only cross-check against the engine's own value — never a hardcoded
// duplicate the two could silently drift apart from.
test("FACE_GATE_THRESHOLD matches the engine's own face gate identity threshold", () => {
  const config = defaultFaceGateConfig();
  if (config.identity.strategy.kind !== "fixed-threshold") throw new Error("expected the default gate to use a fixed threshold");
  expect(FACE_GATE_THRESHOLD).toBe(config.identity.strategy.threshold);
});

// L3: SEEDREAM_FALLBACK_IMAGE_MODEL is a copy of the engine's own one-attempt
// fallback model id (engine/runs/plan.ts), kept only to describe the shot
// caption's quality word right (runRoute sends quality: null once the
// settings' own image model already is this fallback).
test("SEEDREAM_FALLBACK_IMAGE_MODEL matches the engine's own fallback image model", () => {
  expect(SEEDREAM_FALLBACK_IMAGE_MODEL).toBe(FALLBACK_IMAGE_MODEL);
});
