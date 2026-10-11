import { describe, expect, test } from "bun:test";
import { POOLS, type Activity } from "./pools";
import { plan, planWithPools } from "./planner";
import { makeRng, shuffle, subSeed } from "./rngUtil";
import type { PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2b (S5.7b, plan s5a2 §6.2, I5.28): «Подача» in the planner. Under «Кокетливая» exactly round(0.6 × n) of a built-in category's n slots are flirty (the
// choice of WHICH is drawn on `level:${category}`), under «Обычная» none is, and a custom category stays ordinary. A flirty slot prefers flirty moments.

const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const momentOf = (slot: PlanSlot): Activity | undefined => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const flirtyOf = (slots: readonly PlanSlot[]): PlanSlot[] => slots.filter((s) => s.level === "flirty");
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);

/** 0.6 × n has no half-way case (6n/10 is never x.5), so every rounding rule agrees: this table pins the rule on its edges. */
const EXPECTED: readonly (readonly [number, number])[] = [
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 2],
  [5, 3],
  [6, 4],
  [7, 4],
  [8, 5],
  [9, 5],
  [10, 6],
  [12, 7],
  [13, 8],
  [20, 12],
  [25, 15],
  [50, 30],
  [100, 60],
];

describe("«Кокетливая»: the flirty count is exact (I5.28)", () => {
  for (const category of CATEGORIES) {
    test.each(EXPECTED)(`${category}: %i slots hold exactly %i flirty ones`, (n, flirty) => {
      for (const seed of SEEDS) expect(flirtyOf(plan({ seed, count: n, categories: [category], level: "flirty" }).slots)).toHaveLength(flirty);
    });
  }

  test("each category of a mixed run holds its own exact count, from its own slot count", () => {
    const slots = plan({ seed: 11, count: 23, categories: [...CATEGORIES], level: "flirty" }).slots;
    for (const category of CATEGORIES) {
      const own = slots.filter((s) => s.category === category);
      expect(flirtyOf(own)).toHaveLength(Math.round(own.length * 0.6));
    }
  });

  test("a zero-slot category holds none and plans without a throw", () => {
    const slots = plan({ seed: 5, count: 3, categories: [...CATEGORIES], level: "flirty" }).slots;
    expect(slots).toHaveLength(3);
    for (const category of CATEGORIES) {
      const own = slots.filter((s) => s.category === category);
      expect(flirtyOf(own)).toHaveLength(Math.round(own.length * 0.6));
    }
  });

  test("the flirty ones are spread over the plan: they are not simply the first or the last slots", () => {
    const firsts = new Set<number>();
    for (const seed of SEEDS) firsts.add(plan({ seed, count: 10, categories: ["travel"], level: "flirty" }).slots.findIndex((s) => s.level === "flirty"));
    expect(firsts.size).toBeGreaterThan(2);
  });
});

describe("«Обычная»: nothing is flirty and nothing is written (I5.27)", () => {
  test.each([undefined, "ordinary" as const])("level %p: no slot carries a level", (level) => {
    for (const seed of SEEDS.slice(0, 20)) {
      const slots = plan({ seed, count: 20, categories: [...CATEGORIES], ...(level === undefined ? {} : { level }) }).slots;
      for (const slot of slots) expect("level" in slot).toBe(false);
    }
  });

  test("an ordinary slot never takes a flirty moment", () => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 24, categories: [...CATEGORIES] }).slots) expect(momentOf(slot)?.level).toBeUndefined();
    }
  });

  test("a flirty plan's ordinary slots never take a flirty moment either", () => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 24, categories: [...CATEGORIES], level: "flirty" }).slots) if (slot.level !== "flirty") expect(momentOf(slot)?.level).toBeUndefined();
    }
  });
});

describe("the level changes the moments, not the rest of the plan", () => {
  test("the captures are the same with and without «Кокетливая» (the deck is on the category's own stream)", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const ordinary = plan({ seed, count: 18, categories: [...CATEGORIES] }).slots.map(captureOf);
      const flirty = plan({ seed, count: 18, categories: [...CATEGORIES], level: "flirty" }).slots.map(captureOf);
      expect(flirty).toEqual(ordinary);
    }
  });

  test("a category's flirty choice does not depend on which other categories are in the plan", () => {
    const alone = flirtyOf(plan({ seed: 77, count: 12, categories: ["home"], level: "flirty" }).slots).map((s) => s.slotIndex);
    const withOthers = plan({ seed: 77, count: 60, categories: [...CATEGORIES], level: "flirty" }).slots.filter((s) => s.category === "home");
    const offset = withOthers[0]?.slotIndex ?? 1;
    expect(flirtyOf(withOthers).map((s) => s.slotIndex - offset + 1)).toEqual(alone);
  });

  test("the choice is drawn on the stream `level:${category}`", () => {
    const n = 10;
    const order = shuffle(makeRng(subSeed(41, "level:glamour")), Array.from({ length: n }, (_, i) => i));
    const chosen = new Set(order.slice(0, 6));
    const slots = plan({ seed: 41, count: n, categories: ["glamour"], level: "flirty" }).slots;
    expect(new Set(slots.flatMap((s, i) => (s.level === "flirty" ? [i] : [])))).toEqual(chosen);
  });
});

describe("a custom category stays ordinary", () => {
  const custom = "cat-paris-cafes";
  const pool = {
    locations: [{ name: "a corner cafe", times: ["morning" as const], activities: [{ text: "stirring her coffee", twoHanded: false }] }],
    outfits: ["a linen dress"],
    shotDeck: ["friend" as const, "candid" as const],
  };

  test("no slot of a custom category is flirty, whatever the level", () => {
    const slots = planWithPools({ seed: 9, count: 10, categories: [custom], level: "flirty" }, { ...POOLS, [custom]: pool }).slots;
    expect(slots.some((s) => s.level !== undefined)).toBe(false);
  });

  test("beside built-ins, only the built-ins hold flirty slots", () => {
    const slots = planWithPools({ seed: 9, count: 20, categories: ["home", custom], level: "flirty" }, { ...POOLS, [custom]: pool }).slots;
    expect(flirtyOf(slots.filter((s) => s.category === custom))).toHaveLength(0);
    expect(flirtyOf(slots.filter((s) => s.category === "home"))).toHaveLength(6);
  });
});
