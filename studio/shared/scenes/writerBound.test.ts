import { describe, expect, test } from "bun:test";
import { SCENE_CHUNK_SIZE, type CategoryRef } from "../engine";
import { llmPossibleSlots, writerChunksWorst, type SplitEntry } from "./writerBound";

// 5a.2 (S5.6c2, plan s5a2 §5.6, I5.30): the ONE bound on how many writer requests a plan can need. A built-in category, and a custom one whose pool the
// template covers, renders every slot in code; only the slots of an uncovered custom category can go to the model. The plan draws each category as one
// contiguous block of slots (the canonical order), and the writer's chunks cut the plan every SCENE_CHUNK_SIZE slots, so a chunk needs a request exactly
// when it holds one of those slots. The bound never sees the order, so it takes the worst: a block of m slots touches at most ⌈m/25⌉ + 1 chunks.

const BUILT_INS = ["home", "travel", "shoot", "glam", "fit"] as const;
const customRef = (i: number): CategoryRef => `cat-fixture-${i}00000` as CategoryRef;

describe("writerChunksWorst", () => {
  test("is 0 when every category is a built-in", () => {
    const split: SplitEntry[] = BUILT_INS.map((ref) => ({ ref, count: 20 }));
    expect(writerChunksWorst(split, () => false)).toBe(0);
  });

  test("is 0 for a custom category the template covers", () => {
    expect(writerChunksWorst([{ ref: "home", count: 30 }, { ref: customRef(1), count: 30 }], () => true)).toBe(0);
  });

  test("ignores a covers answer for a built-in: built-ins are always covered", () => {
    expect(writerChunksWorst([{ ref: "home", count: 100 }], () => false)).toBe(0);
  });

  test("is 0 for an empty split", () => {
    expect(writerChunksWorst([], () => false)).toBe(0);
  });

  test("prices Home 50 plus an uncovered custom 50 at 3 chunks, not the 4 of an all-model plan", () => {
    expect(writerChunksWorst([{ ref: "home", count: 50 }, { ref: customRef(1), count: 50 }], () => false)).toBe(3);
  });

  test("counts one extra chunk for a block that may straddle a boundary", () => {
    expect(writerChunksWorst([{ ref: "home", count: 40 }, { ref: customRef(1), count: 10 }], () => false)).toBe(2);
  });

  test("never asks for more chunks than the plan has", () => {
    expect(writerChunksWorst([{ ref: customRef(1), count: 3 }], () => false)).toBe(1);
    expect(writerChunksWorst([{ ref: customRef(1), count: 25 }], () => false)).toBe(1);
    expect(writerChunksWorst([{ ref: customRef(1), count: 26 }], () => false)).toBe(2);
  });

  test("a category with 0 slots adds nothing", () => {
    expect(writerChunksWorst([{ ref: "home", count: 10 }, { ref: customRef(1), count: 0 }], () => false)).toBe(0);
  });

  test("covers is asked per custom category", () => {
    const covered = customRef(1);
    const open = customRef(2);
    const split: SplitEntry[] = [{ ref: covered, count: 25 }, { ref: open, count: 25 }];
    expect(writerChunksWorst(split, (ref) => ref === covered)).toBe(2);
  });

  // The brute force: build the plan the way the planner does (a contiguous block per category, in some order), cut it into chunks of SCENE_CHUNK_SIZE
  // and count the chunks that hold an uncovered slot, for every order of the blocks. The bound may never be below the worst of them, and never above
  // the plan's chunk count.
  function trueWorst(counts: readonly number[], uncovered: readonly boolean[], order: readonly number[]): number {
    const chunks = new Set<number>();
    let position = 0;
    for (const index of order) {
      const count = counts[index] ?? 0;
      if (uncovered[index] === true) for (let i = 0; i < count; i++) chunks.add(Math.floor((position + i) / SCENE_CHUNK_SIZE));
      position += count;
    }
    return chunks.size;
  }

  function permutations(k: number): number[][] {
    if (k === 0) return [[]];
    return permutations(k - 1).flatMap((rest) => Array.from({ length: k }, (_, at) => [...rest.slice(0, at), k - 1, ...rest.slice(at)]));
  }

  function compositions(n: number, k: number): number[][] {
    if (k === 1) return [[n]];
    const out: number[][] = [];
    for (let first = 0; first <= n; first++) for (const rest of compositions(n - first, k - 1)) out.push([first, ...rest]);
    return out;
  }

  function check(counts: readonly number[], orders: readonly (readonly number[])[]): void {
    const k = counts.length;
    const n = counts.reduce((a, b) => a + b, 0);
    for (let mask = 0; mask < 1 << k; mask++) {
      const uncovered = counts.map((_, i) => (mask & (1 << i)) !== 0);
      const split: SplitEntry[] = counts.map((count, i) => ({ ref: customRef(i), count }));
      const bound = writerChunksWorst(split, (ref) => !uncovered[split.findIndex((s) => s.ref === ref)]);
      const cap = Math.ceil(n / SCENE_CHUNK_SIZE);
      let worst = 0;
      for (const order of orders) worst = Math.max(worst, trueWorst(counts, uncovered, order));
      if (bound < worst || bound > cap) throw new Error(`counts ${counts.join("+")} mask ${mask}: bound ${bound}, true worst ${worst}, cap ${cap}`);
    }
  }

  test("is never below the true worst over every order, and never above the plan's chunks (n up to 100, up to 3 categories, every mask)", () => {
    for (let k = 1; k <= 3; k++) {
      const orders = permutations(k);
      for (let n = 0; n <= 100; n++) for (const counts of compositions(n, k)) check(counts, orders);
    }
  });

  test("is never below the true worst over every order, and never above the plan's chunks (4 and 5 categories, every mask)", () => {
    for (const [k, top] of [[4, 30], [5, 16]] as const) {
      const orders = permutations(k).filter((_, i) => i % 9 === 0);
      for (let n = 0; n <= top; n++) for (const counts of compositions(n, k)) check(counts, orders);
    }
  });

  test("is never below the true worst with the 100-photo splits of 5 categories (every mask, coarse counts)", () => {
    const orders = permutations(5).filter((_, i) => i % 11 === 0);
    for (const counts of compositions(20, 5)) check(counts.map((c) => c * 5), orders);
  });
});

describe("llmPossibleSlots", () => {
  test("sums the slots of the uncovered custom categories only", () => {
    const open = customRef(2);
    const split: SplitEntry[] = [{ ref: "home", count: 20 }, { ref: customRef(1), count: 15 }, { ref: open, count: 10 }];
    expect(llmPossibleSlots(split, (ref) => ref !== open)).toBe(10);
  });

  test("is 0 when nothing can go to the model", () => {
    expect(llmPossibleSlots([{ ref: "home", count: 20 }], () => false)).toBe(0);
  });

  test("never exceeds the count that the bound's chunks can hold", () => {
    const split: SplitEntry[] = [{ ref: customRef(1), count: 7 }];
    expect(llmPossibleSlots(split, () => false)).toBeLessThanOrEqual(writerChunksWorst(split, () => false) * SCENE_CHUNK_SIZE);
  });
});
