import { describe, expect, test } from "bun:test";
import { splitCount, type CategoryRef } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS, impliedItemsOf } from "../../shared/scenes/banks/companions";
import { BANKS } from "../../shared/scenes/banks";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { legsCountOf, levelCountsOf, tierSpreadOf, type LevelCounts } from "../../shared/scenes/level";
import { plainSentence } from "../../shared/scenes/plain";
import { coverageOf, templateSentence } from "../../shared/scenes/template";
import { plan, planForAvatar, planWithPools, type PlanInput } from "./planner";
import { POOLS, type Pool } from "./pools";
import { makeRng, shuffle, subSeed } from "./rngUtil";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS, type PlannerCategory } from "./types";
import { countTo, PUSH_SIZES, sweepTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 I5.71-I5.74, §5.1, §5.3, §8 BA3): at «Подача: Смелая» EVERY category draws «Смелая». The five come from their companion banks, a custom category from the two
// shared custom banks with a world of its own, and the request's tiers are counted over the whole request and spread over its categories.

const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i * 7919);
const CUSTOM = "cat-paris-trip";
const OTHER = "cat-night-market";

/** A custom pool with two water places out of five (the world a custom «Смелая» slot is set in). */
const PARIS: Pool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning"], activities: [{ text: "reading a menu", twoHanded: false }] },
    { name: "a hotel pool in Nice", times: ["midday"], activities: [{ text: "floating on her back", twoHanded: false }] },
    { name: "a bridge over the Seine", times: ["evening"], activities: [{ text: "leaning on the railing", twoHanded: false }] },
    { name: "the sundeck of a sailing yacht", times: ["golden hour"], activities: [{ text: "watching the waves", twoHanded: false }] },
    { name: "a tiny bookshop", times: ["midday"], activities: [{ text: "browsing a shelf", twoHanded: false }] },
  ],
  outfits: ["a beige trench coat and jeans", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const DRY: Pool = { ...PARIS, locations: PARIS.locations.filter((l) => !isWaterPlaceName(l.name)) };
const WET: Pool = { ...PARIS, locations: PARIS.locations.filter((l) => isWaterPlaceName(l.name)) };
const MARKET: Pool = {
  locations: [
    { name: "a lantern-lit food stall", times: ["night"], activities: [{ text: "pointing at a menu", twoHanded: false }] },
    { name: "a rooftop terrace", times: ["night"], activities: [{ text: "looking at the lights", twoHanded: false }] },
  ],
  outfits: ["a denim jacket and a white tee"],
  shotDeck: ["friend", "selfie", "candid"],
};
const pools = (custom: Record<string, Pool>): Record<string, Pool> => ({ ...POOLS, ...custom });

const tiersOf = (slots: readonly PlanSlot[]): LevelCounts => ({
  bold: slots.filter((s) => s.level === "bold").length,
  flirty: slots.filter((s) => s.level === "flirty").length,
  ordinary: slots.filter((s) => s.level === undefined).length,
});
const sumOf = (parts: readonly LevelCounts[]): LevelCounts => ({ bold: parts.reduce((t, p) => t + p.bold, 0), flirty: parts.reduce((t, p) => t + p.flirty, 0), ordinary: parts.reduce((t, p) => t + p.ordinary, 0) });

/** The tiers the planner spreads over a split: `tierSpreadOf` with the tie order drawn on the request's own `tier-spread` stream. */
const spreadOn = (seed: number, split: readonly { ref: CategoryRef; count: number }[]): LevelCounts[] => tierSpreadOf(split, () => shuffle(makeRng(subSeed(seed, "tier-spread")), split.map((_, i) => i)));

const isImplied = (slot: PlanSlot): boolean => {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === slot.outfit)?.tier === "implied";
};

