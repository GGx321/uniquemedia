import { describe, expect, test } from "bun:test";
import { captureOfShot, isHandCapture, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { plan, planWithPools } from "./planner";
import { POOLS, type Activity, type Pool } from "./pools";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b, plan s5a2 §6.2, I5.26): the angle comes from the scene. A built-in slot's pose is its moment's `angle`, or front / three-quarter; the run's
// «Ракурсы» never change a plan; a built-in category holds at most ⌊n/5⌋ away (profile or back) slots, and an excess one redraws among non-away moments.

const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const isAway = (slot: PlanSlot): boolean => slot.pose === "profile" || slot.pose === "back";
const SEEDS = Array.from({ length: 200 }, (_, i) => i * 7919 + 5);
const COUNTS = [1, 4, 5, 6, 9, 10, 11, 14, 15, 20, 25, 30, 47];

describe("the request's poses never change a plan (I5.26)", () => {
  test.each([
    { profile: true, back: true },
    { profile: true, back: false },
    { profile: false, back: true },
    { profile: false, back: false },
  ])("poses %p plans exactly what no poses plan", (poses) => {
    for (const seed of SEEDS.slice(0, 40)) {
      const asked = { seed, count: 20, categories: [...CATEGORIES], poses };
      const bare = { seed, count: 20, categories: [...CATEGORIES] };
      expect(plan(asked)).toEqual(plan(bare));
    }
  });

  test("a flirty plan ignores poses too", () => {
    const asked = { seed: 9, count: 20, categories: [...CATEGORIES], level: "flirty" as const, poses: { profile: true, back: true } };
    expect(plan(asked)).toEqual(plan({ seed: 9, count: 20, categories: [...CATEGORIES], level: "flirty" }));
  });
});

describe("the pose is the moment's angle, or front / three-quarter", () => {
  test.each([...CATEGORIES])("%s: a moment with an angle sets the pose; any other slot is front or three-quarter", (category) => {
    let angled = 0;
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 20, categories: [category] }).slots) {
        const moment = momentOf(slot);
        if (moment?.angle !== undefined) {
          angled++;
          expect(slot.pose).toBe(moment.angle);
        } else expect(["front", "three-quarter"]).toContain(slot.pose);
      }
    }
    expect(angled).toBeGreaterThan(0);
  });

  test.each([...CATEGORIES])("%s: the moment fits the capture and the pose it sets", (category) => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 20, categories: [category], level: "flirty" }).slots) {
        const moment = momentOf(slot);
        expect(moment, `${slot.location} / ${slot.activity}`).toBeDefined();
        if (moment !== undefined) expect(momentAllowed(moment, captureOf(slot), slot.pose, slot.level ?? "ordinary")).toBe(true);
      }
    }
  });

  test("a hand-held capture never gets an away moment, and never an away pose", () => {
    for (const category of CATEGORIES) {
      for (const seed of SEEDS) {
        for (const slot of plan({ seed, count: 25, categories: [category], level: seed % 2 === 0 ? "flirty" : "ordinary" }).slots) {
          if (!isHandCapture(captureOf(slot))) continue;
          expect(isAway(slot), `${category} ${captureOf(slot)} ${slot.activity}`).toBe(false);
          expect(["profile", "back"]).not.toContain(momentOf(slot)?.angle);
        }
      }
    }
  });

  test("the captures do not depend on the level (the deck is on the category's own stream)", () => {
    const ordinary = plan({ seed: 31, count: 40, categories: [...CATEGORIES] }).slots.map(captureOf);
    const flirty = plan({ seed: 31, count: 40, categories: [...CATEGORIES], level: "flirty" }).slots.map(captureOf);
    expect(flirty).toEqual(ordinary);
  });
});

