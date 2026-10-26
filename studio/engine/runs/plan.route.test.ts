import { describe, expect, test } from "bun:test";
import { plan, type PlanSlot } from "../scenes";
import { BOLD_IMAGE_MODEL, buildRunPlan, buildSceneRunPlan, requestBoldPhotos, routedScenes, routedSlots, type NewRunPlan, type NewSceneRunPlan } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §8.1, I5.43): a plan writes `models.bold` ONLY when it has a Seedream slot, so a plan without one is byte for byte the document it always was.

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const SENTENCE = "She laughs in the doorway while the evening light falls across the hall floor behind her.";

/**
 * The slots of a plan: at the `routed` indexes a «Ночнушки и бельё» slot, drawn on the Seedream route by the planner; at the others a «Дом» slot, off the route.
 * 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear slot is on the route now, so the slots off it are «Дом»'s (they were nightwear's own cotton slots).
 */
function slots(count: number, routed: readonly number[]): PlanSlot[] {
  const nightwear = plan({ seed: 7, count, categories: ["nightwear"] }).slots;
  const home = plan({ seed: 7, count, categories: ["home"] }).slots;
  return home.map((slot, i) => {
    const drawn = nightwear[i];
    if (!routed.includes(i)) return slot;
    if (drawn?.route !== "seedream") throw new Error("a nightwear slot is off the route");
    return { ...drawn, slotIndex: slot.slotIndex, attemptIdBase: slot.attemptIdBase };
  });
}

function runInput(routed: readonly number[]): NewRunPlan {
  const drawn = slots(4, routed);
  return {
    runId: "run-00000001",
    avatarId: "avatar-0001",
    createdAt: "2026-10-12T12:00:00.000Z",
    request: { avatarId: "avatar-0001", count: 4, categories: ["home", "nightwear"] },
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

describe("routedSlots, routedScenes and requestBoldPhotos", () => {
  test("count the slots drawn on the Seedream route and no other", () => {
    expect(routedSlots(slots(4, [0, 3]))).toBe(2);
  });

  test("count none for a plan whose slots carry no route", () => {
    expect(routedSlots(slots(4, []))).toBe(0);
  });

  test("count the scenes whose slot is on the route; an own scene never is", () => {
    const drawn = slots(3, [1]);
    const own = { kind: "own" as const, shot: "friend" as const, pose: "front" as const };
    expect(routedScenes([...drawn.map((slot) => ({ slot })), { slot: own }])).toBe(1);
  });

  // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 I5.77, BA3 review H-1): «Смелая» is every category's, so the planner puts every slot of a «Смелая» request on the route, and a request not
  // yet planned is priced at the 2K attempt for EVERY photo. This row told the pre-5a.4 rule («its split's photos in «Смелая» categories»: 3 of 7 for «Дом» + «Ночнушки и бельё», 0 for
  // the five), which priced «Дом» at «Смелая» on the owner's model while the planner drew it on Seedream.
  test("a request's bold photos are all its photos at «Смелая», whatever its categories", () => {
    expect(requestBoldPhotos({ count: 7, categories: ["home", "nightwear"], level: "bold" })).toBe(7);
    expect(requestBoldPhotos({ count: 10, categories: ["nightwear", "beach"], level: "bold" })).toBe(10);
    expect(requestBoldPhotos({ count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], level: "bold" })).toBe(20);
    expect(requestBoldPhotos({ count: 20, categories: ["cat-0123456789ab"], level: "bold" })).toBe(20);
  });

  test("a request below «Смелая» has no bold photos, whatever its categories", () => {
    for (const level of [undefined, "ordinary", "flirty"] as const) expect({ level, bold: requestBoldPhotos({ count: 10, categories: ["home", "travel"], level }) }).toEqual({ level, bold: 0 });
  });

  test("the level is a required key: a caller that forgets it does not compile", () => {
    // @ts-expect-error `level` is a required key (plan s5a4 M3): a caller with no level to hand says `level: undefined`
    expect(requestBoldPhotos({ count: 10, categories: ["home"] })).toBe(0);
  });
});
