import { describe, expect, test } from "bun:test";
import { PlanSlotSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2c (S5.8a, I5.27): a plan slot gains one optional field, `framing: "legs"` («Ножки»). A slot stored before it has none and parses to the same document; the
// field is never written as a value that says nothing, and it rides beside a capture the legs banks deal (`pov-legs`, `low-feet`, or a mirror frame).

function baseSlot(): Record<string, unknown> {
  return { slotIndex: 1, category: "home", location: "her bed", timeOfDay: "evening", activity: "sits cross-legged", outfit: "silk pajamas", shot: "selfie", pose: "front", attemptIdBase: "slot-1", repeatedPair: false };
}

describe("a plan slot's framing (additive, I5.27)", () => {
  test("a slot stored before it parses to the very same document", () => {
    const raw = baseSlot();
    expect<unknown>(PlanSlotSchema.parse(raw)).toEqual(raw);
  });

  test("a legs slot keeps its framing and its capture", () => {
    const parsed = PlanSlotSchema.parse({ ...baseSlot(), framing: "legs", capture: "pov-legs" });
    expect(parsed.framing).toBe("legs");
    expect(parsed.capture).toBe("pov-legs");
  });

  test("a pov-legs capture rides on the selfie shot, and a low-feet capture on the friend shot", () => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), framing: "legs", capture: "pov-legs", shot: "selfie" }).success).toBe(true);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), framing: "legs", capture: "low-feet", shot: "friend" }).success).toBe(true);
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), framing: "legs", capture: "low-feet", shot: "selfie" }).success).toBe(false);
  });

  test.each(["face", "ordinary", "", 1, true])("a framing of %p is refused: legs is the only one", (framing) => {
    expect(PlanSlotSchema.safeParse({ ...baseSlot(), framing }).success).toBe(false);
  });
});
