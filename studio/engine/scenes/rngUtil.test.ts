import { describe, expect, test } from "bun:test";
import { Bag, makeRng, shuffle } from "./rngUtil";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

describe("shuffle", () => {
  test("is deterministic for the same seed", () => {
    const a = shuffle(makeRng(1), [1, 2, 3, 4, 5]);
    const b = shuffle(makeRng(1), [1, 2, 3, 4, 5]);
    expect(a).toEqual(b);
  });

  test("differs for a different seed, for this input", () => {
    const a = shuffle(makeRng(1), [1, 2, 3, 4, 5, 6, 7, 8]);
    const b = shuffle(makeRng(2), [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(a).not.toEqual(b);
  });

  test("is a permutation: same elements, same length, as the source", () => {
    const input = ["a", "b", "c", "d"];
    const out = shuffle(makeRng(42), input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  test("does not mutate its input", () => {
    const input = [1, 2, 3];
    shuffle(makeRng(1), input);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("Bag", () => {
  test("refuses an empty source", () => {
    expect(() => new Bag([], makeRng(1))).toThrow(RangeError);
  });

  test("a draw count at the source length never repeats an item", () => {
    const bag = new Bag([1, 2, 3, 4], makeRng(7));
    const drawn = Array.from({ length: 4 }, () => bag.next());
    expect([...drawn].sort()).toEqual([1, 2, 3, 4]);
  });

  test("reshuffles once exhausted, so a draw count over the source length must repeat", () => {
    const bag = new Bag([1, 2], makeRng(3));
    const drawn = Array.from({ length: 5 }, () => bag.next());
    expect(drawn).toHaveLength(5);
    expect(new Set(drawn).size).toBeLessThanOrEqual(2);
    for (const value of drawn) expect([1, 2]).toContain(value);
  });

  test("is deterministic for the same seed", () => {
    const bagA = new Bag(["x", "y", "z"], makeRng(9));
    const bagB = new Bag(["x", "y", "z"], makeRng(9));
    const seqA = Array.from({ length: 7 }, () => bagA.next());
    const seqB = Array.from({ length: 7 }, () => bagB.next());
    expect(seqA).toEqual(seqB);
  });

  test("two bags over the same source drift apart with different seeds", () => {
    const bagA = new Bag(["x", "y", "z", "w"], makeRng(1));
    const bagB = new Bag(["x", "y", "z", "w"], makeRng(2));
    const seqA = Array.from({ length: 4 }, () => bagA.next());
    const seqB = Array.from({ length: 4 }, () => bagB.next());
    expect(seqA).not.toEqual(seqB);
  });
});
