import { describe, expect, test } from "bun:test";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { plan } from "./planner";
import { POOLS, type Activity } from "./pools";
import { redrawSlot } from "./redraw";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b): «Другая сцена» keeps the scene's «Подача». A flirty scene redraws flirty (and among equals on a flirty moment); an ordinary one never takes a
// flirty moment.

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const draw = (slot: PlanSlot, k: number): PlanSlot => redrawSlot({ seed: 99, k, slot, pool: POOLS[slot.category as Category], avoid: NO_AVOID });
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const slotsOf = (category: Category, level: "flirty" | "ordinary"): PlanSlot[] => [3, 4, 5].flatMap((seed) => plan({ seed, count: 24, categories: [category], level }).slots);

describe.each([...CATEGORIES])("redrawing a %s scene keeps its level", (category) => {
  test("a flirty scene redraws flirty, every time", () => {
    const flirty = slotsOf(category, "flirty").filter((s) => s.level === "flirty");
    expect(flirty.length).toBeGreaterThan(30);
    for (const slot of flirty) for (let k = 1; k <= 3; k++) expect(draw(slot, k).level).toBe("flirty");
  });

  test("an ordinary scene redraws with no level, and never on a flirty moment", () => {
    for (const slot of slotsOf(category, "ordinary")) {
      for (let k = 1; k <= 3; k++) {
        const out = draw(slot, k);
        expect("level" in out).toBe(false);
        expect(momentOf(out)?.level).toBeUndefined();
      }
    }
  });

  test("an ordinary scene of a flirty plan redraws ordinary", () => {
    const ordinary = slotsOf(category, "flirty").filter((s) => s.level !== "flirty");
    expect(ordinary.length).toBeGreaterThan(20);
    for (const slot of ordinary) expect("level" in draw(slot, 1)).toBe(false);
  });
});
