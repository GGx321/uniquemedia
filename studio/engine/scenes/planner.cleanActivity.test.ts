import { describe, expect, test } from "bun:test";
import { planWithPools } from "./planner";
import { isPhoneActivity, POOLS, type Pool } from "./pools";
import { redrawSlot } from "./redraw";
import type { PlanSlot } from "./schema";
import { OWNER_LIKE_POOL } from "./testing/ownerLikePool";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.R1 round 3: a selfie or a mirror shot never draws a phone activity. The writer is told «her own phone appears only when the slot's activity uses it» and the reader refuses a phone
// in a selfie sentence, so a selfie on a phone activity was a near-certain paid re-ask (and a second refusal fails the run). A place with no clean activity is not used for those
// shots; when no place of the pool is clean, the slot becomes a friend's snap, where her phone in use is fine.

const CUSTOM = "cat-home-lounging";
const POOLS_WITH = (pool: Pool): Record<string, Pool> => ({ ...POOLS, [CUSTOM]: pool });
const plan = (pool: Pool, seed: number, count = 25): PlanSlot[] => planWithPools({ seed, count, categories: [CUSTOM], poses: { profile: true, back: true } }, POOLS_WITH(pool)).slots;
const handShot = (slot: PlanSlot): boolean => slot.shot === "selfie" || slot.shot === "mirror";
const activityOf = (pool: Pool, slot: PlanSlot) => pool.locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
const SEEDS = Array.from({ length: 1000 }, (_, i) => i * 7919 + 13);

/** Every place has only phone or two-handed activities: no place is clean. */
const NO_CLEAN_POOL: Pool = {
  locations: [
    { name: "a living room rug", times: ["midday"], mirror: true, activities: [{ text: "scrolling on a phone", twoHanded: false }, { text: "flipping through a book", twoHanded: true }] },
    { name: "a wide bed", times: ["morning"], activities: [{ text: "texting a friend", twoHanded: false }, { text: "folding laundry", twoHanded: true }] },
  ],
  outfits: ["an oversized tee and shorts", "a cotton hoodie and joggers"],
  shotDeck: ["friend", "candid", "selfie", "mirror", "candid"],
};

describe("the planner: a selfie or mirror never draws a phone activity", () => {
  test("on the owner-like pool, 1000 seeds of 25 slots: no selfie or mirror slot has a phone or a two-handed activity", () => {
    let handShots = 0;
    for (const seed of SEEDS) {
      for (const slot of plan(OWNER_LIKE_POOL, seed).filter(handShot)) {
        handShots++;
        const activity = activityOf(OWNER_LIKE_POOL, slot);
        expect(activity).toBeDefined();
        expect(activity !== undefined && isPhoneActivity(activity)).toBe(false);
        expect(activity?.twoHanded).toBe(false);
      }
    }
    expect(handShots).toBeGreaterThan(1000);
  });

  test("the place the pool's phone rug would have been is not used for a selfie or mirror, but the rug is still used by the other shots", () => {
    const slots = SEEDS.slice(0, 200).flatMap((seed) => plan(OWNER_LIKE_POOL, seed));
    expect(slots.filter((s) => handShot(s) && s.location === "a living room rug")).toEqual([]);
    expect(slots.some((s) => !handShot(s) && s.location === "a living room rug")).toBe(true);
  });

  test("a mirror shot stays on a mirror place", () => {
    for (const seed of SEEDS.slice(0, 300)) for (const slot of plan(OWNER_LIKE_POOL, seed).filter((s) => s.shot === "mirror")) expect(slot.location).toBe("a cozy bedroom");
  });

  test("the draw is deterministic: the same seed gives the same plan", () => {
    expect(plan(OWNER_LIKE_POOL, 4242)).toEqual(plan(OWNER_LIKE_POOL, 4242));
  });

  test("the rest of the plan does not move: shots, outfits and poses are those of the same pool with the rug's phone activity made clean", () => {
    const cleaned: Pool = { ...OWNER_LIKE_POOL, locations: OWNER_LIKE_POOL.locations.map((l) => (l.name === "a living room rug" ? { ...l, activities: [{ text: "holding a cup of tea", twoHanded: false }, ...l.activities.slice(1)] } : l)) };
    for (const seed of SEEDS.slice(0, 100)) {
      const fixed = plan(OWNER_LIKE_POOL, seed);
      const clean = plan(cleaned, seed);
      expect(fixed.map((s) => s.shot)).toEqual(clean.map((s) => s.shot));
      expect(fixed.map((s) => s.outfit)).toEqual(clean.map((s) => s.outfit));
      expect(fixed.map((s) => s.pose)).toEqual(clean.map((s) => s.pose));
    }
  });
});

