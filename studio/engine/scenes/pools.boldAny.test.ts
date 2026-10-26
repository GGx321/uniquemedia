import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { CategoryBank, Moment, Outfit } from "../../shared/scenes/banks/types";
import { BoldPoolSchema, BuiltInPoolSchema, POOLS, poolOfBank, type Pool } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA1, plan s5a4 §5.2, §5.5, I5.74): an item of a «Смелая» bank may carry `tier: "implied"` (a cover the model holds or wears: the sheet, the towel) and an
// `openCoverage` (the sentence a Studio-created avatar's frame says instead of `coverage`). Both are optional on the bank types and on the pool schemas. Nothing reads
// them yet (BA2 writes the banks, BA3 the planner), so every pool on main is unchanged.

const beach = POOLS.beach;
const place = beach.locations[0];
const outfit = beach.outfitInfo?.[0];
if (place === undefined || outfit === undefined) throw new Error("«Пляж и бассейн» has no place or outfit");
const moment = place.activities[0];
if (moment === undefined) throw new Error("«Пляж и бассейн» has no moment");

const OPEN = "Her white sheet is held loosely around her.";

function withMoment(extra: Record<string, unknown>): unknown {
  return { ...beach, locations: [{ ...place, activities: [{ ...moment, ...extra }, ...place.activities.slice(1)] }, ...beach.locations.slice(1)] };
}

function withOutfit(extra: Record<string, unknown>): unknown {
  return { ...beach, outfitInfo: [{ ...outfit, ...extra }, ...(beach.outfitInfo ?? []).slice(1)] };
}

describe("tier and openCoverage on the bank types", () => {
  test("a moment and an outfit may carry both, and poolOfBank copies them into the pool", () => {
    const impliedMoment: Moment = { text: moment.text, motion: "she settles the sheet a little", captures: ["friend"], twoHanded: false, tier: "implied", openCoverage: OPEN };
    const impliedOutfit: Outfit = { text: "only a white bedsheet", level: "bold", route: "seedream", coverage: "The sheet covers her.", tier: "implied", openCoverage: OPEN };
    const bank: CategoryBank = {
      bold: true,
      places: [{ name: "the room", at: "in her room", times: ["night"], details: ["a lamp", "a rug"], moments: [impliedMoment] }],
      outfits: [impliedOutfit],
      captureDeck: ["friend"],
    };
    const pool: Pool = poolOfBank(bank);
    expect(pool.locations[0]?.activities[0]).toMatchObject({ tier: "implied", openCoverage: OPEN });
    expect(pool.outfitInfo?.[0]).toMatchObject({ tier: "implied", openCoverage: OPEN });
  });

  test("a pool of the banks on main carries neither field", () => {
    for (const pool of Object.values(POOLS)) {
      expect(JSON.stringify(pool)).not.toContain("openCoverage");
      expect(JSON.stringify(pool)).not.toContain('"tier"');
    }
  });
});

describe("BoldPoolSchema", () => {
  test("accepts the tier implied and an openCoverage on a moment", () => {
    expect(BoldPoolSchema.safeParse(withMoment({ tier: "implied", openCoverage: OPEN })).success).toBe(true);
  });

  test("accepts the tier implied and an openCoverage on an outfit", () => {
    expect(BoldPoolSchema.safeParse(withOutfit({ tier: "implied", openCoverage: OPEN })).success).toBe(true);
  });

  test.each(["nude", "", "Implied"])("refuses a tier of %p: Phase 2 adds nude, not this task", (tier) => {
    expect(BoldPoolSchema.safeParse(withMoment({ tier })).success).toBe(false);
    expect(BoldPoolSchema.safeParse(withOutfit({ tier })).success).toBe(false);
  });

  test("holds an openCoverage to the coverage rules: plain ASCII and no youth word", () => {
    expect(BoldPoolSchema.safeParse(withMoment({ openCoverage: "Её простыня." })).success).toBe(false);
    expect(BoldPoolSchema.safeParse(withOutfit({ openCoverage: "A teen girl in a sheet." })).success).toBe(false);
    expect(BoldPoolSchema.safeParse(withOutfit({ openCoverage: "" })).success).toBe(false);
  });
});

describe("BankPlace.water", () => {
  test("a place may carry water, and poolOfBank copies it into the pool place", () => {
    const bank: CategoryBank = {
      bold: true,
      places: [{ name: "the pool", at: "by the pool", times: ["midday"], water: true, details: ["a lounger", "a towel"], moments: [{ text: "lies on a lounger", motion: "she shifts a little", captures: ["friend"], twoHanded: false }] }],
      outfits: [{ text: "a black bikini", level: "bold", route: "seedream", coverage: "Her bikini fully covers her." }],
      captureDeck: ["friend"],
    };
    expect(poolOfBank(bank).locations[0]?.water).toBe(true);
  });

  // 5a.4 (S5.BA2): beach's five places are water places now; a pool place carries the tag exactly when its bank place does, and gains none otherwise.
  test("a pool place carries water exactly when its bank place does, in every pool", () => {
    for (const [category, pool] of Object.entries(POOLS)) {
      const bank = BANKS[category as keyof typeof BANKS];
      expect(pool.locations.map((l) => [l.name, "water" in l ? l.water : "absent"])).toEqual(bank.places.map((p) => [p.name, p.water === true ? true : "absent"]));
    }
    expect(POOLS.beach.locations.every((l) => l.water === true)).toBe(true);
    expect(POOLS.home.locations.some((l) => "water" in l)).toBe(false);
  });

  test("both pool schemas accept water on a place", () => {
    const home = POOLS.home;
    const first = home.locations[0];
    if (first === undefined) throw new Error("«Дом» has no place");
    expect(BuiltInPoolSchema.safeParse({ ...home, locations: [{ ...first, water: true }, ...home.locations.slice(1)] }).success).toBe(true);
    expect(BoldPoolSchema.safeParse({ ...beach, locations: [{ ...place, water: true }, ...beach.locations.slice(1)] }).success).toBe(true);
  });

  test("water must be true, never false", () => {
    expect(BoldPoolSchema.safeParse({ ...beach, locations: [{ ...place, water: false }, ...beach.locations.slice(1)] }).success).toBe(false);
  });
});

describe("BuiltInPoolSchema", () => {
  test("still refuses both fields: only a «Смелая» bank carries them", () => {
    const home = POOLS.home;
    const homePlace = home.locations[0];
    const homeMoment = homePlace?.activities[0];
    if (homePlace === undefined || homeMoment === undefined) throw new Error("«Дом» has no place or moment");
    const tiered = { ...home, locations: [{ ...homePlace, activities: [{ ...homeMoment, tier: "implied" }, ...homePlace.activities.slice(1)] }, ...home.locations.slice(1)] };
    const covered = { ...home, locations: [{ ...homePlace, activities: [{ ...homeMoment, openCoverage: OPEN }, ...homePlace.activities.slice(1)] }, ...home.locations.slice(1)] };
    expect(BuiltInPoolSchema.safeParse(tiered).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse(covered).success).toBe(false);
  });
});
