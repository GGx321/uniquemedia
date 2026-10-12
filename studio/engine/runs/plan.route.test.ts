import { describe, expect, test } from "bun:test";
import { plan, type PlanSlot } from "../scenes";
import { BOLD_IMAGE_MODEL, buildRunPlan, buildSceneRunPlan, type NewRunPlan, type NewSceneRunPlan } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §8.1, I5.43): a plan writes `models.bold` ONLY when it has a Seedream slot, so a plan without one is byte for byte the document it always was.

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const SENTENCE = "She laughs in the doorway while the evening light falls across the hall floor behind her.";

/** Slots of «Ночнушки и бельё`, the ones at `routed` indexes marked as drawn on the Seedream route (what S5.9c's planner will do for a bold slot). */
function slots(count: number, routed: readonly number[]): PlanSlot[] {
  return plan({ seed: 7, count, categories: ["nightwear"] }).slots.map((slot, i) => (routed.includes(i) ? { ...slot, route: "seedream" as const } : slot));
}

function runInput(routed: readonly number[]): NewRunPlan {
  const drawn = slots(4, routed);
  return {
    runId: "run-00000001",
    avatarId: "avatar-0001",
    createdAt: "2026-10-12T12:00:00.000Z",
    request: { avatarId: "avatar-0001", count: 4, categories: ["nightwear"] },
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 5_000_000,
    plannedWorstMicros: 5_000_000,
    scenes: { version: 1, seed: 7, slots: drawn },
  };
}

function setInput(routed: readonly number[]): NewSceneRunPlan {
  const drawn = slots(4, routed);
  return {
    runId: "run-00000002",
    avatarId: "avatar-0001",
    createdAt: "2026-10-12T12:00:00.000Z",
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 5_000_000,
    plannedWorstMicros: 5_000_000,
    scenes: drawn.map((slot, i) => ({ sceneId: i + 1, text: `${SENTENCE} (${i + 1})`, slot })),
  };
}

describe("buildRunPlan", () => {
  test("writes the bold model when a slot is on the Seedream route", () => {
    expect(buildRunPlan(runInput([1])).models.bold).toBe(BOLD_IMAGE_MODEL);
  });

  test("writes no bold model when no slot is", () => {
    expect("bold" in buildRunPlan(runInput([])).models).toBe(false);
  });

  test("keeps every slot's route as the planner drew it", () => {
    const built = buildRunPlan(runInput([0, 2]));
    expect(built.scenes.slots.map((slot) => ("route" in slot ? slot.route : undefined))).toEqual(["seedream", undefined, "seedream", undefined]);
  });

  test("leaves the settings' model and its fallback as they were", () => {
    expect(buildRunPlan(runInput([1])).models).toMatchObject({ image: MODELS.imageModel, fallback: BOLD_IMAGE_MODEL, text: MODELS.textModel });
  });

  test("a plan with no Seedream slot has exactly the models it had before the route", () => {
    expect(buildRunPlan(runInput([])).models).toEqual({ image: MODELS.imageModel, fallback: BOLD_IMAGE_MODEL, text: MODELS.textModel });
  });
});

describe("buildSceneRunPlan", () => {
  test("writes the bold model when a scene is on the Seedream route", () => {
    expect(buildSceneRunPlan(setInput([3])).models.bold).toBe(BOLD_IMAGE_MODEL);
  });

  test("writes no bold model when no scene is", () => {
    expect("bold" in buildSceneRunPlan(setInput([])).models).toBe(false);
  });

  test("carries each scene's route into its slot", () => {
    const built = buildSceneRunPlan(setInput([1, 3]));
    expect(built.scenes.slots.map((slot) => ("route" in slot ? slot.route : undefined))).toEqual([undefined, "seedream", undefined, "seedream"]);
  });
});