describe("the five at «Смелая» (I5.71)", () => {
  // Push: 4 of the 40 seeds, the sizes 1, 2, 12 and 30. Heavy: the 40 seeds, every size from 1 to 30 (as before).
  for (const category of ORDINARY_BUILT_INS) sweepTest(`${category}: 40 seeds × sizes 1 to 30, every slot is routed and in its companion, and the tiers are levelCountsOf(n)`, { push: { seeds: SEEDS.slice(0, 4), sizes: PUSH_SIZES }, heavy: { seeds: SEEDS, sizes: countTo(30) } }, ({ seeds, sizes }) => {
    for (const seed of seeds) {
      for (const n of sizes) {
        const { slots } = plan({ seed, count: n, categories: [category], level: "bold" });
        expect(slots).toHaveLength(n);
        expect(tiersOf(slots)).toEqual(levelCountsOf(n));
        for (const slot of slots) {
          expect({ category, seed, n, route: slot.route }).toEqual({ category, seed, n, route: "seedream" });
          const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
          expect({ seed, n, place: slot.location, found: hit?.moment !== undefined && hit.bank === BOLD_COMPANIONS[category] }).toEqual({ seed, n, place: slot.location, found: true });
          expect(hit?.bank.outfits.some((o) => o.text === slot.outfit)).toBe(true);
        }
      }
    }
  });

  test.each([...ORDINARY_BUILT_INS])("%s: no template slot is null, at every level and size, either origin and the legs shares 0, 15 and 30", (category) => {
    for (const seed of SEEDS.slice(0, 8)) {
      for (const n of [1, 2, 3, 5, 8, 10, 14, 20, 30]) {
        for (const legsShare of [0, 15, 30] as const) {
          for (const level of ["ordinary", "flirty", "bold"] as const) {
            for (const impliedNudity of [false, true]) {
              const { slots } = planForAvatar({ seed, count: n, categories: [category], level, legsShare }, POOLS, impliedNudity);
              const nulls = slots.filter((slot) => templateSentence({ ...slot, route: slot.route }, { key: `run-${seed}:${slot.attemptIdBase}`, impliedNudity }) === null).map((s) => `${s.location}|${s.activity}|${s.outfit}`);
              expect({ category, seed, n, legsShare, level, impliedNudity, nulls }).toEqual({ category, seed, n, legsShare, level, impliedNudity, nulls: [] });
            }
          }
        }
      }
    }
  });

  test.each([...ORDINARY_BUILT_INS])("%s: «Ножки» deals legs slots from the companion's legs moments", (category) => {
    for (const seed of SEEDS.slice(0, 6)) {
      for (const legsShare of [15, 30] as const) {
        const { slots } = plan({ seed, count: 20, categories: [category], level: "bold", legsShare });
        const legs = slots.filter((s) => s.framing === "legs");
        expect(legs).toHaveLength(legsCountOf(legsShare, 20, 20));
        for (const slot of legs) expect(bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity })?.moment?.legs).toBeDefined();
      }
    }
  });

  test("a slot at «Обычная» or «Кокетливая» carries no route and is the ordinary bank's, as before", () => {
    for (const level of ["ordinary", "flirty"] as const) {
      const { slots } = plan({ seed: 7, count: 20, categories: [...ORDINARY_BUILT_INS], level });
      for (const slot of slots) {
        expect(slot.route).toBeUndefined();
        expect(BANKS[slot.category as (typeof ORDINARY_BUILT_INS)[number]].places.some((p) => p.name === slot.location)).toBe(true);
      }
    }
  });
});

