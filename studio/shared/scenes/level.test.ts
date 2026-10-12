import { describe, expect, test } from "bun:test";
import { flirtyCountOf, levelCountsOf } from "./level";

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
