import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import { captureOfShot, faceVisibleOf, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { apportionLegs, flirtyCountOf, legsCountOf } from "../../shared/scenes/level";
import { legwearFits } from "../../shared/scenes/template";
import { plan, planWithPools } from "./planner";
import { POOLS, type Activity } from "./pools";
import { makeRng, shuffle, subSeed } from "./rngUtil";
import { ScenePlanSchema, type PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
// 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): scoped to the five ordinary built-ins (ORDINARY_BUILT_INS), every assertion kept. The «Смелая» banks run their own sweeps.

// 5a.2c (S5.8a, plan s5a2 §7.2, I5.29): «Ножки» in the planner. A run's legs slots are min(round-half-up(share × B), ⌊0.3 × count⌋); they are shared over the built-in
// categories in proportion to their slots; which slots of a category is drawn on `legs:${category}`; a legs slot draws a legs moment of its place, or redraws among the
// places that have one. `legsShare` 0 (or none) changes nothing: a plan without legs is the plan it always was.

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 3);
const SHARES = [15, 30] as const;

const isLegs = (slot: PlanSlot): boolean => slot.framing === "legs";
const legsOf = (slots: readonly PlanSlot[]): PlanSlot[] => slots.filter(isLegs);
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);
const poolOf = (slot: PlanSlot) => POOLS[slot.category as Category].locations.find((l) => l.name === slot.location);
const momentOf = (slot: PlanSlot): Activity | undefined => poolOf(slot)?.activities.find((a) => a.text === slot.activity);

describe("«Ножки»: none asked, nothing changes", () => {
  test("legsShare 0 is byte-identical to no legsShare, for every category set, level and size", () => {
    for (const seed of SEEDS) {
      for (const categories of [[...ORDINARY_BUILT_INS], ["home"], ["travel", "glamour"]] as const) {
        for (const count of [1, 5, 12, 20, 37]) {
          for (const level of [undefined, "flirty" as const]) {
            const base = { seed, count, categories: [...categories], ...(level === undefined ? {} : { level }) };
            expect(JSON.stringify(plan({ ...base, legsShare: 0 }))).toBe(JSON.stringify(plan(base)));
          }
        }
      }
    }
  });

  test("a plan without legs holds no legs slot, no pov-legs and no low-feet", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 30, categories: [...ORDINARY_BUILT_INS] }).slots;
      expect(legsOf(slots)).toHaveLength(0);
      expect(slots.filter((s) => LEGS_CAPTURES.includes(captureOf(s)))).toHaveLength(0);
      for (const slot of slots) expect("framing" in slot).toBe(false);
    }
  });
});