describe("the tiers are counted over the whole request (r2.2 D1)", () => {
  const FIVE_REFS: CategoryRef[] = ["home", "travel", "shoot", "glam", "fit"];

  test("20 photos over the five are 8 / 8 / 4 in sum, and each category holds exactly its share of tierSpreadOf", () => {
    for (const seed of SEEDS) {
      const split = splitCount(20, FIVE_REFS);
      const { slots } = plan({ seed, count: 20, categories: [...ORDINARY_BUILT_INS], level: "bold" });
      expect(tiersOf(slots)).toEqual({ bold: 8, flirty: 8, ordinary: 4 });
      const spread = spreadOn(seed, split);
      split.forEach((entry, i) => {
        const category = ORDINARY_BUILT_INS[i] as PlannerCategory;
        expect({ seed, category, tiers: tiersOf(slots.filter((s) => s.category === category)) }).toEqual({ seed, category, tiers: spread[i] as LevelCounts });
      });
    }
  });

  test("an avatar's launch compose of 18 over the five sums to levelCountsOf(18)", () => {
    const split = splitCount(18, FIVE_REFS);
    for (const seed of SEEDS.slice(0, 10)) {
      const { slots } = plan({ seed, count: 18, categories: [...ORDINARY_BUILT_INS], level: "bold", split });
      expect(tiersOf(slots)).toEqual(levelCountsOf(18));
      expect(sumOf(spreadOn(seed, split))).toEqual(levelCountsOf(18));
    }
  });

  test("two equal halves of 20 give 4 / 4 / 2 to each", () => {
    const { slots } = plan({ seed: 11, count: 20, categories: ["nightwear", "beach"], level: "bold" });
    expect(tiersOf(slots.filter((s) => s.category === "nightwear"))).toEqual({ bold: 4, flirty: 4, ordinary: 2 });
    expect(tiersOf(slots.filter((s) => s.category === "beach"))).toEqual({ bold: 4, flirty: 4, ordinary: 2 });
  });

  test("the five with nightwear, beach and a custom category: every photo is routed and the tiers add up", () => {
    const categories: PlannerCategory[] = [...ORDINARY_BUILT_INS, "nightwear", "beach", CUSTOM];
    for (const seed of SEEDS.slice(0, 10)) {
      const { slots } = planWithPools({ seed, count: 40, categories, level: "bold" }, pools({ [CUSTOM]: PARIS }));
      expect(tiersOf(slots)).toEqual(levelCountsOf(40));
      expect(slots.every((s) => s.route === "seedream")).toBe(true);
    }
  });
});

