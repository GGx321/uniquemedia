import { describe, expect, test } from "bun:test";
import { POOLS, type Activity } from "./pools";
import { plan, planWithPools } from "./planner";
import { makeRng, shuffle, subSeed } from "./rngUtil";
import type { PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS, type Category } from "./types";
import { captureOfShot, faceVisibleOf, type Capture } from "../../shared/scenes/captures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

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
  for (const category of ORDINARY_BUILT_INS) {
    test.each(EXPECTED)(`${category}: %i slots hold exactly %i flirty ones`, (n, flirty) => {
      for (const seed of SEEDS) expect(flirtyOf(plan({ seed, count: n, categories: [category], level: "flirty" }).slots)).toHaveLength(flirty);
    });
  }

  test("each category of a mixed run holds its own exact count, from its own slot count", () => {
    const slots = plan({ seed: 11, count: 23, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots;
    for (const category of ORDINARY_BUILT_INS) {
      const own = slots.filter((s) => s.category === category);
      expect(flirtyOf(own)).toHaveLength(Math.round(own.length * 0.6));
    }
  });

  test("a zero-slot category holds none and plans without a throw", () => {
    const slots = plan({ seed: 5, count: 3, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots;
    expect(slots).toHaveLength(3);
    for (const category of ORDINARY_BUILT_INS) {
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

// S5.7R carry-over (MEDIUM): the flirty slots were drawn over all of a category's frames, so 36 % of «Дом»'s landed on frames whose face is hidden (the phone over it) and got no flirty
// gaze, cue or moment, while the card said «12 из 20 кадров — кокетливые». Now the flirty slots are drawn from the frames that show her face first, and from the hidden ones only
// when there are not enough: the count stays exact (I5.28), the choice stays on `level:${category}`, and a flirty slot never turns its back to the camera.
describe("«Кокетливая»: the flirty slots go to the frames that show her face first", () => {
  /** A frame the capture lets her face show on (ignoring a moment's back angle: a flirty slot takes none). */
  const showsByCapture = (slot: PlanSlot): boolean => faceVisibleOf({ capture: captureOf(slot), pose: "front", ...(slot.framing === undefined ? {} : { framing: slot.framing }) }) === "yes";
  const hiddenNow = (slot: PlanSlot): boolean => faceVisibleOf(slot) !== "yes";

  for (const category of ORDINARY_BUILT_INS) {
    test.each([4, 6, 12, 13, 20, 30, 50])(`${category}, %i slots: flirty slots on hidden frames are exactly what the frames that show her face cannot take`, (n) => {
      for (const seed of SEEDS) {
        const slots = plan({ seed, count: n, categories: [category], level: "flirty" }).slots;
        const flirty = flirtyOf(slots);
        const showing = slots.filter(showsByCapture).length;
        expect(flirty.filter(hiddenNow)).toHaveLength(Math.max(0, flirty.length - showing));
      }
    });
  }

  test("«Дом»: 12 slots hold 8 frames that show her face and 7 flirty slots, so none is on a hidden frame", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 12, categories: ["home"], level: "flirty" }).slots;
      expect(flirtyOf(slots)).toHaveLength(7);
      expect(flirtyOf(slots).filter(hiddenNow)).toHaveLength(0);
    }
  });

  test("a flirty slot where her face shows never turns its back to the camera", () => {
    for (const seed of SEEDS) {
      for (const slot of flirtyOf(plan({ seed, count: 20, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots)) if (showsByCapture(slot)) expect(slot.pose).not.toBe("back");
    }
  });

  test("a plan with more flirty slots than frames that show her face fills the rest from the hidden ones, still exactly", () => {
    // «Дом» at 20 slots: 8 of every 12 show her face, so 13 of 20 or so; round(0.6 × 20) = 12 flirty. At 6 slots, the other bank decks: shown frames are fewer than the flirty count.
    let filled = 0;
    for (const seed of SEEDS) {
      for (const category of ORDINARY_BUILT_INS) {
        const slots = plan({ seed, count: 6, categories: [category], level: "flirty" }).slots;
        expect(flirtyOf(slots)).toHaveLength(4);
        if (flirtyOf(slots).some(hiddenNow)) filled++;
      }
    }
    expect(filled).toBeGreaterThan(0);
  });

  test("an ordinary plan is untouched by it: it holds no flirty slot and draws what it always drew", () => {
    for (const seed of SEEDS.slice(0, 20)) expect(flirtyOf(plan({ seed, count: 20, categories: [...ORDINARY_BUILT_INS] }).slots)).toHaveLength(0);
  });
});

describe("«Обычная»: nothing is flirty and nothing is written (I5.27)", () => {
  test.each([undefined, "ordinary" as const])("level %p: no slot carries a level", (level) => {
    for (const seed of SEEDS.slice(0, 20)) {
      const slots = plan({ seed, count: 20, categories: [...ORDINARY_BUILT_INS], ...(level === undefined ? {} : { level }) }).slots;
      for (const slot of slots) expect("level" in slot).toBe(false);
    }
  });

  test("an ordinary slot never takes a flirty moment", () => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 24, categories: [...ORDINARY_BUILT_INS] }).slots) expect(momentOf(slot)?.level).toBeUndefined();
    }
  });

  test("a flirty plan's ordinary slots never take a flirty moment either", () => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 24, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots) if (slot.level !== "flirty") expect(momentOf(slot)?.level).toBeUndefined();
    }
  });
});

