import { describe, expect, test } from "bun:test";
import { PlanSlotSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, I5.27): a plan slot gains two optional fields, `capture` (who took the photo) and `legwear` (its own outfit slot). A slot stored before
// them has neither and parses to the same document; the stored `shot` keeps its five values, and a capture must ride on the shot it is stored with.

function baseSlot(): Record<string, unknown> {
  return { slotIndex: 1, category: "home", location: "her bed", timeOfDay: "evening", activity: "sits cross-legged", outfit: "silk pajamas", shot: "friend", pose: "front", attemptIdBase: "slot-1", repeatedPair: false };
}

describe("a plan slot's capture and legwear (additive, I5.27)", () => {
  test("a slot stored before captures parses to the very same document", () => {
    const raw = baseSlot();
    expect<unknown>(PlanSlotSchema.parse(raw)).toEqual(raw);
  });

  test("a timer capture rides on the friend shot", () => {
    expect(PlanSlotSchema.parse({ ...baseSlot(), capture: "timer" }).capture).toBe("timer");
  });

  test.each([
    ["mirror-hidden", "mirror"],
    ["above", "selfie"],
    ["prone", "selfie"],
    ["over-shoulder", "selfie"],
  ])("the %s capture rides on the %s shot", (capture, shot) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), capture, shot }).success).toBe(true);
  });

  test("a capture that disagrees with the stored shot is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), capture: "prone", shot: "friend" }).success).toBe(false);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), capture: "timer", shot: "selfie" }).success).toBe(false);
  });

  test("an unknown capture is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), capture: "drone" }).success).toBe(false);
  });

  test("a legwear item is kept as written", () => {
    expect(PlanSlotSchema.parse({ ...baseSlot(), legwear: "white knee-high socks" }).legwear).toBe("white knee-high socks");
  });

  test("an empty legwear item is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), legwear: "" }).success).toBe(false);
  });

  test("a legwear item past the pool text bound is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), legwear: "x".repeat(36) }).success).toBe(false);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), legwear: "x".repeat(35) }).success).toBe(true);
  });

  // S5.7a: «Подача» rides on the slot as an optional `level`; the planner does not set it yet (S5.7b draws the mix).
  test("a slot's level is kept as written, flirty or ordinary", () => {
    expect(PlanSlotSchema.parse({ ...baseSlot(), level: "flirty" }).level).toBe("flirty");
    expect(PlanSlotSchema.parse({ ...baseSlot(), level: "ordinary" }).level).toBe("ordinary");
  });

  // 5a.3 (S5.9c, plan s5a3 «Changes in r3»: widen `PlanSlot.level` to include bold): the bold draw gives a «Смелая» category's slots the bold level, and only those.
  test.each(["nightwear", "beach"])("a bold slot of «%s» is kept as written", (category) => {
    expect(PlanSlotSchema.parse({ ...baseSlot(), category, level: "bold" }).level).toBe("bold");
  });

  test.each(["home", "travel", "photoshoot", "glamour", "fitness", "cat-paris-cafes"])("a slot level of bold on «%s» is refused: the five draw «Смелая» as «Кокетливая»", (category) => {
    const result = PlanSlotSchema.safeParse({ ...baseSlot(), category, level: "bold" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("level");
  });

  test("a slot level other than ordinary, flirty or bold is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), category: "nightwear", level: "daring" }).success).toBe(false);
  });

  // 5a.3 (S5.9a): the route rides on the slot as an optional `route`. S5.9b2 (plan s5a3 §11): only on a «Смелая» category's slot, the one kind the bold route draws.
  test("a «Смелая» slot's Seedream route is kept as written, and a slot without one gains none", () => {
    expect(PlanSlotSchema.parse({ ...baseSlot(), category: "nightwear", route: "seedream" }).route).toBe("seedream");
    expect(PlanSlotSchema.parse({ ...baseSlot(), category: "beach", location: "the beach", route: "seedream" }).route).toBe("seedream");
    expect("route" in PlanSlotSchema.parse(baseSlot())).toBe(false);
  });

  test("a «Смелая» slot without a route parses: its ordinary frames stay on the owner's model", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), category: "nightwear" }).success).toBe(true);
  });

  // 5a.4 (S5.BA1, I5.73): «Смелая» is every category's, so the route is any category's; the rows for the five and a custom category are in schema.boldAny.test.ts.

  test("a route other than seedream is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), route: "grok" }).success).toBe(false);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), route: "" }).success).toBe(false);
  });

  test("a hand capture still faces the phone: over-shoulder with a back pose is refused", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), capture: "over-shoulder", shot: "selfie", pose: "back" }).success).toBe(false);
  });
});
