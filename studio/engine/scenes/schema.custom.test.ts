import { describe, expect, test } from "bun:test";
import { POOL_TEXT_MAX, TIME_OF_DAY_MAX } from "../../shared/engine";
import { PlanSlotSchema } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: a plan.json is read back on every resume, so a hand-edited custom slot must not be able to blow the writer's
// reserve: its texts are held to the bounds a custom pool is held to (printable ASCII, no quote or backslash, at most
// POOL_TEXT_MAX, a time of day at most TIME_OF_DAY_MAX). A built-in slot is not held to them: the built-in pools are
// validated at import and their plans must keep parsing.

const CUSTOM = "cat-paris-cafes";

function slot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "a corner cafe in Paris",
    timeOfDay: "golden hour",
    activity: "reading a menu",
    outfit: "a beige trench coat and jeans",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

describe("a custom slot's texts", () => {
  test("a slot within the bounds parses", () => {
    expect(PlanSlotSchema.safeParse(slot()).success).toBe(true);
  });

  test.each(["location", "activity", "outfit"])("%s of exactly POOL_TEXT_MAX chars parses, one more is refused", (field) => {
    expect(PlanSlotSchema.safeParse(slot({ [field]: "x".repeat(POOL_TEXT_MAX) })).success).toBe(true);
    expect(PlanSlotSchema.safeParse(slot({ [field]: "x".repeat(POOL_TEXT_MAX + 1) })).success).toBe(false);
  });

  test("timeOfDay of exactly TIME_OF_DAY_MAX chars parses, one more is refused", () => {
    expect(PlanSlotSchema.safeParse(slot({ timeOfDay: "x".repeat(TIME_OF_DAY_MAX) })).success).toBe(true);
    expect(PlanSlotSchema.safeParse(slot({ timeOfDay: "x".repeat(TIME_OF_DAY_MAX + 1) })).success).toBe(false);
  });

  test.each(["location", "activity", "outfit", "timeOfDay"])("a quote or a backslash in %s is refused: the slots go out as escaped JSON", (field) => {
    expect(PlanSlotSchema.safeParse(slot({ [field]: 'a "quoted" place' })).success).toBe(false);
    expect(PlanSlotSchema.safeParse(slot({ [field]: "a back\\slash" })).success).toBe(false);
  });

  test.each(["location", "activity", "outfit", "timeOfDay"])("a non-ASCII char, a control char or an edge space in %s is refused", (field) => {
    for (const bad of ["кафе", "café", "two\nlines", "tab\there", " leading", "trailing ", "‮flip"]) {
      expect(PlanSlotSchema.safeParse(slot({ [field]: bad })).success).toBe(false);
    }
  });

  test("an apostrophe and a comma are fine: they cost one byte and need no escape", () => {
    expect(PlanSlotSchema.safeParse(slot({ location: "a baker's counter, Paris" })).success).toBe(true);
  });
});

describe("a built-in slot's texts are not held to the custom bounds", () => {
  test("a long built-in text still parses, as every plan written before custom categories does", () => {
    expect(PlanSlotSchema.safeParse(slot({ category: "home", location: "x".repeat(POOL_TEXT_MAX + 30), timeOfDay: "a long time of day" })).success).toBe(true);
  });
});