describe("the level changes the moments, not the rest of the plan", () => {
  test("the captures are the same with and without «Кокетливая» (the deck is on the category's own stream)", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const ordinary = plan({ seed, count: 18, categories: [...ORDINARY_BUILT_INS] }).slots.map(captureOf);
      const flirty = plan({ seed, count: 18, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots.map(captureOf);
      expect(flirty).toEqual(ordinary);
    }
  });

  // S5.8a: the flirty slots are chosen by the frames, so the captures are the ordinary plan's by construction, past the deck's first cycle too (a category of 70 slots deals six cycles).
  test("the deck's captures are the ordinary plan's at any size, in every category, with and without legs (a legs slot's capture comes with its moment)", () => {
    for (const seed of SEEDS.slice(0, 25)) {
      for (const category of ORDINARY_BUILT_INS) {
        for (const legsShare of [undefined, 30 as const]) {
          const base = { seed, count: 70, categories: [category], ...(legsShare === undefined ? {} : { legsShare }) };
          const ordinary = plan(base).slots;
          const flirty = plan({ ...base, level: "flirty" }).slots;
          expect(flirty.map((s) => s.framing)).toEqual(ordinary.map((s) => s.framing));
          expect(flirty.flatMap((s) => (s.framing === "legs" ? [] : [captureOf(s)]))).toEqual(ordinary.flatMap((s) => (s.framing === "legs" ? [] : [captureOf(s)])));
        }
      }
    }
  });

  // Since the legs slots balance among themselves (S5.8a review) the level cannot move them: a legs slot is the same scene in an ordinary and in a flirty plan.
  test("the legs slots are the same scenes in an ordinary and a flirty plan: place, moment, capture, outfit and legwear", () => {
    for (const seed of SEEDS) {
      for (const category of ORDINARY_BUILT_INS) {
        const base = { seed, count: 40, categories: [category], legsShare: 30 as const };
        const legs = (level?: "flirty") => plan({ ...base, ...(level === undefined ? {} : { level }) }).slots.filter((s) => s.framing === "legs").map(({ level: _level, ...rest }) => rest);
        expect(legs("flirty")).toEqual(legs());
      }
    }
  });

  test("a category's flirty choice does not depend on which other categories are in the plan", () => {
    const alone = flirtyOf(plan({ seed: 77, count: 12, categories: ["home"], level: "flirty" }).slots).map((s) => s.slotIndex);
    const withOthers = plan({ seed: 77, count: 60, categories: [...ORDINARY_BUILT_INS], level: "flirty" }).slots.filter((s) => s.category === "home");
    const offset = withOthers[0]?.slotIndex ?? 1;
    expect(flirtyOf(withOthers).map((s) => s.slotIndex - offset + 1)).toEqual(alone);
  });

  // S5.8a: the order is the stream's own shuffle, taken in two groups: the frames that show her face, then the hidden ones (only what the first group cannot fill).
  test("the choice is drawn on the stream `level:${category}`: its shuffle, the frames that show her face first", () => {
    const n = 10;
    for (const seed of [41, 42, 43, 44, 45, 46, 47, 48]) {
      const slots = plan({ seed, count: n, categories: ["glamour"], level: "flirty" }).slots;
      const shows = (i: number): boolean => faceVisibleOf({ capture: captureOf(slots[i] as PlanSlot), pose: "front" }) === "yes";
      const order = shuffle(makeRng(subSeed(seed, "level:glamour")), Array.from({ length: n }, (_, i) => i));
      const chosen = new Set([...order.filter(shows), ...order.filter((i) => !shows(i))].slice(0, 6));
      expect(new Set(slots.flatMap((s, i) => (s.level === "flirty" ? [i] : [])))).toEqual(chosen);
    }
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
