import { describe, expect, test } from "bun:test";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { plan, planWithPools } from "./planner";
import { poolOfSlot } from "./poolAt";
import { POOLS, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 I5.73, I5.74, I5.78, §5.1.2, §8 BA3, BA1 review hand-off): «Другая сцена» on a «Смелая» scene. A routed scene of the five stays in its companion; a scene stored before
// 5a.4 (drawn as «Кокетливая», no route) stays in the ordinary pool at its flirty level; a custom routed scene keeps its branch and redraws its world; an imported avatar never redraws an implied
// cover; and the redraw drops `world` whenever it drops the route (here it never has one without the other).

const NO_AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
const CUSTOM = "cat-paris-trip";
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
const WATER_WORLDS = PARIS.locations.map((l) => l.name).filter(isWaterPlaceName);
const isImplied = (slot: PlanSlot): boolean => {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === slot.outfit)?.tier === "implied";
};

describe("a routed scene of the five", () => {
  test.each([...ORDINARY_BUILT_INS])("%s: redraws inside its companion, at its own level, on the route", (category) => {
    const slots = [3, 4, 5].flatMap((seed) => plan({ seed, count: 20, categories: [category], level: "bold" }).slots);
    for (const slot of slots) {
      for (let k = 1; k <= 3; k++) {
        const pool = poolOfSlot(slot, true) ?? POOLS[category];
        const out = redrawSlot({ seed: 99, k, slot, pool, avoid: NO_AVOID, impliedNudity: true });
        const hit = bankPlaceOf({ category: out.category, route: out.route, location: out.location, activity: out.activity });
        expect({ found: hit?.bank === BOLD_COMPANIONS[category] && hit.moment !== undefined, route: out.route, level: out.level }).toEqual({ found: true, route: "seedream", level: slot.level });
      }
    }
  });

  test("an imported avatar never redraws an implied cover, for the five, nightwear and a custom category, in 200 redraws each", () => {
    for (const category of [...ORDINARY_BUILT_INS, "nightwear"] as const) {
      const slots = plan({ seed: 8, count: 30, categories: [category], level: "bold", impliedNudity: true }).slots;
      for (let k = 1; k <= 7; k++) {
        for (const slot of slots) {
          const out = redrawSlot({ seed: 5, k, slot, pool: poolOfSlot(slot, true) ?? POOLS[category], avoid: NO_AVOID });
          expect({ category, k, implied: isImplied(out) }).toEqual({ category, k, implied: false });
        }
      }
    }
  });

  test("a Studio-created avatar can redraw into one", () => {
    let reached = 0;
    const slots = plan({ seed: 8, count: 30, categories: ["home"], level: "bold", impliedNudity: true }).slots;
    for (let k = 1; k <= 40; k++) for (const slot of slots) reached += isImplied(redrawSlot({ seed: 5, k, slot, pool: poolOfSlot(slot, true) ?? POOLS.home, avoid: NO_AVOID, impliedNudity: true })) ? 1 : 0;
    expect(reached).toBeGreaterThan(0);
  });
});

describe("a scene stored before 5a.4", () => {
  test("a «Смелая» «Дом» scene drawn as «Кокетливая» (no route) stays in the ordinary pool at its flirty level, with no route", () => {
    const slots = [3, 4, 5, 6].flatMap((seed) => plan({ seed, count: 20, categories: ["home"], level: "flirty" }).slots);
    expect(slots.some((s) => s.level === "flirty")).toBe(true);
    for (const slot of slots) {
      expect(poolOfSlot(slot, true)).toBe(POOLS.home);
      const out = redrawSlot({ seed: 99, k: 1, slot, pool: poolOfSlot(slot, true) ?? POOLS.home, avoid: NO_AVOID });
      expect({ level: out.level, route: out.route, world: out.world }).toEqual({ level: slot.level, route: undefined, world: undefined });
    }
  });

  test("a custom scene with no route redraws in its own pool, with no route and no world", () => {
    const slots = planWithPools({ seed: 3, count: 10, categories: [CUSTOM], level: "flirty" }, { ...POOLS, [CUSTOM]: PARIS }).slots;
    for (const slot of slots) {
      const out = redrawSlot({ seed: 4, k: 2, slot, pool: PARIS, avoid: NO_AVOID });
      expect({ route: out.route, world: out.world }).toEqual({ route: undefined, world: undefined });
    }
  });
});

