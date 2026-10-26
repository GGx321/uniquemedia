import { describe, expect, test } from "bun:test";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import { BOLD_POOLS, CUSTOM_BOLD_POOLS, POOLS } from "./pools";
import { poolAt, poolOfSlot, withoutImplied } from "./poolAt";
import { ORDINARY_BUILT_INS } from "./types";

// 5a.4 (S5.BA3, plan s5a4 §5.1.2, I5.71, I5.73, I5.74): the two pool functions. `poolAt` plans NEW slots: the five at «Смелая» come from their companion, everything else from today's
// pool. `poolOfSlot` serves STORED slots by their marker: the five or a custom category with the route, the companion or the shared custom bank; otherwise today's pool, so an old
// «Смелая» set of the five (drawn as «Кокетливая», no route) redraws in the ordinary «Дом» pool. A pool without a Studio-created avatar's implied covers is what an imported avatar draws.

const implied = (pool: ReturnType<typeof withoutImplied>): string[] => [
  ...(pool.outfitInfo ?? []).filter((o) => o.tier === "implied").map((o) => `outfit ${o.text}`),
  ...pool.locations.flatMap((l) => l.activities.filter((a) => a.tier === "implied").map((a) => `moment ${a.text}`)),
];

describe("withoutImplied", () => {
  test("drops every implied outfit and moment of a pool that has some, and keeps every place and every other moment", () => {
    const pool = BOLD_POOLS.home;
    expect(implied(pool).length).toBeGreaterThan(0);
    const stripped = withoutImplied(pool);
    expect(implied(stripped)).toEqual([]);
    expect(stripped.outfits.some((text) => (pool.outfitInfo ?? []).some((o) => o.text === text && o.tier === "implied"))).toBe(false);
    expect(stripped.locations.map((l) => l.name)).toEqual(pool.locations.map((l) => l.name));
    expect(stripped.locations.every((l) => l.activities.length > 0)).toBe(true);
    const keptMoments = pool.locations.reduce((sum, l) => sum + l.activities.filter((a) => a.tier !== "implied").length, 0);
    expect(stripped.locations.reduce((sum, l) => sum + l.activities.length, 0)).toBe(keptMoments);
  });

  test("hands back a pool with no implied item as it is", () => {
    expect(withoutImplied(CUSTOM_BOLD_POOLS.water)).toBe(CUSTOM_BOLD_POOLS.water);
  });

  test("keeps the capture deck, the legwear and the shot deck", () => {
    const stripped = withoutImplied(POOLS.nightwear);
    expect(stripped.captureDeck).toEqual(POOLS.nightwear.captureDeck);
    expect(stripped.legwear).toEqual(POOLS.nightwear.legwear);
    expect(stripped.shotDeck).toEqual(POOLS.nightwear.shotDeck);
  });
});

describe("poolAt: the pool a new slot is planned from", () => {
  test.each([...ORDINARY_BUILT_INS])("%s at «Смелая» is its companion's pool", (category) => {
    expect(poolAt(category, "bold", true)).toBe(BOLD_POOLS[category]);
  });

  test.each([...ORDINARY_BUILT_INS])("%s at «Обычная», «Кокетливая» and with no level is today's pool, whoever the avatar is", (category) => {
    for (const level of ["ordinary", "flirty", undefined] as const) for (const impliedNudity of [false, true]) expect(poolAt(category, level, impliedNudity)).toBe(POOLS[category]);
  });

  test("an imported avatar's pool holds no implied cover, a Studio-created avatar's holds them", () => {
    expect(implied(poolAt("home", "bold", false))).toEqual([]);
    expect(implied(poolAt("home", "bold", true)).length).toBeGreaterThan(0);
    expect(implied(poolAt("nightwear", "bold", false))).toEqual([]);
    expect(implied(poolAt("nightwear", "bold", true)).length).toBeGreaterThan(0);
  });

  test("beach is today's pool at every level", () => {
    for (const level of ["ordinary", "flirty", "bold", undefined] as const) expect(poolAt("beach", level, false)).toBe(POOLS.beach);
  });
});

describe("poolOfSlot: the pool a stored slot belongs to", () => {
  test.each([...ORDINARY_BUILT_INS])("a routed %s slot is the companion's", (category) => {
    expect(poolOfSlot({ category, route: "seedream" }, true)).toBe(BOLD_POOLS[category]);
  });

  test.each([...ORDINARY_BUILT_INS])("an unrouted %s slot, a set stored before 5a.4, is today's pool", (category) => {
    expect(poolOfSlot({ category, route: undefined }, true)).toBe(POOLS[category]);
  });

  test("a routed custom slot is the shared bank that has its place", () => {
    const room = CUSTOM_BOLD_BANKS.rooms.places[0]?.name;
    const water = CUSTOM_BOLD_BANKS.water.places[0]?.name;
    expect(poolOfSlot({ category: "cat-paris-trip", route: "seedream", location: room }, true)).toBe(CUSTOM_BOLD_POOLS.rooms);
    expect(poolOfSlot({ category: "cat-paris-trip", route: "seedream", location: water }, true)).toBe(CUSTOM_BOLD_POOLS.water);
  });

  test("an unrouted custom slot and an own scene have no pool of the new kind", () => {
    expect(poolOfSlot({ category: "cat-paris-trip", route: undefined, location: "her room" }, true)).toBeUndefined();
    expect(poolOfSlot({ category: "own", route: undefined }, true)).toBeUndefined();
  });

  test("an imported avatar's routed slot gets the pool without the implied covers", () => {
    expect(implied(poolOfSlot({ category: "home", route: "seedream" }, false) ?? POOLS.home)).toEqual([]);
    expect(implied(poolOfSlot({ category: "home", route: "seedream" }, true) ?? POOLS.home).length).toBeGreaterThan(0);
  });

  test("every companion is named by a bank the shared lookup knows", () => {
    for (const category of ORDINARY_BUILT_INS) expect(BOLD_COMPANIONS[category].places.length).toBeGreaterThan(0);
  });
});
