import { describe, expect, test } from "bun:test";
import { OwnPlanSlotSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA9, plan s5a4 I5.80 (D), §8 BA9): an own scene of a «Смелая» set is drawn on the Seedream route like every other «Смелая» frame, so its run slot may carry the
// route. The field is optional and additive: an own slot stored before it has none and parses exactly as it did.

const SENTENCE = "She sits on the edge of her bed in a black lace bra and panties, one hand in her hair.";

function own(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "own", slotIndex: 1, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-1", sentence: SENTENCE, ...overrides };
}

describe("the route on an own slot (S5.BA9)", () => {
  test("an own slot with the Seedream route parses and keeps it", () => {
    expect(OwnPlanSlotSchema.parse(own({ route: "seedream" })).route).toBe("seedream");
  });

  test("an own slot stored before the field parses as it did and gains no route", () => {
    const parsed = OwnPlanSlotSchema.parse(own());
    expect(parsed).toEqual(own() as typeof parsed);
    expect("route" in parsed).toBe(false);
  });

  test("a route other than seedream is refused", () => {
    expect(OwnPlanSlotSchema.safeParse(own({ route: "grok" })).success).toBe(false);
  });

  test("the slot stays strict: a place field is still refused with the route", () => {
    expect(OwnPlanSlotSchema.safeParse(own({ route: "seedream", location: "her bedroom" })).success).toBe(false);
  });

  test("a selfie that does not face the camera is still refused with the route", () => {
    expect(OwnPlanSlotSchema.safeParse(own({ route: "seedream", shot: "selfie", pose: "back" })).success).toBe(false);
  });
});
