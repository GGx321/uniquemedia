import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orderCategories, splitCount, type CategoryRef } from "../../shared/engine";
import { categorySeed, plan, planWithPools, poseSeed, type PlanInput } from "./planner";
import { POOLS, type Pool } from "./pools";
import { PlanSlotSchema, type PlanSlot } from "./schema";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.1: a custom category is planned next to the five built-ins, by ref. The
// built-ins' plans for a seed must not move at all (fixtures taken from main
// 3a9cd498 before this change), and a custom category draws only from its own
// pool on its own rng streams.

const CUSTOM_A = "cat-paris-cafes";
const CUSTOM_B = "cat-night-market";

const CUSTOM_POOL: Pool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a coffee with both hands", twoHanded: true }] },
    { name: "a Paris bakery counter", times: ["morning"], activities: [{ text: "choosing a croissant", twoHanded: false }], mirror: true },
    { name: "a bridge over the Seine", times: ["golden hour", "evening"], activities: [{ text: "leaning on the railing", twoHanded: false }] },
    { name: "a flower stall", times: ["midday"], activities: [{ text: "smelling a bouquet", twoHanded: false }] },
    { name: "a tiny bookshop", times: ["midday", "evening"], activities: [{ text: "browsing a shelf", twoHanded: false }] },
  ],
  outfits: ["a beige trench coat and jeans", "a striped knit top and a midi skirt", "a long cardigan and straight trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const OTHER_POOL: Pool = {
  locations: [
    { name: "a lantern-lit food stall", times: ["night"], activities: [{ text: "pointing at a menu", twoHanded: false }] },
    { name: "a crowded market lane", times: ["evening", "night"], activities: [{ text: "tasting a snack", twoHanded: false }] },
    { name: "a stall with paper lamps", times: ["night"], activities: [{ text: "choosing a lamp", twoHanded: false }], mirror: true },
    { name: "a noodle counter", times: ["evening"], activities: [{ text: "waiting for a bowl", twoHanded: false }] },
    { name: "a rooftop terrace", times: ["night"], activities: [{ text: "looking at the lights", twoHanded: false }] },
  ],
  outfits: ["a denim jacket and a white tee", "a satin shirt and black trousers", "a knit dress and boots"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const POOLS_WITH_CUSTOM: Record<string, Pool> = { ...POOLS, [CUSTOM_A]: CUSTOM_POOL, [CUSTOM_B]: OTHER_POOL };

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A slot without its position, for comparing what two plans drew. */
function drawn(slot: PlanSlot): Omit<PlanSlot, "slotIndex" | "attemptIdBase"> {
  const { slotIndex: _index, attemptIdBase: _base, ...rest } = slot;
  return rest;
}

describe("built-in plans are byte-identical to main 3a9cd498", () => {
  const fixture: { excludePairsFrom: { seed: number; count: number; take: number }; hashes: Record<string, string> } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "planner-main-3a9cd498.json"), "utf8"));
  const seeds = [1, 7, 42, 2026, 123456789, 4294967295];
  const counts = [1, 7, 20, 33, 100];
  const { seed, count, take } = fixture.excludePairsFrom;
  const excludePairs = plan({ seed, count, categories: [...CATEGORIES] })
    .slots.slice(0, take)
    .map((s) => ({ location: s.location, outfit: s.outfit }));

  test("the fixture covers every non-empty subset of the five categories", () => {
    expect(Object.keys(fixture.hashes)).toHaveLength(31 + 1);
  });

  for (let mask = 1; mask < 32; mask++) {
    const categories = CATEGORIES.filter((_, i) => mask & (1 << i));
    test(`${categories.join(", ")}: every seed and count, with and without poses and recent pairs`, () => {
      const all: unknown[] = [];
      for (const s of seeds) {
        for (const c of counts) {
          const base: PlanInput = { seed: s, count: c, categories };
          all.push(plan(base));
          all.push(plan({ ...base, poses: { profile: true, back: true }, excludePairs }));
        }
      }
      expect(sha(all)).toBe(fixture.hashes[categories.join(",")]);
    });
  }

  test("a reversed category list plans as the canonical one", () => {
    expect(sha(plan({ seed: 9, count: 20, categories: [...CATEGORIES].reverse() }))).toBe(fixture.hashes["rev-order"]);
  });

  test("planWithPools with extra pools in the table plans a built-in-only request the same as plan()", () => {
    const input: PlanInput = { seed: 2026, count: 20, categories: [...CATEGORIES] };
    expect(planWithPools(input, POOLS_WITH_CUSTOM)).toEqual(plan(input));
  });
});

