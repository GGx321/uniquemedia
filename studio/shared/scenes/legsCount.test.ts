import { describe, expect, test } from "bun:test";
import { apportionLegs, legsCountOf } from "./level";

// 5a.2c (S5.8a, I5.29): legs slots = min(round-half-up(share × B), ⌊0.3 × count⌋), B = the built-in slots of the run, count = all its slots. Integers only: the share is a
// whole percent, so the rounding is (share × B + 50) div 100, and the cap is (3 × count) div 10. The one rule for the planner and for the card's «{L} из {N} кадров» line.

describe("legsCountOf (I5.29): the formula", () => {
  // [share, built-in slots B, all slots, expected]
  const TABLE: readonly (readonly [0 | 15 | 30, number, number, number])[] = [
    [0, 20, 20, 0],
    [15, 20, 20, 3],
    [30, 20, 20, 6],
    [15, 1, 1, 0],
    [15, 3, 3, 0],
    [15, 4, 4, 1],
    [15, 10, 10, 2],
    [15, 12, 12, 2],
    [15, 100, 100, 15],
    [30, 1, 1, 0],
    [30, 2, 2, 0],
    [30, 5, 5, 1],
    [30, 12, 12, 3],
    [30, 100, 100, 30],
    // The cap bites where the rounding goes up: 0.3 × 5 = 1.5 rounds to 2, the cap is 1.
    [30, 5, 5, 1],
    [30, 15, 15, 4],
    // Custom slots count in the cap but not in B: 6 of 10 built-in slots at 30 % is 2 (1.8), the cap of 10 is 3.
    [30, 6, 10, 2],
    [30, 10, 20, 3],
    [15, 10, 20, 2],
    // The cap of the whole run holds when the built-ins are few: 100 % built-in only reaches it at 30.
    [30, 7, 7, 2],
  ];

  test.each(TABLE)("share %i %% of %i built-in slots among %i slots makes %i legs slots", (share, builtIn, total, expected) => {
    expect(legsCountOf(share, builtIn, total)).toBe(expected);
  });

  test("rounds half up: 15 % of 10 is 1.5, which makes 2; 15 % of 30 is 4.5, which makes 5", () => {
    expect(legsCountOf(15, 10, 100)).toBe(2);
    expect(legsCountOf(15, 30, 100)).toBe(5);
  });

  test("never more than ⌊0.3 × count⌋ for any share, built-in count and count", () => {
    for (const share of [0, 15, 30] as const) {
      for (let total = 0; total <= 100; total++) {
        for (let builtIn = 0; builtIn <= total; builtIn++) expect(legsCountOf(share, builtIn, total)).toBeLessThanOrEqual(Math.floor((3 * total) / 10));
      }
    }
  });

  test("never more than the built-in slots, and 0 at share 0 or with no built-in slot", () => {
    for (const share of [0, 15, 30] as const) {
      for (let total = 0; total <= 60; total++) {
        for (let builtIn = 0; builtIn <= total; builtIn++) expect(legsCountOf(share, builtIn, total)).toBeLessThanOrEqual(builtIn);
      }
    }
    expect(legsCountOf(0, 50, 50)).toBe(0);
    expect(legsCountOf(30, 0, 50)).toBe(0);
  });

  test("a share that is not a chip, a negative count and a built-in count above the total are refused", () => {
    expect(() => legsCountOf(20 as 15, 10, 10)).toThrow(RangeError);
    expect(() => legsCountOf(15, -1, 10)).toThrow(RangeError);
    expect(() => legsCountOf(15, 1.5, 10)).toThrow(RangeError);
    expect(() => legsCountOf(15, 11, 10)).toThrow(RangeError);
  });
});

describe("apportionLegs: the legs slots over the built-in categories (largest remainder)", () => {
  test("splits in proportion to each category's slots, and the parts add up to the total", () => {
    // quotas 1.2, 0.6, 0.6, 0, 0.6: the floors take 1, the two largest remainders (the first of the equal ones win) take the other 2.
    expect(apportionLegs(3, [12, 6, 6, 0, 6])).toEqual([1, 1, 1, 0, 0]);
    const parts = apportionLegs(6, [10, 10, 10, 10, 10]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(6);
  });

  test("each part is the floor or the ceiling of its exact quota", () => {
    for (const counts of [[12, 6, 6, 6, 6], [1, 1, 1, 1, 1], [20, 0, 0, 0, 0], [7, 5, 3, 2, 1], [0, 0, 9, 0, 3]]) {
      const built = counts.reduce((a, b) => a + b, 0);
      for (let total = 0; total <= built; total++) {
        const parts = apportionLegs(total, counts);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        parts.forEach((part, i) => {
          const quota = (total * (counts[i] ?? 0)) / built;
          expect(part).toBeGreaterThanOrEqual(Math.floor(quota));
          expect(part).toBeLessThanOrEqual(Math.ceil(quota));
          expect(part).toBeLessThanOrEqual(counts[i] ?? 0);
        });
      }
    }
  });

  test("the ties of the remainders go to the order it is given", () => {
    // 1 legs slot over three equal categories: each quota is 1/3, so the tie order decides.
    expect(apportionLegs(1, [4, 4, 4], [2, 0, 1])).toEqual([0, 0, 1]);
    expect(apportionLegs(1, [4, 4, 4], [1, 2, 0])).toEqual([0, 1, 0]);
    expect(apportionLegs(2, [4, 4, 4], [1, 2, 0])).toEqual([0, 1, 1]);
  });

  test("a total above the slots there are is refused", () => {
    expect(() => apportionLegs(5, [2, 2])).toThrow(RangeError);
  });

  test("no slots and no legs slots is all zeros", () => {
    expect(apportionLegs(0, [0, 0])).toEqual([0, 0]);
    expect(apportionLegs(0, [3, 5])).toEqual([0, 0]);
  });
});
