import { describe, expect, test } from "bun:test";
import { CATEGORIES } from "./types";
import { POOLS, PoolSchema, validatePools } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 2 decision (docs/studio/2026-09-24-stage-2-plan.md, "Revealing outfits"):
// swimwear, sports bras, lingerie, stockings, slip dresses and robes are out of
// scope until the owner's provider for revealing scenes is connected. This
// mirrors the guard the pools schema itself enforces (pools.ts REVEALING_WORDS).
const REVEALING = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;

describe("the shipped pools", () => {
  test("validate against the schema at load (a malformed pool is a test failure)", () => {
    expect(validatePools).not.toThrow();
  });

  for (const category of CATEGORIES) {
    test(`${category}: has at least one location and one outfit`, () => {
      expect(POOLS[category].locations.length).toBeGreaterThan(0);
      expect(POOLS[category].outfits.length).toBeGreaterThan(0);
    });

    test(`${category}: every location has at least one time, one activity and one one-handed activity`, () => {
      for (const place of POOLS[category].locations) {
        expect(place.times.length).toBeGreaterThan(0);
        expect(place.activities.length).toBeGreaterThan(0);
        expect(place.activities.some((a) => !a.twoHanded)).toBe(true);
      }
    });

    test(`${category}: no outfit uses revealing wording`, () => {
      for (const outfit of POOLS[category].outfits) expect(outfit).not.toMatch(REVEALING);
    });

    test(`${category}: outfits are English, non-empty text`, () => {
      for (const outfit of POOLS[category].outfits) {
        expect(outfit.length).toBeGreaterThan(0);
        expect(outfit).toMatch(/^[\x20-\x7e]+$/);
      }
    });
  }

  test("a shot deck that can draw a mirror shot has at least one mirror location to place it on", () => {
    for (const category of CATEGORIES) {
      const pool = POOLS[category];
      if (pool.shotDeck.includes("mirror")) {
        expect(pool.locations.some((l) => l.mirror === true)).toBe(true);
      }
    }
  });

  test("photoshoot uses its own deck: 3 photographer, 2 candid, never friend/selfie/mirror", () => {
    expect([...POOLS.photoshoot.shotDeck].sort()).toEqual(["candid", "candid", "photographer", "photographer", "photographer"]);
  });

  test("every other category uses the default deck: 2 friend, 1 selfie, 1 mirror, 1 candid", () => {
    for (const category of CATEGORIES.filter((c) => c !== "photoshoot")) {
      expect([...POOLS[category].shotDeck].sort()).toEqual(["candid", "friend", "friend", "mirror", "selfie"]);
    }
  });

  test("the photoshoot hallway wall is lit by the morning or the evening, not by a studio", () => {
    const wall = POOLS.photoshoot.locations.find((l) => l.name === "a plain wall in her hallway");
    expect(wall?.times).toEqual(["morning", "evening"]);
  });
});

// C1 (owner canary, 2026-10-11): an ordinary girl's Instagram, not a staged shoot in a wheat field, and a glamour that is not always the black dress.
describe("C1 pool text", () => {
  test("photoshoot has a park path in place of the wheat field", () => {
    const names = POOLS.photoshoot.locations.map((l) => l.name);
    expect(names).not.toContain("a field by the road");
    expect(names).toContain("a park path");
    const path = POOLS.photoshoot.locations.find((l) => l.name === "a park path");
    expect(path).toMatchObject({ at: "on a park path", times: ["golden hour", "midday"] });
    expect(path?.activities.map((a) => a.text)).toEqual(["walking along the path", "sitting on a bench", "looking over her shoulder"]);
  });

  test("no photoshoot place or activity mentions wheat", () => {
    const text = JSON.stringify(POOLS.photoshoot.locations);
    expect(text).not.toMatch(/wheat|field/i);
  });

  test("photoshoot swaps the trench coat for a cropped cardigan and jeans", () => {
    expect(POOLS.photoshoot.outfits).toEqual(["a loose blazer over a tee and jeans", "a black going-out dress", "a denim jacket and jeans", "a monochrome knit set", "a cropped cardigan and jeans"]);
  });

  test("glamour draws from eleven outfits, in this order", () => {
    expect(POOLS.glamour.outfits).toEqual([
      "a fitted black bodycon dress",
      "a mini skirt with a cropped top",
      "a corset top and high-rise trousers",
      "a long-sleeved red mini dress",
      "a white top and leather mini skirt",
      "a silver sequin top and trousers",
      "an emerald blouse and leather skirt",
      "a fitted beige knit midi dress",
      "a halter top and a midi skirt",
      "a navy wrap dress",
      "an off-shoulder top and jeans",
    ]);
  });

  test("the glamour outfits are distinct", () => {
    expect(new Set(POOLS.glamour.outfits).size).toBe(POOLS.glamour.outfits.length);
  });
});

describe("the pool schema catches a malformed pool", () => {
  const goodPlace = { name: "x", times: ["morning"], activities: [{ text: "a", twoHanded: false }] };
  const goodPool = { locations: [goodPlace], outfits: ["a plain dress"], shotDeck: ["friend"] as const };

  test("accepts a well-formed pool", () => {
    expect(PoolSchema.safeParse(goodPool).success).toBe(true);
  });

  test("rejects a location with only two-handed activities: a selfie/mirror slot could never fill it", () => {
    const bad = { ...goodPool, locations: [{ ...goodPlace, activities: [{ text: "a", twoHanded: true }] }] };
    expect(PoolSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects a revealing outfit", () => {
    expect(PoolSchema.safeParse({ ...goodPool, outfits: ["a bikini"] }).success).toBe(false);
  });

  test("rejects a location name that suggests a minor (ageText.ts youthWords)", () => {
    const bad = { ...goodPool, locations: [{ ...goodPlace, name: "a college freshman dorm room" }] };
    expect(PoolSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an activity text that suggests a minor (ageText.ts youthWords)", () => {
    const bad = { ...goodPool, locations: [{ ...goodPlace, activities: [{ text: "showing off her petite frame", twoHanded: false }] }] };
    expect(PoolSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects an outfit that suggests a minor (ageText.ts youthWords)", () => {
    expect(PoolSchema.safeParse({ ...goodPool, outfits: ["a schoolgirl skirt"] }).success).toBe(false);
  });

  test("rejects a mirror shot in the deck with no mirror location", () => {
    expect(PoolSchema.safeParse({ ...goodPool, shotDeck: ["mirror"] }).success).toBe(false);
  });

  test("rejects an empty locations list", () => {
    expect(PoolSchema.safeParse({ ...goodPool, locations: [] }).success).toBe(false);
  });

  test("rejects an empty outfits list", () => {
    expect(PoolSchema.safeParse({ ...goodPool, outfits: [] }).success).toBe(false);
  });

  test("rejects an unknown key (strict)", () => {
    expect(PoolSchema.safeParse({ ...goodPool, extra: true }).success).toBe(false);
  });

  test("rejects a location with an empty name", () => {
    expect(PoolSchema.safeParse({ ...goodPool, locations: [{ ...goodPlace, name: "" }] }).success).toBe(false);
  });

  test("rejects a location with no times", () => {
    expect(PoolSchema.safeParse({ ...goodPool, locations: [{ ...goodPlace, times: [] }] }).success).toBe(false);
  });
});