describe("a custom category", () => {
  test("its slots carry its ref as their category and draw only from its own pool", () => {
    const p = planWithPools({ seed: 11, count: 12, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM);
    expect(p.slots).toHaveLength(12);
    for (const slot of p.slots) {
      expect(slot.category).toBe(CUSTOM_A);
      const place = CUSTOM_POOL.locations.find((l) => l.name === slot.location);
      expect(place).toBeDefined();
      expect(place?.times).toContain(slot.timeOfDay);
      expect(place?.activities.map((a) => a.text)).toContain(slot.activity);
      expect(CUSTOM_POOL.outfits).toContain(slot.outfit);
      expect(CUSTOM_POOL.shotDeck).toContain(slot.shot);
    }
  });

  test("a full pass over its places repeats none, like a built-in's", () => {
    const p = planWithPools({ seed: 4, count: CUSTOM_POOL.locations.length, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM);
    expect(new Set(p.slots.map((s) => s.location)).size).toBe(CUSTOM_POOL.locations.length);
  });

  test("a mirror shot lands on a mirror place and a selfie never gets a two-handed activity, across many seeds", () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const slot of planWithPools({ seed, count: 10, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM).slots) {
        if (slot.shot === "mirror") expect(CUSTOM_POOL.locations.find((l) => l.name === slot.location)?.mirror).toBe(true);
        if (slot.shot === "selfie" || slot.shot === "mirror") {
          expect(slot.activity).not.toBe("stirring a coffee with both hands");
          expect(["front", "three-quarter"]).toContain(slot.pose);
        }
      }
    }
  });

  test("its slots pass the plan's own slot schema", () => {
    for (const slot of planWithPools({ seed: 5, count: 8, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM).slots) {
      expect(PlanSlotSchema.safeParse(slot).success).toBe(true);
    }
  });

  test("the same seed plans the same slots, a different seed different ones", () => {
    const run = (seed: number) => planWithPools({ seed, count: 10, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM);
    expect(run(21)).toEqual(run(21));
    expect(run(21)).not.toEqual(run(22));
  });

  test("it avoids the avatar's recent (location, outfit) pairs like any category", () => {
    const first = planWithPools({ seed: 8, count: 3, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM).slots[0] as PlanSlot;
    const again = planWithPools({ seed: 8, count: 3, categories: [CUSTOM_A], excludePairs: [{ location: first.location, outfit: first.outfit }] }, POOLS_WITH_CUSTOM);
    const kept = again.slots.find((s) => s.location === first.location && s.outfit === first.outfit);
    expect(kept).toBeUndefined();
  });

  test("it is refused when the pool table has no pool for its ref", () => {
    expect(() => planWithPools({ seed: 1, count: 3, categories: [CUSTOM_A] }, POOLS)).toThrow(RangeError);
  });

  test("a malformed ref is refused by the slot schema", () => {
    const slot = planWithPools({ seed: 5, count: 1, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM).slots[0] as PlanSlot;
    expect(PlanSlotSchema.safeParse({ ...slot, category: "cat-short" }).success).toBe(false);
    expect(PlanSlotSchema.safeParse({ ...slot, category: "unknown" }).success).toBe(false);
  });
});

describe("custom categories draw on streams of their own (subSeed by ref)", () => {
  test("its location, outfit and shot stream differs from every built-in's and from its own pose stream", () => {
    for (const seed of [1, 42, 2026, 4294967295]) {
      const streams = new Set<number>([...CATEGORIES.map((c) => categorySeed(seed, c)), ...CATEGORIES.map((c) => poseSeed(seed, c))]);
      expect(streams.has(categorySeed(seed, CUSTOM_A))).toBe(false);
      expect(poseSeed(seed, CUSTOM_A)).not.toBe(categorySeed(seed, CUSTOM_A));
      expect(categorySeed(seed, CUSTOM_A)).not.toBe(categorySeed(seed, CUSTOM_B));
    }
  });

  const asRow = (s: PlanSlot) => [s.location, s.timeOfDay, s.activity, s.outfit, s.shot, s.pose];

  test("pins the draws of a custom category on its own streams: the first five slots for one seed are fixed", () => {
    const p = planWithPools({ seed: 20261005, count: 5, categories: [CUSTOM_A], poses: { profile: true, back: true } }, POOLS_WITH_CUSTOM);
    expect(p.slots.map(asRow)).toEqual([
      ["a Paris bakery counter", "morning", "choosing a croissant", "a striped knit top and a midi skirt", "mirror", "front"],
      ["a bridge over the Seine", "golden hour", "leaning on the railing", "a beige trench coat and jeans", "friend", "three-quarter"],
      ["a tiny bookshop", "evening", "browsing a shelf", "a long cardigan and straight trousers", "friend", "front"],
      ["a flower stall", "midday", "smelling a bouquet", "a long cardigan and straight trousers", "candid", "three-quarter"],
      ["a corner cafe in Paris", "midday", "reading a menu", "a beige trench coat and jeans", "selfie", "three-quarter"],
    ]);
  });

  test("a custom category does not draw from a built-in's stream: the same pool under home's name draws other slots", () => {
    const input = { seed: 20261005, count: 5, poses: { profile: true, back: true } };
    const custom = planWithPools({ ...input, categories: [CUSTOM_A] }, POOLS_WITH_CUSTOM).slots.map(asRow);
    const underHome = planWithPools({ ...input, categories: ["home"] }, { ...POOLS, home: CUSTOM_POOL }).slots.map(asRow);
    expect(custom).not.toEqual(underHome);
  });

  test("a built-in category given the same slots draws the same ones whether or not custom categories are in the request", () => {
    const without = planWithPools({ seed: 77, count: 6, categories: ["home", "travel"] }, POOLS_WITH_CUSTOM);
    const withCustom = planWithPools({ seed: 77, count: 9, categories: ["home", "travel", CUSTOM_A] }, POOLS_WITH_CUSTOM);
    for (const category of ["home", "travel"] as const) {
      expect(withCustom.slots.filter((s) => s.category === category).map(drawn)).toEqual(without.slots.filter((s) => s.category === category).map(drawn));
    }
  });

  test("editing a custom pool changes no built-in slot, and editing a built-in pool changes no custom slot", () => {
    const input: PlanInput = { seed: 90, count: 15, categories: [...CATEGORIES, CUSTOM_A] };
    const base = planWithPools(input, POOLS_WITH_CUSTOM);
    const editedCustom = planWithPools(input, { ...POOLS_WITH_CUSTOM, [CUSTOM_A]: { ...CUSTOM_POOL, outfits: [...CUSTOM_POOL.outfits, "a red raincoat and boots"] } });
    const editedBuiltIn = planWithPools(input, { ...POOLS_WITH_CUSTOM, home: { ...POOLS.home, outfits: [...POOLS.home.outfits, "a plain grey sweatshirt"] } });
    const builtIns = (p: { slots: PlanSlot[] }) => p.slots.filter((s) => s.category !== CUSTOM_A).map(drawn);
    expect(builtIns(editedCustom)).toEqual(builtIns(base));
    const customOnly = (p: { slots: PlanSlot[] }) => p.slots.filter((s) => s.category === CUSTOM_A).map(drawn);
    expect(customOnly(editedBuiltIn)).toEqual(customOnly(base));
  });

  test("a custom category is planned after the built-ins, in the order the request lists the custom ones", () => {
    // CUSTOM_A sorts after CUSTOM_B alphabetically, so only the order given can put it first.
    const p = planWithPools({ seed: 3, count: 8, categories: [CUSTOM_A, "fitness", CUSTOM_B, "home"] }, POOLS_WITH_CUSTOM);
    expect(p.slots.map((s) => s.category)).toEqual(["home", "home", "fitness", "fitness", CUSTOM_A, CUSTOM_A, CUSTOM_B, CUSTOM_B]);
    expect(p.slots.map((s) => s.slotIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("the planner's split is the shared splitCount", () => {
  const lists: CategoryRef[][] = [["home"], ["travel", "fit"], ["home", "travel", "shoot", "glam", "fit"], [CUSTOM_A], ["glam", CUSTOM_B, "home", CUSTOM_A], ["home", "travel", "shoot", "glam", "fit", CUSTOM_A, CUSTOM_B]];
  const engineName = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness" } as const;
  const asPlanner = (ref: CategoryRef): Category | typeof CUSTOM_A | typeof CUSTOM_B => (ref === "home" || ref === "travel" || ref === "shoot" || ref === "glam" || ref === "fit" ? engineName[ref] : ref === CUSTOM_A ? CUSTOM_A : CUSTOM_B);

  test("for every count 1..100 and every list the plan holds exactly the photos splitCount gives each category, in its order", () => {
    for (const list of lists) {
      for (let count = 1; count <= 100; count++) {
        const slots = planWithPools({ seed: count, count, categories: list.map(asPlanner) }, POOLS_WITH_CUSTOM).slots;
        const expected = splitCount(count, list).flatMap(({ ref, count: n }) => Array.from({ length: n }, () => asPlanner(ref)));
        expect(slots.map((s) => s.category)).toEqual(expected);
      }
    }
  });

  test("the plan's category blocks follow orderCategories", () => {
    const list: CategoryRef[] = ["fit", CUSTOM_A, "home", CUSTOM_B];
    const blocks = [...new Set(planWithPools({ seed: 1, count: 8, categories: list.map(asPlanner) }, POOLS_WITH_CUSTOM).slots.map((s) => s.category))];
    expect(blocks).toEqual(orderCategories(list).map(asPlanner));
  });
});
