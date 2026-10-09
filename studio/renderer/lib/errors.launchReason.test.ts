import { expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, LAUNCH_REASONS, LAUNCH_REASONS_RU, SCENE_REASONS_RU } from "../../shared/engine";
import { errorText } from "./errors";

// A launch the engine refused to plan or start says why (`launchReason`, Stage 4): the window shows this text, so each reason names the cause and the way out.

test("a VALIDATION with no launch reason keeps the general text", () => {
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test.each([...LAUNCH_REASONS])("the reason %s shows its own text, not the general one", (launchReason) => {
  const text = errorText({ code: "VALIDATION", launchReason });
  expect(text).toBe(LAUNCH_REASONS_RU[launchReason]);
  expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test("every launch reason has a text of its own", () => {
  expect(new Set(LAUNCH_REASONS.map((launchReason) => errorText({ code: "VALIDATION", launchReason }))).size).toBe(LAUNCH_REASONS.length);
});

test("a run or set that belongs to a launch says so and sends the owner to the Autopilot", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "launch-set" })).toBe(SCENE_REASONS_RU["launch-set"]);
  expect(errorText({ code: "VALIDATION", sceneReason: "launch-set" })).toContain("Автопилот");
});

test("the review's two refusals show their own texts", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "over-plan" })).toBe(SCENE_REASONS_RU["over-plan"]);
  expect(errorText({ code: "VALIDATION", sceneReason: "not-awaiting" })).toBe(SCENE_REASONS_RU["not-awaiting"]);
});