describe("a routed custom scene", () => {
  const slots = [1, 2, 3, 4].flatMap((seed) => planWithPools({ seed, count: 20, categories: [CUSTOM], level: "bold", impliedNudity: true }, { ...POOLS, [CUSTOM]: PARIS }).slots);
  const waterBank = (slot: PlanSlot): boolean => CUSTOM_BOLD_BANKS.water.places.some((p) => p.name === slot.location);

  test("keeps its branch, its route and its level, and redraws its world inside the category's own places", () => {
    expect(slots.some(waterBank) && slots.some((s) => !waterBank(s))).toBe(true);
    for (const slot of slots) {
      for (let k = 1; k <= 3; k++) {
        const out = redrawSlot({ seed: 77, k, slot, pool: poolOfSlot(slot, true) ?? PARIS, worldPool: PARIS, avoid: NO_AVOID, impliedNudity: true });
        expect({ water: waterBank(out), route: out.route, level: out.level }).toEqual({ water: waterBank(slot), route: "seedream", level: slot.level });
        expect(PARIS.locations.map((l) => l.name)).toContain(out.world as string);
        if (waterBank(out)) expect(WATER_WORLDS).toContain(out.world as string);
      }
    }
  });

  test("redraws a world other than its own when the category has another to give", () => {
    const changed = slots.filter((slot) => {
      const world = redrawSlot({ seed: 77, k: 1, slot, pool: poolOfSlot(slot, true) ?? PARIS, worldPool: PARIS, avoid: NO_AVOID, impliedNudity: true }).world;
      return world !== undefined && world !== slot.world;
    });
    expect(changed.length).toBeGreaterThan(slots.length / 2);
  });

  test("never has a world without the route: every redraw parses as a plan slot", () => {
    for (const slot of slots) {
      const out = redrawSlot({ seed: 77, k: 2, slot, pool: poolOfSlot(slot, true) ?? PARIS, worldPool: PARIS, avoid: NO_AVOID, impliedNudity: true });
      expect(PlanSlotSchema.safeParse(out).success).toBe(true);
      expect(out.world === undefined).toBe(out.route === undefined);
    }
  });

  test("keeps its own world when it has no world pool to draw another from: a routed custom scene never loses its world", () => {
    for (const slot of slots) {
      const out = redrawSlot({ seed: 77, k: 2, slot, pool: poolOfSlot(slot, true) ?? PARIS, avoid: NO_AVOID, impliedNudity: true });
      expect({ route: out.route, world: out.world }).toEqual({ route: "seedream", world: slot.world });
      expect(PlanSlotSchema.safeParse(out).success).toBe(true);
    }
  });

  // BA1 review hand-off: the redraw drops `world` whenever it drops the route. A routed custom scene redrawn in a pool that is not «Смелая» (here the category's own, an ordinary pool) draws no route, and
  // then it must carry no world either: the plan slot refuses a world without the route.
  test("drops the world whenever it drops the route", () => {
    for (const slot of slots) {
      const out = redrawSlot({ seed: 77, k: 2, slot, pool: PARIS, worldPool: PARIS, avoid: NO_AVOID });
      expect({ route: out.route, world: out.world }).toEqual({ route: undefined, world: undefined });
      expect(PlanSlotSchema.safeParse(out).success).toBe(true);
    }
  });

  // Round 2, L-9. DECISION: a water scene whose category has no water place left (the category was regenerated) keeps the world it has, rather than leaving for «rooms» with underwear: the scene stays the
  // swimwear scene the owner reviewed and nothing is swapped under him. It never takes a dry world, so swimwear is never set in a cafe.
  test("a water scene keeps its world when the category has no water place left, and never takes a dry one", () => {
    const water = slots.filter(waterBank);
    expect(water.length).toBeGreaterThan(0);
    const dry: Pool = { ...PARIS, locations: PARIS.locations.filter((l) => !isWaterPlaceName(l.name)) };
    for (const slot of water) {
      for (let k = 1; k <= 3; k++) {
        const out = redrawSlot({ seed: 77, k, slot, pool: poolOfSlot(slot, true) ?? PARIS, worldPool: dry, avoid: NO_AVOID, impliedNudity: true });
        expect({ water: waterBank(out), world: out.world }).toEqual({ water: true, world: slot.world });
      }
    }
  });

  test("an imported avatar's redraw holds no implied cover", () => {
    for (let k = 1; k <= 20; k++) for (const slot of slots) expect(isImplied(redrawSlot({ seed: 5, k, slot, pool: poolOfSlot(slot, true) ?? PARIS, worldPool: PARIS, avoid: NO_AVOID }))).toBe(false);
  });
});
