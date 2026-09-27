import { describe, expect, test } from "bun:test";
import { plan } from "./planner";
import { PlanSlotSchema, ScenePlanSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

function baseSlot(): Record<string, unknown> {
  return {
    slotIndex: 1,
    category: "home",
    location: "x",
    timeOfDay: "morning",
    activity: "y",
    outfit: "z",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
  };
}

const ALL = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;

describe("ScenePlanSchema", () => {
  test("round-trips a real 20-photo plan through JSON exactly", () => {
    const original = plan({ seed: 20260924, count: 20, categories: [...ALL] });
    const roundTripped = ScenePlanSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(roundTripped).toEqual(original);
  });

  test("round-trips an empty plan", () => {
    const original = plan({ seed: 1, count: 0, categories: [] });
    expect(ScenePlanSchema.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  test("rejects an unknown top-level key (strict)", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, extra: true }).success).toBe(false);
  });

  test("rejects a slot missing a required field", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const { outfit: _outfit, ...rest } = good.slots[0]!;
    expect(ScenePlanSchema.safeParse({ ...good, slots: [rest] }).success).toBe(false);
  });

  test("rejects a slot with an unknown key (strict)", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, slots: [{ ...good.slots[0], extra: 1 }] }).success).toBe(false);
  });

  test("rejects a slot missing repeatedPair", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const { repeatedPair: _repeatedPair, ...rest } = good.slots[0]!;
    expect(ScenePlanSchema.safeParse({ ...good, slots: [rest] }).success).toBe(false);
  });

  test("rejects a non-boolean repeatedPair", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, slots: [{ ...good.slots[0], repeatedPair: "yes" }] }).success).toBe(false);
  });

  test("rejects an attemptIdBase that does not match slot-<n>", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], attemptIdBase: "not-a-slot-id" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], category: "sports" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an unknown shot", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    const bad = { ...good, slots: [{ ...good.slots[0], shot: "drone" }] };
    expect(ScenePlanSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a version other than 1", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, version: 2 }).success).toBe(false);
  });

  test("rejects a non-integer seed", () => {
    const good = plan({ seed: 1, count: 1, categories: ["home"] });
    expect(ScenePlanSchema.safeParse({ ...good, seed: 1.5 }).success).toBe(false);
  });
});

describe("PlanSlotSchema pose (T5c)", () => {
  test("accepts a well-formed slot with a valid pose", () => {
    expect(PlanSlotSchema.safeParse(baseSlot()).success).toBe(true);
  });

  test.each(["front", "three-quarter", "profile", "back"])("accepts pose %s on a non-phone-in-hand shot", (pose) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot: "friend", pose }).success).toBe(true);
  });

  test("rejects an unknown pose value", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), pose: "overhead" }).success).toBe(false);
  });

  test("rejects a slot missing pose", () => {
    const { pose: _pose, ...rest } = baseSlot();
    expect(PlanSlotSchema.safeParse(rest).success).toBe(false);
  });

  test.each(["selfie", "mirror"])("rejects pose profile on a %s shot (her face must stay visible)", (shot) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "profile" }).success).toBe(false);
  });

  test.each(["selfie", "mirror"])("rejects pose back on a %s shot (her face must stay visible)", (shot) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "back" }).success).toBe(false);
  });

  test.each(["selfie", "mirror"])("accepts pose front or three-quarter on a %s shot", (shot) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "front" }).success).toBe(true);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "three-quarter" }).success).toBe(true);
  });

  test.each(["friend", "candid", "photographer"])("accepts pose profile or back on a %s shot", (shot) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "profile" }).success).toBe(true);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), shot, pose: "back" }).success).toBe(true);
  });
});
