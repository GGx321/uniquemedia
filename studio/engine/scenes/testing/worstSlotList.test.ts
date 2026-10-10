import { describe, expect, test } from "bun:test";
import { slotList } from "../writer";
import { worstSlotList } from "./worstSlotList";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
useNativeGlobals();

// The floor pins stand on `worstSlotList` finding the longest told list, so it is checked against every subset, over sets that cross a digit boundary and sets with gaps.

const lengthOf = (indices: readonly number[]): number => slotList(indices).length;

function longestByBruteForce(candidates: readonly number[]): number {
  let longest = 0;
  for (let mask = 0; mask < 1 << candidates.length; mask++) {
    const subset = candidates.filter((_, i) => (mask & (1 << i)) !== 0);
    longest = Math.max(longest, lengthOf(subset));
  }
  return longest;
}

describe("worstSlotList", () => {
  test.each([
    ["a run of ten", Array.from({ length: 10 }, (_, i) => 20 + i)],
    ["across the 99-100 boundary", [95, 96, 97, 98, 99, 100, 101, 102]],
    ["with gaps", [3, 4, 5, 9, 10, 11, 12, 20]],
    ["a single number", [7]],
    ["nothing", []],
    ["alternating gaps of one and two", [1, 2, 4, 5, 7, 8, 10, 11, 13, 14]],
    ["the last chunk's own width, cut to fit the search", Array.from({ length: 16 }, (_, i) => 85 + i)],
  ] as Array<[string, number[]]>)("finds the longest told list of %s, the same as trying every subset", (_name, candidates) => {
    expect(lengthOf(worstSlotList(candidates))).toBe(longestByBruteForce(candidates));
  });

  test("it is a subset of the candidates, ascending", () => {
    const candidates = Array.from({ length: 25 }, (_, i) => 76 + i);
    const worst = worstSlotList(candidates);
    expect(worst.every((n) => candidates.includes(n))).toBe(true);
    expect([...worst].sort((a, b) => a - b)).toEqual(worst);
  });

  test("over a whole chunk (76..100) it is dearer than every other slot, which is the pattern the first pins assumed", () => {
    const candidates = Array.from({ length: 25 }, (_, i) => 76 + i);
    const everyOther = candidates.filter((_, i) => i % 2 === 0);
    expect(lengthOf(worstSlotList(candidates))).toBeGreaterThan(lengthOf(everyOther));
  });

  test("a list told in full costs a range of the same slots less", () => {
    expect(lengthOf([76, 77, 78, 79])).toBeLessThan(lengthOf([76, 78, 80, 82]));
  });
});

describe("slotList", () => {
  test("tells a run as a range, the others one by one, with no space after a comma", () => {
    expect(slotList([1, 2, 3, 7, 9, 10])).toBe("1-3,7,9-10");
  });

  test("a single number and an empty list", () => {
    expect(slotList([4])).toBe("4");
    expect(slotList([])).toBe("");
  });

  test("keeps the order it was given", () => {
    expect(slotList([9, 3, 4])).toBe("9,3-4");
  });
});
