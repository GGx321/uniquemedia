import { describe, expect, test } from "bun:test";
import { CATEGORIES } from "./types";
import { isOwnerBannedOutfit } from "../../shared/scenes/words";
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

  // 5a.2 (S5.6b, I5.32): the decks are the captures, dealt in exact cycles; the stored `shotDeck` is the five shots they ride on (I5.27).
  const sortedDeck = (deck: readonly string[] | undefined): string[] => [...(deck ?? [])].sort();

  test("«Дом» deals 12: four phone-over-face mirror selfies, two mirrors, two from above, two prone, one over the shoulder, one timer, and never a friend", () => {
    expect(sortedDeck(POOLS.home.captureDeck)).toEqual(sortedDeck(["mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror", "mirror", "above", "above", "prone", "prone", "over-shoulder", "timer"]));
  });

  test("«Улица» and «Виды» deal 6: three friends, a selfie, a timer and a candid", () => {
    for (const category of ["photoshoot", "travel"] as const) expect(sortedDeck(POOLS[category].captureDeck)).toEqual(sortedDeck(["friend", "friend", "friend", "selfie", "timer", "candid"]));
  });

  test("«Гламур» deals 6: two friends, a selfie, a mirror, a phone-over-face mirror and a candid", () => {
    expect(sortedDeck(POOLS.glamour.captureDeck)).toEqual(sortedDeck(["friend", "friend", "selfie", "mirror", "mirror-hidden", "candid"]));
  });

  // S5.6R: at home she shoots herself, so «Фитнес» deals a timer for the home workout beside the gym's and the park's.
  test("«Фитнес» deals 7: two friends, a selfie, a mirror, a phone-over-face mirror, a candid and a timer", () => {
    expect(sortedDeck(POOLS.fitness.captureDeck)).toEqual(sortedDeck(["friend", "friend", "selfie", "mirror", "mirror-hidden", "candid", "timer"]));
  });

  test("the stored shot deck of every pool is the shots its captures ride on, and never a photographer", () => {
    for (const category of CATEGORIES) expect(POOLS[category].shotDeck.every((shot) => ["friend", "selfie", "mirror", "candid"].includes(shot))).toBe(true);
  });

  test("every place is lit by a stored time of day, and none by a studio", () => {
    for (const category of CATEGORIES) for (const place of POOLS[category].locations) expect(place.times.every((time) => time !== "studio lighting")).toBe(true);
  });
});

// C1 (owner canary, 2026-10-11): an ordinary girl's Instagram, not a staged shoot in a wheat field, and a glamour that is not always the black dress.
describe("C1 pool text", () => {
  test("no photoshoot place or activity mentions wheat", () => {
    const text = JSON.stringify(POOLS.photoshoot.locations);
    expect(text).not.toMatch(/wheat|field/i);
  });

  // The owner (2026-10-11): no denim shorts and no denim skirts, anywhere; a denim jacket with jeans is fine.
  test("no pool outfit is denim shorts or a denim skirt", () => {
    for (const category of CATEGORIES) for (const outfit of POOLS[category].outfits) expect(isOwnerBannedOutfit(outfit)).toBe(false);
    expect(POOLS.photoshoot.outfits).toContain("a denim jacket and jeans");
  });

  // The eleven of S5.4, untouched; the legs moments pin one of their own that only they wear (pin-only, S5.8a review), listed after them.
  test("glamour draws from eleven outfits, in this order", () => {
    expect(POOLS.glamour.outfits.filter((o) => !(POOLS.glamour.outfitInfo ?? []).some((i) => i.text === o && i.pinOnly === true))).toEqual([
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

  // S5.5 (owner canary C1', 2026-10-11): glamour is an evening out, not a girl on her bed in a going-out dress.
  const glamourPlaces = (): Array<{ name: string; at?: string; room?: true; mirror?: true; times: readonly string[]; activities: string[]; twoHanded: string[] }> =>
    POOLS.glamour.locations.map((l) => ({
      name: l.name,
      at: l.at,
      room: l.room,
      mirror: l.mirror,
      times: l.times,
      activities: l.activities.map((a) => a.text),
      twoHanded: l.activities.filter((a) => a.twoHanded).map((a) => a.text),
    }));

  test("glamour has exactly seven places of an evening out, in this order", () => {
    expect(glamourPlaces().map((l) => [l.name, l.at])).toEqual([
      ["a cocktail bar", "at a cocktail bar"],
      ["a restaurant table", "at a restaurant table"],
      ["the back seat of a taxi", "in the back seat of a taxi"],
      ["a street outside a bar", "on a street outside a bar"],
      ["her bathroom while getting ready", "at her bathroom sink"],
      ["an elevator", "in an elevator"],
      ["her front door", "by her front door"],
    ]);
  });

  test("glamour places are lit by the evening or the night as written", () => {
    expect(glamourPlaces().map((l) => l.times)).toEqual([["evening", "night"], ["evening"], ["night"], ["night"], ["evening"], ["evening", "night"], ["evening"]]);
  });

  test("glamour keeps a one-handed moment at every place, and only getting ready needs both hands", () => {
    for (const place of POOLS.glamour.locations) expect(place.activities.some((a) => !a.twoHanded)).toBe(true);
    expect(POOLS.glamour.locations.flatMap((l) => l.activities.filter((a) => a.twoHanded).map((a) => l.name))).not.toContain("a restaurant table");
  });

  test("the bathroom, the elevator and the front door carry a mirror, and only the bathroom and the front door are rooms", () => {
    expect(glamourPlaces().filter((l) => l.mirror === true).map((l) => l.name)).toEqual(["her bathroom while getting ready", "an elevator", "her front door"]);
    expect(glamourPlaces().filter((l) => l.room === true).map((l) => l.name)).toEqual(["her bathroom while getting ready", "her front door"]);
  });

  test("every glamour place carries 2 or 3 details (K-3), the rooms' going into the room phrase", () => {
    for (const place of POOLS.glamour.locations) expect([2, 3]).toContain(place.details?.length ?? 0);
  });

  test("nothing in glamour is on a bed, in a hotel or at a wardrobe, and no glamour activity is messyOk", () => {
    expect(JSON.stringify(POOLS.glamour.locations)).not.toMatch(/\b(bed|beds|bedroom|hotel|wardrobe|nightstand)\b/i);
    expect(POOLS.glamour.locations.flatMap((l) => l.activities).some((a) => a.messyOk === true)).toBe(false);
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
