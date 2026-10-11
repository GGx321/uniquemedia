import { describe, expect, test } from "bun:test";
import { HAIRSTYLES } from "../../shared/scenes/banks";
import { hairstyleSequence, sportyOf } from "../../shared/scenes/hair";
import { hairLinesOf } from "./hairLines";
import { plan } from "./planner";
import { POOLS } from "./pools";
import type { OwnPlanSlot, PlanSlot } from "./schema";
import type { Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, plan s5a2 §5.3, I5.24, I5.25): the run's hairstyles. `hairLinesOf` reads each planned slot's hair and outdoor tags from its moment and walks the
// slots in order through the shared `hairstyleSequence` (avoid the previous 3, tied styles ≤ ⌊n/4⌋ and only on `tied` moments, caps ≤ ⌊n/8⌋ and only outdoors).

const ALL = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
const momentOf = (slot: PlanSlot) => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const styleOf = (text: string) => HAIRSTYLES.find((h) => h.text === text);

describe("hairLinesOf", () => {
  const slots = plan({ seed: 31, count: 40, categories: [...ALL] }).slots;

  test("is the shared sequence over the slots' moment tags, keyed by slot number", () => {
    const expected = hairstyleSequence(
      slots.map((s) => ({ hair: momentOf(s)?.hair, outdoor: momentOf(s)?.outdoor === true })),
      "shoulder",
      "run-1",
    );
    const lines = hairLinesOf(slots, "shoulder", "run-1");
    for (const [i, slot] of slots.entries()) expect(lines.get(slot.slotIndex) ?? null).toBe(expected[i] ?? null);
  });

  test("a moment that names her hair gets no line; every other slot gets a style that fits the length", () => {
    const lines = hairLinesOf(slots, "bob", "run-1");
    for (const slot of slots) {
      const moment = momentOf(slot);
      const style = lines.get(slot.slotIndex);
      if (moment?.hair === "own") expect(style).toBeUndefined();
      else expect(styleOf(style ?? "")?.lengths).toContain("bob");
    }
  });

  // S5.6R (round C): «Фитнес»'s workout moments are `sport` moments, whose sporty styles (tied) are outside the tied cap; a `tied` moment keeps it.
  test("tied styles go only to tied and sport moments, a tied moment's at most a quarter of the run; caps only outdoors, at most an eighth", () => {
    for (const run of ["run-a", "run-b", "run-c", "run-d"]) {
      const lines = hairLinesOf(slots, "long", run);
      let tied = 0;
      let caps = 0;
      for (const slot of slots) {
        const style = styleOf(lines.get(slot.slotIndex) ?? "");
        if (style?.tied === true) {
          expect(["tied", "sport"]).toContain(momentOf(slot)?.hair ?? "");
          if (momentOf(slot)?.hair === "tied") tied++;
          if (momentOf(slot)?.hair === "sport") expect(style.sport).toBe(true);
        }
        if (style?.cap === true) {
          caps++;
          expect(momentOf(slot)?.outdoor).toBe(true);
        }
      }
      expect(tied).toBeLessThanOrEqual(Math.floor(slots.length / 4));
      expect(caps).toBeLessThanOrEqual(Math.floor(slots.length / 8));
    }
  });

  test("«Фитнес»'s workout moments are sport moments, and no other category has one", () => {
    const sportOf = (category: Category) => POOLS[category].locations.flatMap((l) => l.activities).filter((a) => a.hair === "sport").length;
    expect(ALL.filter((c) => sportOf(c) > 0)).toEqual(["fitness"]);
    expect(POOLS.fitness.locations.flatMap((l) => l.activities).filter((a) => a.hair !== "sport" && a.hair !== "own").map((a) => a.text)).toEqual([]);
  });

  test("a «Фитнес» run wears a sporty style on 3 in 4 of its workout moments", () => {
    const fitness = plan({ seed: 7, count: 12, categories: ["fitness"] }).slots;
    const lines = hairLinesOf(fitness, "shoulder", "run-fit");
    const workout = fitness.filter((s) => momentOf(s)?.hair === "sport");
    expect(workout.length).toBeGreaterThan(0);
    expect(workout.filter((s) => styleOf(lines.get(s.slotIndex) ?? "")?.sport === true)).toHaveLength(sportyOf(workout.length));
  });

  test("no style repeats within the previous three", () => {
    const lines = hairLinesOf(slots, "shoulder", "run-9");
    const drawn = slots.flatMap((s) => lines.get(s.slotIndex) ?? []);
    for (let i = 3; i < drawn.length; i++) expect(drawn.slice(i - 3, i)).not.toContain(drawn[i]);
  });

  test("the colour is never in the style (I5.25)", () => {
    for (const style of HAIRSTYLES) expect(style.text).not.toMatch(/\b(blonde?|brunette|red|black|brown|grey|gray|dyed)\b/i);
  });

  test("is a pure function of the run id: the same run, the same styles; another run, others", () => {
    expect([...hairLinesOf(slots, "shoulder", "run-1")]).toEqual([...hairLinesOf(slots, "shoulder", "run-1")]);
    expect([...hairLinesOf(slots, "shoulder", "run-1")]).not.toEqual([...hairLinesOf(slots, "shoulder", "run-2")]);
  });

  test("an own scene and a custom category's slot have no moment tags and take a style", () => {
    const own: OwnPlanSlot = { kind: "own", slotIndex: 41, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-41", sentence: "She waits." };
    const custom: PlanSlot = { ...(slots[0] as PlanSlot), slotIndex: 42, category: "cat-paris-cafes", location: "a bakery", activity: "choosing bread" };
    const lines = hairLinesOf([...slots, own, custom], "shoulder", "run-1");
    expect(lines.get(41)).toBeDefined();
    expect(lines.get(42)).toBeDefined();
  });

  test("no slots, no lines", () => {
    expect(hairLinesOf([], "bob", "run-1").size).toBe(0);
  });
});
