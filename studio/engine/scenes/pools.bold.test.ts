import { describe, expect, test } from "bun:test";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { BoldPoolSchema, BuiltInPoolSchema, POOLS, poolOfBank, type Activity, type Pool } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9b2, plan s5a3 §6.4, H2): the engine holds a «Смелая» category's pool to BoldPoolSchema, chosen by category. It is the built-in schema with the
// «Смелая» shapes (an activity's level up to bold, the route, the coverage, the water tag; an outfit's level, route and coverage; the bold legwear) and one
// word rule changed: an outfit is held to the bold content line (youth words only, the babydoll garment name spared) instead of the revealing words, and to
// the soft look list minus the satin nightwear phrases. The five keep BuiltInPoolSchema byte for byte, which refuses all of it.

const home = POOLS.home;
const firstPlace = home.locations[0];
if (firstPlace === undefined) throw new Error("«Дом» has no place");

const COVER = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const LINGERIE = { text: "a black lace bra and panties", showsLegs: true as const, level: "bold" as const, route: "seedream" as const, coverage: COVER };
const BOLD_MOMENT: Activity = {
  text: "pulls her jeans up over her panties",
  motion: "she tugs the waistband up slowly",
  captures: ["mirror-hidden"],
  twoHanded: false,
  level: "bold",
  route: "seedream",
  coverage: "Her panties fully cover her bottom, and her crop top covers her chest.",
};
const WATER_MOMENT: Activity = { text: "stands waist-deep, looking back", motion: "she turns her head a little", captures: ["friend"], twoHanded: false, water: true, level: "flirty", outfits: ["a black bikini"] };

/** «Дом»'s pool with «Смелая» items added: a lingerie outfit, a satin one, a bikini, the babydoll, a bold moment, a water moment and the stockings. */
const BOLD_POOL: Pool = {
  ...home,
  locations: [{ ...firstPlace, activities: [...firstPlace.activities, BOLD_MOMENT, WATER_MOMENT] }, ...home.locations.slice(1)],
  outfits: [...home.outfits, LINGERIE.text, "a satin cami and sleep shorts", "a short tied satin robe", "a black bikini", "a sheer babydoll over a lace set"],
  outfitInfo: [
    ...(home.outfitInfo ?? []),
    LINGERIE,
    { text: "a satin cami and sleep shorts", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her cami and shorts are opaque satin." },
    { text: "a short tied satin robe", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her robe is tied and closed over her chest." },
    { text: "a black bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." },
    { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
  ],
  legwear: { items: ["thigh-high socks", "sheer black tights"], share: 0.3, bold: { items: ["black thigh-high stockings", "sheer black stockings"], share: 0.5, route: "seedream" } },
};

const withOutfit = (text: string, info: Record<string, unknown> = {}): unknown => ({ ...BOLD_POOL, outfits: [...BOLD_POOL.outfits, text], outfitInfo: [...(BOLD_POOL.outfitInfo ?? []), { text, ...info }] });
const withActivity = (activity: Record<string, unknown>): unknown => ({ ...BOLD_POOL, locations: [{ ...firstPlace, activities: [...firstPlace.activities, activity] }, ...home.locations.slice(1)] });

describe("BoldPoolSchema", () => {
  test("accepts a «Смелая» pool: lingerie, satin nightwear, swimwear, the babydoll, bold and water moments, the stockings", () => {
    const result = BoldPoolSchema.safeParse(BOLD_POOL);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });

  test("accepts the five's pools too: it only adds to what they may hold", () => {
    for (const category of ["home", "travel", "photoshoot", "glamour", "fitness"] as const) expect(BoldPoolSchema.safeParse(POOLS[category]).success, category).toBe(true);
  });

  test.each<[string, unknown]>([
    ["an outfit with a youth word", withOutfit("a schoolgirl set")],
    ["«baby» beside the exempt garment", withOutfit("a baby blue babydoll")],
    ["satin that is not the satin nightwear", withOutfit("satin pajamas")],
    ["a satin dress", withOutfit("a satin dress")],
    ["denim shorts", withOutfit("a bra and denim shorts")],
    ["an outfit past the 35-character bound", withOutfit("a black lace bra and matching panties set")],
    ["an outfit that is not plain ASCII", withOutfit("a lace bra — and panties")],
    ["a paper word in an outfit", withOutfit("a bikini and a magazine")],
    ["a coverage sentence with a youth word", withOutfit("a white lace bra and panties", { showsLegs: true, level: "bold", route: "seedream", coverage: "It covers her like a little girl's." })],
    ["an outfit level past bold", withOutfit("a white lace bra and panties", { level: "explicit", route: "seedream", coverage: COVER })],
    ["a route other than Seedream", withOutfit("a white lace bra and panties", { level: "bold", route: "grok", coverage: COVER })],
    ["an activity level past bold", withActivity({ text: "sits on the rug", twoHanded: false, level: "explicit" })],
    ["an activity with a youth word", withActivity({ text: "sits on the rug like a teen", twoHanded: false })],
    ["an activity with a luxury word", withActivity({ text: "sits on the marble floor", twoHanded: false })],
    ["bold legwear on another route", { ...BOLD_POOL, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "grok" } } }],
    ["bold legwear with a youth word", { ...BOLD_POOL, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["schoolgirl stockings"], share: 0.5, route: "seedream" } } }],
    // The built-in place rules hold here too.
    ["a place with one detail", { ...BOLD_POOL, locations: [{ ...firstPlace, details: ["a plant"] }, ...home.locations.slice(1)] }],
    ["a place whose every activity needs both hands", { ...BOLD_POOL, locations: [{ ...firstPlace, activities: [{ text: "stretches with both arms", twoHanded: true }] }, ...home.locations.slice(1)] }],
  ])("refuses %s", (_name, pool) => {
    expect(BoldPoolSchema.safeParse(pool).success).toBe(false);
  });
});

