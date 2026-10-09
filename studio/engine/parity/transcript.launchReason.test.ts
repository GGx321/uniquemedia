import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { EngineError } from "../../shared/engine";
import { answerLine, Normalizer } from "./testing/transcript";
useNativeGlobals();

// Stage 4 (review M3): the refusal of a start names its reason in a closed code, so the transcript compares it; an error without one is written as it always was.

describe("answerLine", () => {
  const line = (error: EngineError) => answerLine("autopilot.start", { ok: false, error }, new Normalizer());

  test("writes the launch reason of a VALIDATION", () => {
    expect(line({ code: "VALIDATION", launchReason: "open-set" })).toBe('< error VALIDATION {"launchReason":"open-set"}');
    expect(line({ code: "VALIDATION", launchReason: "nothing-enabled" })).not.toBe(line({ code: "VALIDATION", launchReason: "open-set" }));
  });

  test("an error without one is written exactly as before", () => {
    expect(line({ code: "VALIDATION" })).toBe("< error VALIDATION {}");
    expect(line({ code: "VALIDATION", sceneReason: "not-awaiting" })).toBe('< error VALIDATION {"sceneReason":"not-awaiting"}');
  });
});