describe("«Ножки»: the allocation (I5.29)", () => {
  for (const share of SHARES) {
    test.each([1, 3, 4, 5, 6, 10, 12, 13, 20, 25, 50, 100])(`share ${share} %: %i built-in slots hold exactly min(round-half-up, ⌊0.3 × count⌋) legs slots`, (count) => {
      for (const seed of SEEDS) {
        const slots = plan({ seed, count, categories: [...ORDINARY_BUILT_INS], legsShare: share }).slots;
        expect(legsOf(slots)).toHaveLength(legsCountOf(share, count, count));
      }
    });
  }

  test("the cap holds where the rounding goes up: 5 slots at 30 % make 1 legs slot, not 2", () => {
    for (const seed of SEEDS) expect(legsOf(plan({ seed, count: 5, categories: ["home"], legsShare: 30 }).slots)).toHaveLength(1);
  });

  test("a run too small for one legs slot holds none (15 % of 3)", () => {
    for (const seed of SEEDS) expect(legsOf(plan({ seed, count: 3, categories: [...ORDINARY_BUILT_INS], legsShare: 15 }).slots)).toHaveLength(0);
  });

  const custom = "cat-paris-cafes";
  const customPool = {
    locations: [{ name: "a corner cafe", times: ["morning" as const], activities: [{ text: "stirring her coffee", twoHanded: false }] }],
    outfits: ["a linen dress"],
    shotDeck: ["friend" as const, "candid" as const],
  };

  test("beside a custom category the count is from the built-in slots (B) and the whole run's cap", () => {
    for (const seed of SEEDS) {
      const slots = planWithPools({ seed, count: 20, categories: ["home", "glamour", custom], legsShare: 30 }, { ...POOLS, [custom]: customPool }).slots;
      const built = slots.filter((s) => s.category !== custom).length;
      expect(legsOf(slots)).toHaveLength(legsCountOf(30, built, 20));
    }
  });

  test("a custom category draws no legs slot, whatever the share", () => {
    for (const seed of SEEDS) {
      const slots = planWithPools({ seed, count: 20, categories: ["home", custom], legsShare: 30 }, { ...POOLS, [custom]: customPool }).slots;
      expect(legsOf(slots.filter((s) => s.category === custom))).toHaveLength(0);
    }
  });

  test("a run of custom categories only holds no legs slot (the engine refuses the request; the planner never draws one)", () => {
    for (const seed of SEEDS) expect(legsOf(planWithPools({ seed, count: 10, categories: [custom], legsShare: 30 }, { ...POOLS, [custom]: customPool }).slots)).toHaveLength(0);
  });

  test("the legs slots are shared over the built-in categories by largest remainder: each category holds the floor or the ceiling of its quota", () => {
    for (const share of SHARES) {
      for (const seed of SEEDS) {
        const count = 40;
        const slots = plan({ seed, count, categories: [...ORDINARY_BUILT_INS], legsShare: share }).slots;
        const sizes = ORDINARY_BUILT_INS.map((c) => slots.filter((s) => s.category === c).length);
        const total = legsCountOf(share, count, count);
        ORDINARY_BUILT_INS.forEach((c, i) => {
          const quota = (total * (sizes[i] ?? 0)) / count;
          const held = legsOf(slots.filter((s) => s.category === c)).length;
          expect(held, `${c} of ${sizes.join("/")}`).toBeGreaterThanOrEqual(Math.floor(quota));
          expect(held, `${c} of ${sizes.join("/")}`).toBeLessThanOrEqual(Math.ceil(quota));
        });
        expect(apportionLegs(total, sizes).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  test("which slots of a category are legs slots is drawn on the stream `legs:${category}`", () => {
    const n = 20;
    for (const category of ORDINARY_BUILT_INS) {
      const slots = plan({ seed: 41, count: n, categories: [category], legsShare: 30 }).slots;
      const held = legsOf(slots).length;
      expect(held).toBeGreaterThan(0);
      const order = shuffle(makeRng(subSeed(41, `legs:${category}`)), Array.from({ length: n }, (_, i) => i));
      expect(new Set(slots.flatMap((s, i) => (isLegs(s) ? [i] : [])))).toEqual(new Set(order.slice(0, held)));
    }
  });

  test("the legs slots are spread over the plan: they are not simply the first or the last slots", () => {
    const firsts = new Set<number>();
    for (const seed of SEEDS) firsts.add(plan({ seed, count: 12, categories: ["home"], legsShare: 30 }).slots.findIndex(isLegs));
    expect(firsts.size).toBeGreaterThan(3);
  });

  test("the same input plans the same document, and the plan parses back unchanged (a resume reads it as it is)", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const input = { seed, count: 24, categories: [...ORDINARY_BUILT_INS], legsShare: 30 as const, level: "flirty" as const };
      const first = plan(input);
      expect(JSON.stringify(plan(input))).toBe(JSON.stringify(first));
      expect<unknown>(ScenePlanSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    }
  });
});

describe("«Ножки»: a legs slot", () => {
  const ALL_LEGS = SHARES.flatMap((share) => SEEDS.flatMap((seed) => legsOf(plan({ seed, count: 30, categories: [...ORDINARY_BUILT_INS], legsShare: share }).slots)));

  test("the sweep holds legs slots of every category", () => {
    expect([...new Set(ALL_LEGS.map((s) => s.category))].sort()).toEqual([...ORDINARY_BUILT_INS].sort());
  });

  test("draws a legs moment of its place, with a capture that moment lists", () => {
    for (const slot of ALL_LEGS) {
      const moment = momentOf(slot);
      expect(moment?.legs, `${slot.location} | ${slot.activity}`).toEqual({ framing: "legs" });
      expect(moment?.captures, `${slot.location} | ${slot.activity}`).toContain(captureOf(slot));
    }
  });

  test("the capture is written (it says more than the shot), rides on its shot, and takes a pose it can", () => {
    for (const slot of ALL_LEGS) {
      expect(slot.capture).toBeDefined();
      expect(slot.shot).toBe(shotOf(captureOf(slot)));
      expect(posesFor(captureOf(slot))).toContain(slot.pose);
    }
  });

  test("its face is hidden or may be out of frame: faceVisible is no or maybe, never yes", () => {
    for (const slot of ALL_LEGS) expect(["no", "maybe"]).toContain(faceVisibleOf({ capture: captureOf(slot), pose: slot.pose, framing: "legs" }));
  });

  test("pov-legs and low-feet appear only on legs slots", () => {
    for (const seed of SEEDS) {
      for (const slot of plan({ seed, count: 30, categories: [...ORDINARY_BUILT_INS], legsShare: 30 }).slots) {
        if (LEGS_CAPTURES.includes(captureOf(slot))) expect(isLegs(slot)).toBe(true);
        if (!isLegs(slot)) expect(momentOf(slot)?.legs).toBeUndefined();
      }
    }
  });

  test("at home she shoots herself: a «Дом» legs slot is never a friend's photo", () => {
    const home = ALL_LEGS.filter((s) => s.category === "home");
    expect(home.length).toBeGreaterThan(50);
    for (const slot of home) {
      expect(captureOf(slot), slot.activity).not.toBe("low-feet");
      expect(shotOf(captureOf(slot)), slot.activity).not.toBe("friend");
    }
  });

  test("the taxi's legs slot looks down along her own legs: pov-legs, never a crouching friend", () => {
    const taxi = ALL_LEGS.filter((s) => s.location === "the back seat of a taxi");
    expect(taxi.length).toBeGreaterThan(0);
    for (const slot of taxi) expect(captureOf(slot)).toBe("pov-legs");
  });

  test("it wears one of the outfits its moment pins (shorts, trousers, leggings, joggers, midi and long dresses), never a mini", () => {
    for (const slot of ALL_LEGS) {
      const pinned = momentOf(slot)?.outfits;
      expect(pinned, slot.activity).toBeDefined();
      expect(pinned).toContain(slot.outfit);
      expect(slot.outfit).not.toMatch(/\b(mini|bodycon)\b|as a dress/);
    }
  });

  test("legwear goes by the §5.1 rule: only where the moment allows it, only the bank's items", () => {
    let along = 0;
    let withLegwear = 0;
    for (const slot of ALL_LEGS) {
      const bank = BANKS[slot.category as Category];
      const moment = momentOf(slot);
      const outfit = bank.outfits.find((o) => o.text === slot.outfit);
      if (slot.legwear !== undefined) {
        expect(bank.legwear?.items).toContain(slot.legwear);
        expect(moment !== undefined && outfit !== undefined && legwearFits(moment, outfit), `${slot.activity} | ${slot.outfit}`).toBe(true);
      }
      if (slot.activity === "stretches her legs along the bed") {
        along++;
        if (slot.legwear !== undefined) withLegwear++;
      }
    }
    // «Дом» has seven legs moments now (S5.8a review), so this one is a seventh of its legs slots: the sample holds ~19, enough to see the tights.
    expect(along).toBeGreaterThan(10);
    expect(withLegwear).toBeGreaterThan(0);
  });

  test("«lies with her bare feet forward» and the other bare or socked moments never take legwear", () => {
    const bare = ALL_LEGS.filter((s) => /bare|socked|soles|heels/.test(s.activity));
    expect(bare.length).toBeGreaterThan(50);
    for (const slot of bare) expect(slot.legwear).toBeUndefined();
  });

  test("no legs slot lies on her stomach, off a bed or on it: prone is not a legs frame", () => {
    for (const slot of ALL_LEGS) expect(slot.activity).not.toMatch(/stomach|prone/);
  });

  test("it is ordinary unless «Кокетливая» made it a flirty slot, and a legs moment is never a flirty one", () => {
    for (const seed of SEEDS) {
      for (const slot of legsOf(plan({ seed, count: 30, categories: [...ORDINARY_BUILT_INS], legsShare: 30, level: "flirty" }).slots)) expect(momentOf(slot)?.level).toBeUndefined();
    }
  });
});

describe("«Ножки»: the other slots keep their deals", () => {
  test("«Дом»'s deck is dealt over the non-legs slots only: 12 non-legs slots of 14 hold exactly 4 phone-over-face mirror frames", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 14, categories: ["home"], legsShare: 15 }).slots;
      expect(legsOf(slots)).toHaveLength(2);
      const rest = slots.filter((s) => !isLegs(s));
      expect(rest).toHaveLength(12);
      expect(rest.filter((s) => captureOf(s) === "mirror-hidden")).toHaveLength(4);
      expect(rest.filter((s) => captureOf(s) === "prone")).toHaveLength(2);
    }
  });

  test("«Кокетливая» still holds exactly round(0.6 × n) flirty slots per category, with legs slots among them", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 40, categories: [...ORDINARY_BUILT_INS], legsShare: 30, level: "flirty" }).slots;
      for (const category of ORDINARY_BUILT_INS) {
        const own = slots.filter((s) => s.category === category);
        expect(own.filter((s) => s.level === "flirty")).toHaveLength(flirtyCountOf(own.length, "flirty"));
      }
    }
  });

  test("the away cap holds beside legs slots: at most ⌊n/5⌋ profile or back slots per category", () => {
    for (const seed of SEEDS) {
      const slots = plan({ seed, count: 40, categories: [...ORDINARY_BUILT_INS], legsShare: 30 }).slots;
      for (const category of ORDINARY_BUILT_INS) {
        const own = slots.filter((s) => s.category === category);
        expect(own.filter((s) => s.pose === "profile" || s.pose === "back").length).toBeLessThanOrEqual(Math.floor(own.length / 5));
      }
    }
  });
});