describe("BuiltInPoolSchema keeps refusing all of it (the five, byte for byte)", () => {
  test("still accepts the five's pools", () => {
    for (const category of ["home", "travel", "photoshoot", "glamour", "fitness"] as const) expect(BuiltInPoolSchema.safeParse(POOLS[category]).success, category).toBe(true);
  });

  test.each<[string, unknown]>([
    ["the «Смелая» pool", BOLD_POOL],
    ["a lingerie outfit", { ...home, outfits: [...home.outfits, "a black lace bra and panties"] }],
    ["a bikini", { ...home, outfits: [...home.outfits, "a black bikini"] }],
    ["a satin cami", { ...home, outfits: [...home.outfits, "a satin cami and sleep shorts"] }],
    ["the babydoll", { ...home, outfits: [...home.outfits, "a sheer babydoll over a lace set"] }],
    ["an outfit's level", { ...home, outfitInfo: (home.outfitInfo ?? []).map((o, i) => (i === 0 ? { ...o, level: "flirty" } : o)) }],
    ["an outfit's route", { ...home, outfitInfo: (home.outfitInfo ?? []).map((o, i) => (i === 0 ? { ...o, route: "seedream" } : o)) }],
    ["an outfit's coverage", { ...home, outfitInfo: (home.outfitInfo ?? []).map((o, i) => (i === 0 ? { ...o, coverage: "It covers her." } : o)) }],
    ["a bold activity", { ...home, locations: [{ ...firstPlace, activities: [...firstPlace.activities, { text: "sits on the rug", twoHanded: false, level: "bold" }] }, ...home.locations.slice(1)] }],
    ["an activity's route", { ...home, locations: [{ ...firstPlace, activities: [...firstPlace.activities, { text: "sits on the rug", twoHanded: false, route: "seedream" }] }, ...home.locations.slice(1)] }],
    ["a water activity", { ...home, locations: [{ ...firstPlace, activities: [...firstPlace.activities, { text: "sits on the rug", twoHanded: false, water: true }] }, ...home.locations.slice(1)] }],
    ["bold legwear", { ...home, legwear: { items: ["thigh-high socks"], share: 0.4, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream" } } }],
  ])("refuses %s", (_name, pool) => {
    expect(BuiltInPoolSchema.safeParse(pool).success).toBe(false);
  });
});

// M4 (plan s5a3 r3 #7): a pool is built from its bank, and a «Смелая» bank's pool must keep what the bank says beyond the five's shapes: the bold legwear (the stockings a
// bold slot wears), each outfit's level, route and coverage, each moment's level, route, coverage and water tag. Dropping the bold legwear would leave every bold slot
// without stockings.
describe("poolOfBank keeps the «Смелая» fields of its bank", () => {
  const BANK: CategoryBank = {
    bold: true,
    places: [
      {
        name: "her bed",
        at: "on her bed",
        times: ["evening", "night"],
        room: true,
        mirror: true,
        details: ["a bedside lamp", "a glass of water on the nightstand"],
        moments: [BOLD_MOMENT as CategoryBank["places"][number]["moments"][number], { ...WATER_MOMENT, captures: ["friend"], motion: "she turns her head a little" }],
      },
    ],
    outfits: [LINGERIE, { text: "a black bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." }],
    legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["black thigh-high stockings", "sheer black stockings"], share: 0.5, route: "seedream" } },
    captureDeck: ["mirror-hidden", "friend"],
  };
  const pool = poolOfBank(BANK);

  test("the bold legwear, its items, share and route", () => {
    expect(pool.legwear).toEqual({ items: ["thigh-high socks"], share: 0.3, bold: { items: ["black thigh-high stockings", "sheer black stockings"], share: 0.5, route: "seedream" } });
  });

  test("each outfit's level, route and coverage", () => {
    expect(pool.outfitInfo).toEqual(BANK.outfits);
  });

  test("each moment's level, route, coverage and water tag", () => {
    const activities = pool.locations[0]?.activities ?? [];
    expect(activities.map((a) => [a.level, a.route, a.coverage, a.water])).toEqual([
      ["bold", "seedream", BOLD_MOMENT.coverage, undefined],
      ["flirty", undefined, undefined, true],
    ]);
  });

  test("a bank with no bold legwear keeps none (the five's pools do not move)", () => {
    expect(poolOfBank({ ...BANK, legwear: { items: ["thigh-high socks"], share: 0.3 } }).legwear).toEqual({ items: ["thigh-high socks"], share: 0.3 });
    expect(POOLS.home.legwear).toEqual({ items: ["white knee-high socks", "black knee-high socks", "thigh-high socks", "sheer black tights"], share: 0.4 });
  });
});