describe("a custom category at «Смелая» (§5.3)", () => {
  const water = (slot: PlanSlot): boolean => CUSTOM_BOLD_BANKS.water.places.some((p) => p.name === slot.location);

  test("every slot is routed, bold-banked and carries a world that is one of the category's own places", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      for (const n of [1, 2, 5, 9, 20, 30]) {
        const { slots } = planWithPools({ seed, count: n, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: PARIS }));
        expect(slots).toHaveLength(n);
        expect(tiersOf(slots)).toEqual(levelCountsOf(n));
        for (const slot of slots) {
          expect(slot.category).toBe(CUSTOM);
          expect(slot.route).toBe("seedream");
          expect(PARIS.locations.map((l) => l.name)).toContain(slot.world as string);
          const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
          expect(hit?.moment).toBeDefined();
          expect(hit?.bank.outfits.some((o) => o.text === slot.outfit)).toBe(true);
        }
      }
    }
  });

  test("the water split is exact: w = ⌊(n × W + ⌊P / 2⌋) / P⌋ slots draw «by the water», in a water world, and the rest «rooms», in any world", () => {
    const W = PARIS.locations.filter((l) => isWaterPlaceName(l.name)).length;
    const P = PARIS.locations.length;
    for (const seed of SEEDS.slice(0, 12)) {
      for (let n = 1; n <= 30; n++) {
        const { slots } = planWithPools({ seed, count: n, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: PARIS }));
        const wet = slots.filter(water);
        expect({ seed, n, wet: wet.length }).toEqual({ seed, n, wet: Math.floor((n * W + Math.floor(P / 2)) / P) });
        for (const slot of wet) expect(isWaterPlaceName(slot.world as string)).toBe(true);
        for (const slot of slots.filter((s) => !water(s))) expect(CUSTOM_BOLD_BANKS.rooms.places.some((p) => p.name === slot.location)).toBe(true);
      }
    }
  });

  test("a category with no water place draws only «rooms», and one with only water places only «by the water»", () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const dry = planWithPools({ seed, count: 20, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: DRY })).slots;
      expect(dry.some(water)).toBe(false);
      const wet = planWithPools({ seed, count: 20, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: WET })).slots;
      expect(wet.every(water)).toBe(true);
      expect(wet.every((s) => isWaterPlaceName(s.world as string))).toBe(true);
    }
  });

  test("lingerie never reaches the water and swimwear never reaches a room", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      for (const slot of planWithPools({ seed, count: 30, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: PARIS })).slots) {
        const bank = water(slot) ? CUSTOM_BOLD_BANKS.water : CUSTOM_BOLD_BANKS.rooms;
        expect(bank.outfits.some((o) => o.text === slot.outfit)).toBe(true);
        if (water(slot)) expect(/\b(?:bra|panties|briefs|thong|bodysuit|slip|cami|robe)\b/i.test(slot.outfit)).toBe(false);
      }
    }
  });

  test("the template renders none of them (the writer sets the frame inside the world), and the plain fallback does", () => {
    const { slots } = planWithPools({ seed: 5, count: 20, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: PARIS }));
    for (const slot of slots) {
      expect(templateSentence({ ...slot, route: slot.route }, { key: `run:${slot.attemptIdBase}`, snapshots: [{ ref: CUSTOM }] })).toBeNull();
      const plain = plainSentence({ ...slot, route: slot.route });
      const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
      expect(plain.toLowerCase()).toContain(hit?.place.at ?? "");
      expect(plain).toContain(slot.activity);
    }
  });

  test("a plan is a function of its seed, and editing one custom category's pool moves nothing in another's slots", () => {
    const input: PlanInput = { seed: 99, count: 20, categories: [CUSTOM, OTHER], level: "bold" };
    const base = planWithPools(input, pools({ [CUSTOM]: PARIS, [OTHER]: MARKET }));
    expect(planWithPools(input, pools({ [CUSTOM]: PARIS, [OTHER]: MARKET }))).toEqual(base);
    const edited = planWithPools(input, pools({ [CUSTOM]: DRY, [OTHER]: MARKET }));
    const mine = (plan_: { slots: PlanSlot[] }): Omit<PlanSlot, "slotIndex" | "attemptIdBase">[] => plan_.slots.filter((s) => s.category === OTHER).map(({ slotIndex: _i, attemptIdBase: _a, ...rest }) => rest);
    expect(mine(edited)).toEqual(mine(base));
  });

  test("a custom category's own angles and shot deck are ignored at «Смелая» (QB-4): the bank deals the captures", () => {
    const angled: Pool = { ...PARIS, poses: ["back", "profile"] };
    const { slots } = planWithPools({ seed: 3, count: 20, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: angled }));
    expect(slots.every((s) => bankPlaceOf({ category: s.category, route: s.route, location: s.location, activity: s.activity })?.moment !== undefined)).toBe(true);
  });

  // BA1 review hand-off (I5.71): does a routed custom slot have to carry a world? DECISION: the planner and the redraw always give it one (it is how the bold writer knows what the frame is set inside), and
  // the schema, which only refuses a world WITHOUT the route, still reads a routed custom slot stored without one: the bold writer keeps such a slot's location as given (plan s5a4 r2.1 L3).
  test("a routed custom slot always has its world from the planner, and the schema still reads one stored without it", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      for (const slot of planWithPools({ seed, count: 25, categories: [CUSTOM, OTHER], level: "bold" }, pools({ [CUSTOM]: PARIS, [OTHER]: MARKET })).slots) {
        expect({ seed, slot: slot.slotIndex, route: slot.route, world: slot.world !== undefined }).toEqual({ seed, slot: slot.slotIndex, route: "seedream", world: true });
      }
    }
    const { world: _world, ...withoutWorld } = planWithPools({ seed: 1, count: 5, categories: [CUSTOM], level: "bold" }, pools({ [CUSTOM]: PARIS })).slots[0] as PlanSlot;
    expect(PlanSlotSchema.safeParse(withoutWorld).success).toBe(true);
    expect(PlanSlotSchema.safeParse({ ...withoutWorld, world: "a tiny bookshop", route: undefined }).success).toBe(false);
  });

  test("at «Обычная» a custom category plans as it always did: no route, no world", () => {
    const { slots } = planWithPools({ seed: 3, count: 12, categories: [CUSTOM], level: "ordinary" }, pools({ [CUSTOM]: PARIS }));
    for (const slot of slots) {
      expect(slot.route).toBeUndefined();
      expect(slot.world).toBeUndefined();
      expect(PARIS.locations.map((l) => l.name)).toContain(slot.location);
    }
  });
});