describe("a built-in category holds at most ⌊n/5⌋ away slots", () => {
  test.each([...CATEGORIES])("%s: for every count and seed", (category) => {
    for (const count of COUNTS) {
      for (const seed of SEEDS) {
        const away = plan({ seed, count, categories: [category] }).slots.filter(isAway).length;
        if (away > Math.floor(count / 5)) throw new Error(`${category} n=${count} seed ${seed}: ${away} away slots, the cap is ${Math.floor(count / 5)}`);
      }
    }
  });

  test("the cap is per category: a mixed run holds ⌊n_c/5⌋ in each", () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const slots = plan({ seed, count: 53, categories: [...CATEGORIES] }).slots;
      for (const category of CATEGORIES) {
        const own = slots.filter((s) => s.category === category);
        expect(own.filter(isAway).length).toBeLessThanOrEqual(Math.floor(own.length / 5));
      }
    }
  });

  test("a plan of fewer than 5 slots in a category holds no away slot", () => {
    for (const category of CATEGORIES) for (const seed of SEEDS) for (const count of [1, 2, 3, 4]) expect(plan({ seed, count, categories: [category] }).slots.some(isAway)).toBe(false);
  });

  // A pool whose every friend moment but one faces away: the cap, not the bank, decides how many do.
  const AWAY_HEAVY: Pool = {
    ...POOLS.travel,
    locations: POOLS.travel.locations.map((place) => ({
      ...place,
      activities: [
        ...place.activities.filter((a) => a.angle === undefined).slice(0, 1),
        { text: "turns her back to the camera", twoHanded: false, captures: ["friend", "candid", "timer"], angle: "back" as const, motion: "she looks over the rail slowly" },
        { text: "stands in profile to the water", twoHanded: false, captures: ["friend", "candid", "timer"], angle: "profile" as const, motion: "she breathes in slowly" },
      ],
    })),
  };

  test("an away-heavy bank is held to the cap, and the excess slots are non-away moments", () => {
    for (const seed of SEEDS.slice(0, 80)) {
      const slots = planWithPools({ seed, count: 30, categories: ["travel"] }, { ...POOLS, travel: AWAY_HEAVY }).slots;
      expect(slots.filter(isAway).length).toBeLessThanOrEqual(6);
      expect(slots.filter(isAway).length).toBeGreaterThan(0);
      for (const slot of slots) if (!isAway(slot)) expect(["front", "three-quarter"]).toContain(slot.pose);
    }
  });

  test("the excess redraw does not move the captures, the outfits' order or the pose stream", () => {
    const base = plan({ seed: 12, count: 30, categories: ["travel"] }).slots.map(captureOf);
    const heavy = planWithPools({ seed: 12, count: 30, categories: ["travel"] }, { ...POOLS, travel: AWAY_HEAVY }).slots.map(captureOf);
    expect(heavy).toEqual(base);
  });
});

describe("a custom category's own poses stay uncapped", () => {
  const CUSTOM = "cat-lying-down";
  const pool: Pool = {
    locations: [{ name: "a sunny bedroom", times: ["morning"], activities: [{ text: "lying on her stomach, texting", twoHanded: false }] }],
    outfits: ["home shorts and a tank top"],
    shotDeck: ["friend", "candid"],
    poses: ["back"],
  };

  test("every slot of a 20-slot plan faces away", () => {
    const slots = planWithPools({ seed: 4, count: 20, categories: [CUSTOM] }, { ...POOLS, [CUSTOM]: pool }).slots;
    expect(slots.every((s) => s.pose === "back")).toBe(true);
  });
});

// The owner's rule is a MAXIMUM (back and profile at most one frame in five). The 5 % floor is ours, and only the four outside categories keep it: «Дом» has one non-hand
// capture in twelve, the timer, which turns away one time in three, and the floor must not starve the timer's other moments (planner.reachability.test.ts).

describe("the away share of a built-in category stays under 20 % (I5.26), and over 5 % outside «Дом»", () => {
  const share = (category: Category, count: number): number => {
    let away = 0;
    let all = 0;
    for (const seed of SEEDS) {
      const slots = plan({ seed, count, categories: [category] }).slots;
      away += slots.filter(isAway).length;
      all += slots.length;
    }
    return away / all;
  };

  for (const category of CATEGORIES) {
    test.each([10, 20, 30])(`${category}: n = %i`, (count) => {
      const s = share(category, count);
      expect(s, `${category} n=${count}: ${(s * 100).toFixed(1)} %`).toBeGreaterThanOrEqual(category === "home" ? 0.01 : 0.05);
      expect(s, `${category} n=${count}: ${(s * 100).toFixed(1)} %`).toBeLessThanOrEqual(0.2);
    });
  }

  test("a flirty plan keeps the same bounds", () => {
    for (const category of CATEGORIES) {
      let away = 0;
      let all = 0;
      for (const seed of SEEDS) {
        const slots = plan({ seed, count: 20, categories: [category], level: "flirty" }).slots;
        away += slots.filter(isAway).length;
        all += slots.length;
      }
      expect(away / all, category).toBeGreaterThanOrEqual(category === "home" ? 0.01 : 0.05);
      expect(away / all, category).toBeLessThanOrEqual(0.2);
    }
  });
});
