import { describe, expect, test } from "bun:test";
import type { LegwearSlot } from "./banks/types";
import { atSlotLevel, flirtyCountOf, legwearAt, levelCountsOf, seedreamRoute } from "./level";

describe("flirtyCountOf (I5.28)", () => {
  test.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [10, 6],
    [12, 7],
    [100, 60],
  ])("%i slots under «Кокетливая» hold %i flirty ones", (slots, flirty) => {
    expect(flirtyCountOf(slots, "flirty")).toBe(flirty);
  });

  test("«Обычная» holds none, and so does an absent level", () => {
    expect(flirtyCountOf(10, "ordinary")).toBe(0);
    expect(flirtyCountOf(10)).toBe(0);
  });

  test("agrees with rounding 0.6 × n for every n up to 1000", () => {
    for (let n = 0; n <= 1000; n++) expect(flirtyCountOf(n, "flirty")).toBe(Math.round(n * 0.6));
  });

  test.each([-1, 1.5, Number.NaN])("a slot count of %p is refused", (slots) => {
    expect(() => flirtyCountOf(slots, "flirty")).toThrow(RangeError);
  });
});

// 5a.3 (S5.9c, plan s5a3 I5.36): inside a «Смелая» category the mix is 20 / 40 / 40 (ordinary / flirty / bold), exact by integer arithmetic.
describe("levelCountsOf (I5.36)", () => {
  test.each([
    [0, { bold: 0, flirty: 0, ordinary: 0 }],
    [1, { bold: 0, flirty: 1, ordinary: 0 }],
    [2, { bold: 1, flirty: 1, ordinary: 0 }],
    [3, { bold: 1, flirty: 1, ordinary: 1 }],
    [5, { bold: 2, flirty: 2, ordinary: 1 }],
    [6, { bold: 2, flirty: 3, ordinary: 1 }],
    [10, { bold: 4, flirty: 4, ordinary: 2 }],
    [12, { bold: 5, flirty: 5, ordinary: 2 }],
    [100, { bold: 40, flirty: 40, ordinary: 20 }],
  ])("%i slots are bold / flirty / ordinary as %o", (slots, counts) => {
    expect(levelCountsOf(slots)).toEqual(counts);
  });

  test("for every n up to 1000 the three counts add up to n, bold is floor((4n+5)/10) and non-ordinary floor((8n+5)/10)", () => {
    for (let n = 0; n <= 1000; n++) {
      const { bold, flirty, ordinary } = levelCountsOf(n);
      expect(bold + flirty + ordinary).toBe(n);
      expect(bold).toBe(Math.floor((4 * n + 5) / 10));
      expect(bold + flirty).toBe(Math.floor((8 * n + 5) / 10));
      expect(Math.min(bold, flirty, ordinary)).toBeGreaterThanOrEqual(0);
    }
  });

  test.each([-1, 1.5, Number.NaN])("a slot count of %p is refused", (slots) => {
    expect(() => levelCountsOf(slots)).toThrow(RangeError);
  });
});

describe("legwearAt (M3)", () => {
  const plain: LegwearSlot = { items: ["thigh-high socks"], share: 0.3 };
  const withBold: LegwearSlot = { ...plain, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a satin slip nightdress"] } };

  test("a bold slot of a bank with bold stockings reads that list, with its outfits, share and route", () => {
    expect(legwearAt(withBold, "bold")).toEqual({ items: ["sheer black stockings"], share: 0.5, outfits: ["a satin slip nightdress"], route: "seedream" });
  });

  test("an ordinary or flirty slot of the same bank reads the bank's own list and never the stockings", () => {
    for (const level of ["ordinary", "flirty"] as const) expect(legwearAt(withBold, level)).toEqual({ items: ["thigh-high socks"], share: 0.3 });
  });

  test("a bank without bold stockings reads its own list at every level", () => {
    for (const level of ["ordinary", "flirty", "bold"] as const) expect(legwearAt(plain, level)).toEqual({ items: ["thigh-high socks"], share: 0.3 });
  });

  test("a bank without legwear has none", () => {
    expect(legwearAt(undefined, "bold")).toBeUndefined();
  });
});

describe("atSlotLevel (I5.37)", () => {
  const items = [{ n: "a" }, { n: "b", level: "flirty" as const }, { n: "c", level: "bold" as const }, { n: "d", level: "bold" as const }];
  const names = (list: readonly { n: string }[]): string[] => list.map((i) => i.n);

  test.each([
    ["ordinary", ["a"]],
    ["flirty", ["b"]],
    ["bold", ["c", "d"]],
  ] as const)("a %s slot takes the items of its own level", (slot, expected) => {
    expect(names(atSlotLevel(items, (i) => i.level, slot))).toEqual([...expected]);
  });

  test("a slot whose own level has no item takes the highest level below it that has some, never one above", () => {
    expect(names(atSlotLevel([{ n: "a" }, { n: "c", level: "bold" as const }], (i) => i.level, "flirty"))).toEqual(["a"]);
    expect(names(atSlotLevel([{ n: "b", level: "flirty" as const }], (i) => i.level, "bold"))).toEqual(["b"]);
  });

  test("nothing at or below the slot's level is an empty list", () => {
    expect(atSlotLevel([{ n: "c", level: "bold" as const }], (i) => i.level, "flirty")).toEqual([]);
  });

  test("a list with no level on any item comes back whole and in its order, at every slot level", () => {
    const plain = ["x", "y", "z"];
    for (const slot of ["ordinary", "flirty", "bold"] as const) expect(atSlotLevel(plain, () => undefined, slot)).toEqual(plain);
  });
});

describe("seedreamRoute (I5.38)", () => {
  test("a slot is on Seedream exactly when its moment, its outfit or its stockings is", () => {
    expect(seedreamRoute({}, undefined)).toBeUndefined();
    expect(seedreamRoute({}, {})).toBeUndefined();
    expect(seedreamRoute({ route: "seedream" }, {})).toBe("seedream");
    expect(seedreamRoute({}, { route: "seedream" })).toBe("seedream");
    expect(seedreamRoute({}, {}, "seedream")).toBe("seedream");
  });
});
