import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Bag, fnv1a, makeRng, shuffle, subSeed } from "./rngUtil";
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

// S5.1a: the hash helpers live here (the look module draws from them too). The values below were taken from the helpers while they were still in
// planner.ts, so a move that changed one bit fails here before it moves a plan.
describe("fnv1a", () => {
  test.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("hashes %p to the published 32-bit FNV-1a value", (text, expected) => {
    expect(fnv1a(text)).toBe(expected);
  });
});

describe("subSeed", () => {
  test.each([
    [0, "", 431477908],
    [0, "home", 667922642],
    [1, "home", 1699764405],
    [42, "pose:travel", 4119444009],
    [4294967295, "redraw:3:2", 3912062691],
    [2026, "own:1", 1025459460],
    [7, "a1b2c3:slot-4:imperfection", 1264880904],
  ])("gives subSeed(%p, %p) the value it had in planner.ts", (seed, discriminator, expected) => {
    expect(subSeed(seed, discriminator)).toBe(expected);
  });
});

describe("one home for the hash helpers", () => {
  const read = (name: string): string => readFileSync(join(import.meta.dir, name), "utf8");

  // autopilot/planner.ts keeps its own, different fnv1a over several parts; this only looks inside scenes/.
  test.each(["planner.ts", "redraw.ts", "assembler.ts"])("%s defines neither fnv1a nor subSeed", (name) => {
    expect(read(name)).not.toMatch(/function\s+(fnv1a|subSeed)\b/);
  });

  test("redraw.ts takes subSeed from rngUtil, not from the planner", () => {
    expect(read("redraw.ts")).toMatch(/import\s*\{[^}]*\bsubSeed\b[^}]*\}\s*from\s*"\.\/rngUtil"/);
  });
});
