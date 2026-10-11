import { describe, expect, test } from "bun:test";
import { flirtyCountOf } from "./level";

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
