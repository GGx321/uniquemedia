import { describe, expect, test } from "bun:test";
import { mustHold, seedOutcomes } from "./seedOutcomes";

describe("seedOutcomes", () => {
  test("walks a seed once, however many callers ask for it", async () => {
    let walks = 0;
    const outcome = seedOutcomes<number, string[]>(
      () => [],
      async (seed, seen) => {
        walks++;
        seen.push(`seed ${seed}`);
      },
    );
    await Promise.all([outcome(1), outcome(1)]);
    await outcome(1);
    expect(walks).toBe(1);
  });

  test("gives a caller that comes first the same collection as one that comes later", async () => {
    const outcome = seedOutcomes<number, Set<string>>(
      () => new Set(),
      async (seed, seen) => void seen.add(`path ${seed}`),
    );
    const first = await outcome(7);
    const later = await outcome(7);
    expect([...first.collected]).toEqual(["path 7"]);
    expect(later).toBe(first);
  });

  test("keeps what a walk collected before it threw, and the error", async () => {
    const outcome = seedOutcomes<number, string[]>(
      () => [],
      async (_seed, seen) => {
        seen.push("grok");
        throw new Error("invariant broken");
      },
    );
    const settled = await outcome(3);
    expect(settled.collected).toEqual(["grok"]);
    expect(settled.failure?.error).toBeInstanceOf(Error);
  });

  test("mustHold rethrows the walk's own error for the seed's test", async () => {
    const outcome = seedOutcomes<number, string[]>(
      () => [],
      async () => {
        throw new Error("invariant broken");
      },
    );
    await expect(mustHold(outcome(3))).rejects.toThrow("invariant broken");
  });

  test("mustHold returns the collection of a walk that held", async () => {
    const outcome = seedOutcomes<number, string[]>(
      () => [],
      async (_seed, seen) => void seen.push("429"),
    );
    expect(await mustHold(outcome(1))).toEqual(["429"]);
  });

  test("keeps the collections of different seeds apart", async () => {
    const outcome = seedOutcomes<number, string[]>(
      () => [],
      async (seed, seen) => void seen.push(`seed ${seed}`),
    );
    expect((await outcome(1)).collected).toEqual(["seed 1"]);
    expect((await outcome(2)).collected).toEqual(["seed 2"]);
  });
});
