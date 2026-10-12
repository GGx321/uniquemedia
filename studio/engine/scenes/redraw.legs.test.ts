import { describe, expect, test } from "bun:test";
import { captureOfShot, faceVisibleOf, LEGS_CAPTURES, shotOf, type Capture } from "../../shared/scenes/captures";
import { legwearFits } from "../../shared/scenes/template";
import { BANKS } from "../../shared/scenes/banks";
import { plan } from "./planner";
import { POOLS, type Activity, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2c (S5.8a): «Другая сцена» on a legs scene gives another legs scene of the same category: it keeps its framing, its id and its attempt id base, draws a legs moment
// of a place that has one (the planner's rule), and its capture comes with the moment. A scene that is not a legs scene never redraws into one.

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const draw = (slot: PlanSlot, k: number, pool: Pool): PlanSlot => redrawSlot({ seed: 99, k, slot, pool, avoid: NO_AVOID });
const legsSlotsOf = (category: Category): PlanSlot[] => plan({ seed: 5, count: 36, categories: [category], legsShare: 30 }).slots.filter((s) => s.framing === "legs");
const momentOf = (category: Category, slot: PlanSlot): Activity | undefined => POOLS[category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);

describe.each([...CATEGORIES])("redrawing a %s legs scene", (category) => {
  const pool = POOLS[category];

  test("the plan holds legs scenes of the category to redraw", () => {
    expect(legsSlotsOf(category).length).toBeGreaterThan(3);
  });

  test("keeps the framing, the id, the category and the attempt id base, and stays a valid slot", () => {
    for (const slot of legsSlotsOf(category)) {
      for (let k = 1; k <= 3; k++) {
        const out = draw(slot, k, pool);
        expect([out.framing, out.slotIndex, out.category, out.attemptIdBase]).toEqual(["legs", slot.slotIndex, slot.category, slot.attemptIdBase]);
        expect(PlanSlotSchema.safeParse(out).success).toBe(true);
      }
    }
  });

  test("draws a legs moment of a place that has one, with a capture the moment lists", () => {
    for (const slot of legsSlotsOf(category)) {
      for (let k = 1; k <= 6; k++) {
        const out = draw(slot, k, pool);
        const moment = momentOf(category, out);
        expect(moment?.legs, `${out.location} / ${out.activity}`).toEqual({ framing: "legs" });
        expect(moment?.captures, `${out.location} / ${out.activity}`).toContain(captureOf(out));
        expect(out.shot).toBe(shotOf(captureOf(out)));
        if (shotOf(captureOf(out)) === "mirror") expect(pool.locations.find((l) => l.name === out.location)?.mirror).toBe(true);
      }
    }
  });

  test("its face is hidden or may be out of frame, and it wears an outfit that shows her legs", () => {
    for (const slot of legsSlotsOf(category)) {
      for (let k = 1; k <= 4; k++) {
        const out = draw(slot, k, pool);
        expect(["no", "maybe"]).toContain(faceVisibleOf({ capture: captureOf(out), pose: out.pose, framing: "legs" }));
        expect(BANKS[category].outfits.find((o) => o.text === out.outfit)?.showsLegs).toBe(true);
        const moment = momentOf(category, out);
        const outfit = BANKS[category].outfits.find((o) => o.text === out.outfit);
        if (out.legwear !== undefined && moment !== undefined && outfit !== undefined) expect(legwearFits(moment, outfit)).toBe(true);
      }
    }
  });

  test("draws another legs moment when the category has one, and the same one when it has no other", () => {
    const moments = pool.locations.flatMap((l) => l.activities.filter((a) => a.legs !== undefined).map((a) => `${l.name} | ${a.text}`));
    for (const slot of legsSlotsOf(category)) {
      const own = `${slot.location} | ${slot.activity}`;
      const drawn = new Set(Array.from({ length: 12 }, (_, i) => draw(slot, i + 1, pool)).map((out) => `${out.location} | ${out.activity}`));
      if (moments.length > 1) expect([...drawn].some((moment) => moment !== own), own).toBe(true);
      else expect([...drawn]).toEqual([own]);
    }
  });

  test("at home she shoots herself and the taxi is a selfie: the redraw never turns either into a friend's photo", () => {
    for (const slot of legsSlotsOf(category)) {
      for (let k = 1; k <= 6; k++) {
        const out = draw(slot, k, pool);
        if (category === "home") expect(captureOf(out)).not.toBe("low-feet");
        if (out.location === "the back seat of a taxi") expect(captureOf(out)).toBe("pov-legs");
      }
    }
  });

  test("is a pure function of the seed, the write and the scene", () => {
    for (const slot of legsSlotsOf(category).slice(0, 5)) expect(draw(slot, 2, pool)).toEqual(draw(slot, 2, pool));
  });
});

describe("a scene that is not a legs scene never redraws into one", () => {
  test.each([...CATEGORIES])("%s", (category) => {
    const slots = plan({ seed: 5, count: 36, categories: [category], legsShare: 30 }).slots.filter((s) => s.framing === undefined);
    expect(slots.length).toBeGreaterThan(10);
    for (const slot of slots) {
      for (let k = 1; k <= 4; k++) {
        const out = draw(slot, k, POOLS[category]);
        expect("framing" in out).toBe(false);
        expect(LEGS_CAPTURES.includes(captureOf(out))).toBe(false);
      }
    }
  });
});
