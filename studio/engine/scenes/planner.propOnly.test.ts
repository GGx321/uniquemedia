import { describe, expect, test } from "bun:test";
import type { CategoryPool } from "../../shared/engine";
import { sceneCategory } from "../runs/plan";
import { planWithPools } from "./planner";
import { isPropOnlyActivity, poolOf } from "./poolGen";
import { BOLD_POOLS, CUSTOM_BOLD_POOLS, POOLS, PoolSchema, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// FU-CLIP B (canary C5c, 2026-10-26; the owner: «Чего она со стаканом воды стоит?»). The C3′ rule drops an activity that only holds a thing when a pool is GENERATED
// (poolGen.ts `readPlace`), but a pool stored before it never went through it: the owner's «В домашнем» (generated 2026-10-11) still holds «holding a water glass»,
// «holding a book bag» and «holding a ceramic mug», and drew one today. `poolOf` is the one door a stored pool takes into the planner, «Другая сцена» (reviewPlan.ts)
// and the price's coverage, so it drops them there; the review UI keeps showing the stored pool.

const REF = "cat-home-lounging-fixture" as const;
const one = (text: string) => ({ text, twoHanded: false });
const two = (text: string) => ({ text, twoHanded: true });
const PROPS = ["holding a water glass", "holding a book bag", "holding a ceramic mug"];

/** A pool stored before the C3′ rule, shaped like the owner's «В домашнем» (copied by hand; no library is read): three places hold one prop-only activity each. */
const STORED: CategoryPool = {
  locations: [
    { name: "a kitchen counter", times: ["morning", "midday"], activities: [one("holding a water glass"), two("slicing an apple"), one("leaning on the counter")], mirror: false },
    { name: "a hallway by the door", times: ["evening"], activities: [one("holding a book bag"), two("tying her shoelaces"), one("tucking her hair back")], mirror: true },
    { name: "a sunny windowsill", times: ["midday", "golden hour"], activities: [one("holding a ceramic mug"), one("holding her coffee")], mirror: false },
    { name: "a living room rug", times: ["evening", "night"], activities: [two("holding a plank"), one("stretching her arms")], mirror: false },
    { name: "a cozy sofa", times: ["night"], activities: [one("hugging a cushion"), one("resting her head on her hand")], mirror: false },
  ],
  outfits: ["an oversized tee and shorts", "a cotton hoodie and joggers", "a linen shirt and leggings"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};

const textsOf = (pool: Pool, place: string): string[] => pool.locations.find((l) => l.name === place)?.activities.map((a) => a.text) ?? [];

describe("poolOf drops a stored pool's prop-only activities (FU-CLIP B)", () => {
  test("«holding a water glass», «holding a book bag» and «holding a ceramic mug» are gone from their places", () => {
    const pool = poolOf(STORED);
    expect(textsOf(pool, "a kitchen counter")).toEqual(["slicing an apple", "leaning on the counter"]);
    expect(textsOf(pool, "a hallway by the door")).toEqual(["tying her shoelaces", "tucking her hair back"]);
    expect(textsOf(pool, "a sunny windowsill")).toEqual(["holding her coffee"]);
  });

  test("«holding her coffee» and «holding a plank» stay: her own thing in use, and a position", () => {
    const pool = poolOf(STORED);
    expect(textsOf(pool, "a sunny windowsill")).toContain("holding her coffee");
    expect(textsOf(pool, "a living room rug")).toEqual(["holding a plank", "stretching her arms"]);
  });

  test("the pool it gives is still a valid engine pool, every place kept", () => {
    const pool = poolOf(STORED);
    expect(PoolSchema.safeParse(pool).success).toBe(true);
    expect(pool.locations.map((l) => l.name)).toEqual(STORED.locations.map((l) => l.name));
  });

  // poolGen.ts: «Every place needs at least one free-hand activity that does not use her phone». A place whose props are its only such activity keeps every activity as
  // stored, props included, rather than lose its selfie and mirror shots or the place itself.
  test.each([
    ["a phone activity beside the prop", [one("holding a water glass"), one("texting on her phone")]],
    ["a two-handed activity beside the prop", [one("holding a ceramic mug"), two("cooking breakfast")]],
    ["nothing but props", [one("holding a water glass"), one("holding a book bag")]],
  ] as const)("a place left with no free-hand activity off her phone keeps its activities as stored: %s", (_name, activities) => {
    const stored: CategoryPool = { ...STORED, locations: [{ name: "a small balcony", times: ["morning"], activities: [...activities], mirror: false }, ...STORED.locations.slice(1)] };
    expect(textsOf(poolOf(stored), "a small balcony")).toEqual(activities.map((a) => a.text));
  });
});

describe("the planner and «Другая сцена» never draw them (FU-CLIP B)", () => {
  const pools = { ...POOLS, [REF]: poolOf(STORED) };

  function plannedActivities(): Set<string> {
    const drawn = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      for (const slot of planWithPools({ seed, count: 10, categories: [sceneCategory(REF)] }, pools).slots) drawn.add(slot.activity);
    }
    return drawn;
  }

  test("200 seeds plan none of the three", () => {
    const drawn = plannedActivities();
    expect(PROPS.filter((text) => drawn.has(text))).toEqual([]);
  });

  test("«holding her coffee» and «holding a plank» still plan", () => {
    const drawn = plannedActivities();
    expect(drawn.has("holding her coffee")).toBe(true);
    expect(drawn.has("holding a plank")).toBe(true);
  });

  test("200 redraws of a planned scene draw none of the three", () => {
    const slots = planWithPools({ seed: 7, count: 10, categories: [sceneCategory(REF)] }, pools).slots;
    const drawn = new Set<string>();
    for (const slot of slots) {
      for (let k = 1; k <= 20; k++) drawn.add(redrawSlot({ seed: 7, k, slot, pool: poolOf(STORED), avoid: { locations: new Set(), outfits: new Set() } }).activity);
    }
    expect(PROPS.filter((text) => drawn.has(text))).toEqual([]);
    expect(drawn.size).toBeGreaterThan(3);
  });
});

describe("the built-in banks are unaffected (FU-CLIP B)", () => {
  test("no built-in, «Смелая» companion or custom «Смелая» pool holds a prop-only activity, so the rule could not touch one", () => {
    const pools = [...Object.values(POOLS), ...Object.values(BOLD_POOLS), ...Object.values(CUSTOM_BOLD_POOLS)];
    const props = pools.flatMap((pool) => pool.locations.flatMap((place) => place.activities.filter((a) => isPropOnlyActivity(a.text)).map((a) => `${place.name}: ${a.text}`)));
    expect(props).toEqual([]);
  });
});
