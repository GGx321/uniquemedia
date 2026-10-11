import { describe, expect, test } from "bun:test";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { plan } from "./planner";
import { POOLS, type Activity } from "./pools";
import { redrawSlot } from "./redraw";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b): a flirty «Другая сцена» takes a flirty moment when its place has one.

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const draw = (slot: PlanSlot, k: number): PlanSlot => redrawSlot({ seed: 99, k, slot, pool: POOLS[slot.category as Category], avoid: NO_AVOID });
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const slotsOf = (category: Category, level: "flirty" | "ordinary"): PlanSlot[] => [3, 4, 5].flatMap((seed) => plan({ seed, count: 24, categories: [category], level }).slots);

describe("a flirty redraw prefers a flirty moment", () => {
  test("a flirty «Дом» prone scene redrawn from a non-flirty moment lands on the flirty prone moment when it is the only unused tie", () => {
    const prone = slotsOf("home", "flirty").filter((s) => s.level === "flirty" && captureOf(s) === "prone" && momentOf(s)?.level !== "flirty");
    expect(prone.length).toBeGreaterThan(5);
    const landed = prone.filter((slot) => [1, 2, 3, 4, 5, 6].some((k) => momentOf(draw(slot, k))?.level === "flirty"));
    expect(landed.length / prone.length).toBeGreaterThan(0.9);
  });
});
