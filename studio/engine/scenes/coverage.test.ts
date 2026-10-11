import { describe, expect, test } from "bun:test";
import { CategoryPool as CategoryPoolSchema, type CategoryPool } from "../../shared/engine";
import { covers } from "../../shared/scenes/custom";
import { coversOfStored } from "./coverage";
import { poolOf } from "./poolGen";
import { PoolSchema } from "./pools";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();
import { LLM_ONLY_CATEGORY_POOL, LLM_ONLY_POOL, LLM_ONLY_REF } from "./testing/llmOnlyFixture";

/** A pool whose every activity reads after «she is» and whose shots are a friend's: the template writes all of it. */
const GERUND_POOL: CategoryPool = {
  locations: ["a quiet bookshop", "a flower stall", "a corner cafe", "a bridge over the river", "a sunny terrace"].map((name) => ({
    name,
    times: ["midday" as const],
    activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }],
    mirror: false,
  })),
  outfits: ["a cozy cardigan", "jeans and a tee", "a linen dress"],
  shotDeck: ["friend", "friend", "friend", "friend", "friend"],
};

describe("coversOfStored", () => {
  test("the test-only fixture is a valid stored pool the template cannot write", () => {
    expect(() => CategoryPoolSchema.parse(LLM_ONLY_CATEGORY_POOL)).not.toThrow();
    // The library only keeps a pool the engine's own rules accept (no youth word in a text, etc.): a fixture it would refuse could not be seeded.
    expect(PoolSchema.safeParse(LLM_ONLY_POOL).success).toBe(true);
    expect(covers(LLM_ONLY_POOL)).toBe(false);
  });

  test("says a stored category is not covered when its activities do not render", () => {
    const coversOf = coversOfStored([{ categoryId: LLM_ONLY_REF, pool: LLM_ONLY_CATEGORY_POOL }]);

    expect(coversOf(LLM_ONLY_REF)).toBe(false);
  });

  test("says a stored category is covered when the template renders every slot its pool can draw", () => {
    const ref = "cat-gerund-fixture" as const;

    expect(() => CategoryPoolSchema.parse(GERUND_POOL)).not.toThrow();
    expect(covers(poolOf(GERUND_POOL))).toBe(true);
    expect(coversOfStored([{ categoryId: ref, pool: GERUND_POOL }])(ref)).toBe(true);
  });

  test("a custom ref the library did not return is not covered", () => {
    expect(coversOfStored([])("cat-unknown-one")).toBe(false);
  });

  test("answers per category", () => {
    const other = "cat-gerund-fixture" as const;
    const coversOf = coversOfStored([
      { categoryId: LLM_ONLY_REF, pool: LLM_ONLY_CATEGORY_POOL },
      { categoryId: other, pool: GERUND_POOL },
    ]);

    expect([coversOf(LLM_ONLY_REF), coversOf(other)]).toEqual([false, true]);
  });
});