describe("the avatar's origin (I5.74)", () => {
  const OWN_BANKS: readonly { name: string; categories: PlannerCategory[]; pools: Record<string, Pool> }[] = [
    ...ORDINARY_BUILT_INS.map((c) => ({ name: c, categories: [c] as PlannerCategory[], pools: POOLS as Record<string, Pool> })),
    { name: "nightwear", categories: ["nightwear"], pools: POOLS },
    { name: "a custom category (rooms)", categories: [CUSTOM], pools: pools({ [CUSTOM]: DRY }) },
  ];

  test.each([...OWN_BANKS])("$name: with the flag absent or false no implied cover is planned in 200 seeds, and every routed sentence carries the kept coverage", ({ categories, pools: p }) => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const flag of [undefined, false] as const) {
        const input: PlanInput = { seed, count: 20, categories, level: "bold", ...(flag === undefined ? {} : { impliedNudity: flag }) };
        const { slots } = planWithPools(input, p);
        for (const slot of slots) {
          expect({ seed, flag, implied: isImplied(slot) }).toEqual({ seed, flag, implied: false });
          const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
          const outfit = hit?.bank.outfits.find((o) => o.text === slot.outfit);
          const kept = hit?.moment === undefined || outfit === undefined ? undefined : coverageOf(hit.moment, outfit, false);
          if (kept !== undefined && templateSentence({ ...slot, route: slot.route }, { key: `run:${slot.attemptIdBase}`, snapshots: [{ ref: CUSTOM }] }) !== null) {
            expect(templateSentence({ ...slot, route: slot.route }, { key: `run:${slot.attemptIdBase}`, snapshots: [{ ref: CUSTOM }] })).toContain(kept);
          }
        }
      }
    }
  });

  test.each(OWN_BANKS.filter((b) => b.name !== "a custom category (rooms)"))("$name: with the flag true an implied cover is reachable", ({ categories, pools: p }) => {
    let reached = 0;
    for (let seed = 1; seed <= 200; seed++) reached += planWithPools({ seed, count: 20, categories, level: "bold", impliedNudity: true }, p).slots.filter(isImplied).length;
    expect(reached).toBeGreaterThan(0);
  });

  test("a custom category at «Смелая» reaches an implied cover for a Studio-created avatar", () => {
    let reached = 0;
    for (let seed = 1; seed <= 200; seed++) reached += planWithPools({ seed, count: 20, categories: [CUSTOM], level: "bold", impliedNudity: true }, pools({ [CUSTOM]: DRY })).slots.filter(isImplied).length;
    expect(reached).toBeGreaterThan(0);
    expect(impliedItemsOf(CUSTOM_BOLD_BANKS.rooms).length).toBeGreaterThan(0);
  });

  test("the planner's default is false: a plan with no flag is the plan with the flag false", () => {
    const input: PlanInput = { seed: 21, count: 20, categories: [...ORDINARY_BUILT_INS, "nightwear"], level: "bold" };
    expect(plan(input)).toEqual(plan({ ...input, impliedNudity: false }));
  });

  test("planForAvatar passes the flag on and requires it", () => {
    const input: PlanInput = { seed: 21, count: 20, categories: ["home"], level: "bold" };
    expect(planForAvatar(input, POOLS, true)).toEqual(plan({ ...input, impliedNudity: true }));
    expect(planForAvatar(input, POOLS, false)).toEqual(plan(input));
    // @ts-expect-error a caller that has not decided the avatar's origin does not compile
    planForAvatar(input, POOLS);
  });
});