describe("the planner: a pool with no clean place", () => {
  test("its selfie and mirror slots become a friend's snap, and no slot of any shot is on a selfie or mirror", () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const slots = plan(NO_CLEAN_POOL, seed);
      expect(slots.filter(handShot)).toEqual([]);
      expect(slots.some((s) => s.shot === "friend")).toBe(true);
    }
  });

  test("the slots that were not selfie or mirror keep their shot", () => {
    for (const seed of SEEDS.slice(0, 50)) expect(plan(NO_CLEAN_POOL, seed).filter((s) => s.shot === "candid").length).toBeGreaterThan(0);
  });

  test("a friend's snap there may use the phone activity", () => {
    const slots = SEEDS.slice(0, 200).flatMap((seed) => plan(NO_CLEAN_POOL, seed));
    expect(slots.some((s) => s.shot === "friend" && /phone|texting/.test(s.activity))).toBe(true);
  });

  test("a mirror shot with no clean mirror place becomes a selfie on a clean place when the pool has one", () => {
    const pool: Pool = {
      locations: [
        { name: "a hallway", times: ["morning"], mirror: true, activities: [{ text: "texting a friend", twoHanded: false }, { text: "folding laundry", twoHanded: true }] },
        { name: "a window seat", times: ["morning"], activities: [{ text: "holding a cup of tea", twoHanded: false }] },
      ],
      outfits: ["an oversized tee and shorts", "a cotton hoodie and joggers"],
      shotDeck: ["mirror", "mirror", "mirror", "mirror", "mirror"],
    };
    for (const seed of SEEDS.slice(0, 50)) {
      for (const slot of plan(pool, seed)) {
        expect(slot.shot).toBe("selfie");
        expect(slot.location).toBe("a window seat");
        expect(slot.activity).toBe("holding a cup of tea");
      }
    }
  });
});

describe("built-in pools are untouched", () => {
  test("every place of every built-in pool has a free-hand activity that does not use the phone, so the fix never draws for them", () => {
    for (const category of CATEGORIES) {
      for (const place of POOLS[category].locations) {
        expect(place.activities.some((a) => !a.twoHanded && !isPhoneActivity(a))).toBe(true);
      }
    }
  });
});

describe("«Другая сцена» follows the same rule", () => {
  const AVOID = { locations: new Set<string>(), outfits: new Set<string>() };
  const NONE = { profile: false, back: false };
  const slotOf = (shot: PlanSlot["shot"], location: string): PlanSlot => ({
    slotIndex: 1,
    category: CUSTOM,
    location,
    timeOfDay: "midday",
    activity: "x",
    outfit: "an oversized tee and shorts",
    shot,
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
  });

  test.each(["selfie", "mirror"] as const)("a %s redrawn on the owner-like pool never lands on a phone activity, over 1000 seeds", (shot) => {
    for (const seed of SEEDS) {
      const out = redrawSlot({ seed, k: 1 + (seed % 5), slot: slotOf(shot, "a cozy bedroom"), pool: OWNER_LIKE_POOL, avoid: AVOID, poses: NONE });
      const activity = activityOf(OWNER_LIKE_POOL, out);
      expect(out.shot).toBe(shot);
      expect(activity !== undefined && isPhoneActivity(activity)).toBe(false);
      expect(activity?.twoHanded).toBe(false);
    }
  });

  test("on a pool with no clean place a redrawn selfie or mirror becomes a friend's snap", () => {
    for (const shot of ["selfie", "mirror"] as const) {
      for (const seed of SEEDS.slice(0, 50)) {
        expect(redrawSlot({ seed, k: 1, slot: slotOf(shot, "a wide bed"), pool: NO_CLEAN_POOL, avoid: AVOID, poses: NONE }).shot).toBe("friend");
      }
    }
  });
});
