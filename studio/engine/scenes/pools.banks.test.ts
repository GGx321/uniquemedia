import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import { shotOf } from "../../shared/scenes/captures";
import { BuiltInPoolSchema, POOLS } from "./pools";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, I5.21): POOLS is built from the shared banks: one bank, one source. A place is a bank place, an activity a bank moment with its tags, an
// outfit a bank outfit, and the category's deck of captures is the bank's. The stored `shotDeck` stays the five shots (I5.27), derived from the captures.

describe.each([...CATEGORIES])("POOLS.%s is the %s bank", (category) => {
  const pool = POOLS[category];
  const bank = BANKS[category];

  test("its places are the bank's places, in order, with their marks, their lamp and their 2-3 details", () => {
    expect(pool.locations.map((p) => p.name)).toEqual(bank.places.map((p) => p.name));
    for (const [i, place] of pool.locations.entries()) {
      const source = bank.places[i];
      expect(place.at).toBe(source?.at);
      expect([...place.times]).toEqual([...(source?.times ?? [])]);
      expect(place.mirror).toBe(source?.mirror);
      expect(place.room).toBe(source?.room);
      expect(place.lamp).toBe(source?.lamp);
      expect([...(place.details ?? [])]).toEqual([...(source?.details ?? [])]);
      expect(place.details?.length).toBeGreaterThanOrEqual(2);
      expect(place.details?.length).toBeLessThanOrEqual(3);
    }
  });

  test("its activities are the bank's moments, carrying the captures and the tags the planner reads", () => {
    for (const [i, place] of pool.locations.entries()) {
      const moments = bank.places[i]?.moments ?? [];
      expect(place.activities.map((a) => a.text)).toEqual(moments.map((m) => m.text));
      for (const [j, activity] of place.activities.entries()) {
        const moment = moments[j];
        expect(activity.twoHanded).toBe(moment?.twoHanded ?? false);
        expect(activity.phone).toBe(moment?.phone);
        expect(activity.messyOk).toBe(moment?.messyOk);
        expect([...(activity.captures ?? [])]).toEqual([...(moment?.captures ?? [])]);
        expect(activity.angle).toBe(moment?.angle);
        expect(activity.gaze).toBe(moment?.gaze);
        expect(activity.hair).toBe(moment?.hair);
        expect(activity.outdoor).toBe(moment?.outdoor);
        expect(activity.noLegwear).toBe(moment?.noLegwear);
        expect(activity.mirrorBack).toBe(moment?.mirrorBack);
        expect(activity.outfits).toEqual(moment?.outfits);
      }
    }
  });

  test("its outfits are the bank's outfit texts, with the leg and pin-only marks beside them", () => {
    expect([...pool.outfits]).toEqual(bank.outfits.map((o) => o.text));
    expect(pool.outfitInfo?.map((o) => [o.text, o.showsLegs === true, o.pinOnly === true])).toEqual(bank.outfits.map((o) => [o.text, o.showsLegs === true, o.pinOnly === true]));
  });

  test("its deck of captures is the bank's, its stored shot deck the shots they ride on, and its legwear the bank's", () => {
    expect([...(pool.captureDeck ?? [])]).toEqual([...bank.captureDeck]);
    expect([...pool.shotDeck]).toEqual(bank.captureDeck.map(shotOf));
    expect(pool.legwear).toEqual(bank.legwear);
  });

  test("it validates as a built-in pool", () => {
    expect(BuiltInPoolSchema.safeParse(pool).success).toBe(true);
  });
});

describe("the built-in pool schema, on the banks' words", () => {
  const good = POOLS.home;

  test("lets «silk pajamas» through (K-22) and refuses «satin pajamas»", () => {
    expect(BuiltInPoolSchema.safeParse({ ...good, outfits: ["silk pajamas"] }).success).toBe(true);
    expect(BuiltInPoolSchema.safeParse({ ...good, outfits: ["satin pajamas"] }).success).toBe(false);
  });

  test("refuses an outfit of denim shorts or a denim skirt anywhere (the owner)", () => {
    expect(BuiltInPoolSchema.safeParse({ ...good, outfits: ["a tee and denim shorts"] }).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse({ ...good, outfits: ["a tee and a denim skirt"] }).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse({ ...good, outfits: ["a denim jacket and jeans"] }).success).toBe(true);
  });

  test("refuses a place with one detail, or with four", () => {
    const place = good.locations[0];
    expect(place).toBeDefined();
    if (place === undefined) return;
    expect(BuiltInPoolSchema.safeParse({ ...good, locations: [{ ...place, details: ["a plant"] }] }).success).toBe(false);
    expect(BuiltInPoolSchema.safeParse({ ...good, locations: [{ ...place, details: ["a plant", "a lamp", "a rug", "a chair"] }] }).success).toBe(false);
  });

  test("refuses a text past the 35-character pool bound", () => {
    const place = good.locations[0];
    if (place === undefined) return;
    const activity = place.activities[0];
    if (activity === undefined) return;
    expect(BuiltInPoolSchema.safeParse({ ...good, locations: [{ ...place, activities: [{ ...activity, text: "x".repeat(36) }] }] }).success).toBe(false);
  });
});
