import { describe, expect, test } from "bun:test";
import { CATEGORIES } from "./types";
import { POOLS } from "./pools";
import { plan, placeMirrorShots, planWithPools, type ExcludedPair } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const ALL_CATEGORIES = [...CATEGORIES];
const REVEALING = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;

function placeOf(category: (typeof ALL_CATEGORIES)[number], location: string) {
  const place = POOLS[category].locations.find((l) => l.name === location);
  if (!place) throw new Error(`no location "${location}" in ${category}`);
  return place;
}

describe("determinism", () => {
  test("the same seed produces the same plan", () => {
    const a = plan({ seed: 20260924, count: 20, categories: ALL_CATEGORIES });
    const b = plan({ seed: 20260924, count: 20, categories: ALL_CATEGORIES });
    expect(a).toEqual(b);
  });

  test("a different seed produces a different plan", () => {
    const a = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    const b = plan({ seed: 2, count: 20, categories: ALL_CATEGORIES });
    expect(a).not.toEqual(b);
  });
});

describe("boundaries", () => {
  test("count 0 returns an empty plan", () => {
    const p = plan({ seed: 1, count: 0, categories: ALL_CATEGORIES });
    expect(p.slots).toEqual([]);
  });

  test("count 0 accepts an empty category list too", () => {
    expect(() => plan({ seed: 1, count: 0, categories: [] })).not.toThrow();
  });

  test("count > 0 with no categories is rejected", () => {
    expect(() => plan({ seed: 1, count: 1, categories: [] })).toThrow(RangeError);
  });

  test("count 1 puts the only slot in the first category by canonical order", () => {
    const p = plan({ seed: 1, count: 1, categories: ["fitness", "home"] });
    expect(p.slots).toHaveLength(1);
    expect(p.slots[0]!.category).toBe("home");
  });

  test("a negative count is rejected", () => {
    expect(() => plan({ seed: 1, count: -1, categories: ["home"] })).toThrow(RangeError);
  });

  test("a fractional count is rejected", () => {
    expect(() => plan({ seed: 1, count: 1.5, categories: ["home"] })).toThrow(RangeError);
  });

  test("max: a single category filled up to its location count repeats no location", () => {
    const max = POOLS.fitness.locations.length;
    const p = plan({ seed: 1, count: max, categories: ["fitness"] });
    expect(new Set(p.slots.map((s) => s.location)).size).toBe(max);
  });

  test("one past max: a location must now repeat", () => {
    const max = POOLS.fitness.locations.length;
    const p = plan({ seed: 1, count: max + 1, categories: ["fitness"] });
    expect(p.slots).toHaveLength(max + 1);
    expect(new Set(p.slots.map((s) => s.location)).size).toBeLessThanOrEqual(max);
  });
});

describe("distribution across categories", () => {
  test("a single category receives the whole count", () => {
    const p = plan({ seed: 1, count: 3, categories: ["glamour"] });
    expect(p.slots.every((s) => s.category === "glamour")).toBe(true);
    expect(p.slots).toHaveLength(3);
  });

  test("spreads the count evenly; the canonical order gets the remainder first", () => {
    const p = plan({ seed: 1, count: 7, categories: ["home", "travel", "fitness"] });
    const counts = ["home", "travel", "fitness"].map((c) => p.slots.filter((s) => s.category === c).length);
    expect(counts).toEqual([3, 2, 2]);
  });

  test("the default run (20 photos, all 5 categories) gives every category 4 slots", () => {
    const p = plan({ seed: 20260924, count: 20, categories: ALL_CATEGORIES });
    for (const category of ALL_CATEGORIES) {
      expect(p.slots.filter((s) => s.category === category)).toHaveLength(4);
    }
  });

  test("fewer photos than categories: only the earliest categories in canonical order get one slot each", () => {
    const p = plan({ seed: 1, count: 2, categories: ["fitness", "glamour", "home", "travel"] });
    expect(p.slots.map((s) => s.category)).toEqual(["home", "travel"]);
  });

  test("categories are de-duplicated and reordered to the canonical order regardless of input order", () => {
    const p = plan({ seed: 1, count: 4, categories: ["travel", "home", "travel"] });
    expect(p.slots.map((s) => s.category)).toEqual(["home", "home", "travel", "travel"]);
  });
});

describe("plan order (invariant 6): slots are emitted in the order the queue will send them", () => {
  test("slotIndex is 1..N ascending, matching array position", () => {
    const p = plan({ seed: 1, count: 9, categories: ["home", "travel"] });
    expect(p.slots.map((s) => s.slotIndex)).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
  });

  test("categories appear as contiguous blocks, in canonical order", () => {
    const p = plan({ seed: 1, count: 6, categories: ["fitness", "photoshoot"] });
    expect(p.slots.map((s) => s.category)).toEqual(["photoshoot", "photoshoot", "photoshoot", "fitness", "fitness", "fitness"]);
  });
});

describe("attempt id bases (invariants 5 and 6)", () => {
  test("are unique within a plan", () => {
    const p = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    const bases = p.slots.map((s) => s.attemptIdBase);
    expect(new Set(bases).size).toBe(bases.length);
  });

  test("follow slot-<slotIndex>", () => {
    const p = plan({ seed: 1, count: 3, categories: ["home"] });
    expect(p.slots.map((s) => s.attemptIdBase)).toEqual(["slot-1", "slot-2", "slot-3"]);
  });

  test("are stable across re-plans with the same seed", () => {
    const a = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    const b = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    expect(a.slots.map((s) => s.attemptIdBase)).toEqual(b.slots.map((s) => s.attemptIdBase));
  });
});

describe("times and activities are drawn only from the slot's own location", () => {
  test("every slot's time of day is one the location allows", () => {
    const p = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    for (const slot of p.slots) {
      expect(placeOf(slot.category, slot.location).times).toContain(slot.timeOfDay);
    }
  });

  test("every slot's activity is one the location allows", () => {
    const p = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    for (const slot of p.slots) {
      expect(placeOf(slot.category, slot.location).activities.map((a) => a.text)).toContain(slot.activity);
    }
  });

  test('"studio lighting" counts as a time of day and is used whenever the backdrop location is drawn', () => {
    // 25 slots over 5 photoshoot locations = exactly 5 full bag passes, so the
    // studio-backdrop location (the only one whose times are ["studio lighting"])
    // is guaranteed to appear, regardless of seed or shuffle order.
    const p = plan({ seed: 1, count: 25, categories: ["photoshoot"] });
    const backdropSlots = p.slots.filter((s) => s.location.includes("seamless beige backdrop"));
    expect(backdropSlots.length).toBeGreaterThan(0);
    expect(backdropSlots.every((s) => s.timeOfDay === "studio lighting")).toBe(true);
  });
});

describe("selfie and mirror slots never get a two-handed activity", () => {
  test("across many seeds and every category, no selfie or mirror slot has a two-handed activity", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = plan({ seed, count: 20, categories: ALL_CATEGORIES });
      for (const slot of p.slots) {
        if (slot.shot !== "selfie" && slot.shot !== "mirror") continue;
        const activity = placeOf(slot.category, slot.location).activities.find((a) => a.text === slot.activity);
        expect(activity?.twoHanded).toBe(false);
      }
    }
  });
});

describe("mirror placement: a mirror shot lands only on a mirror location", () => {
  test("across many seeds and every category, every mirror shot sits on a mirror location", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = plan({ seed, count: 20, categories: ALL_CATEGORIES });
      for (const slot of p.slots) {
        if (slot.shot !== "mirror") continue;
        expect(placeOf(slot.category, slot.location).mirror).toBe(true);
      }
    }
  });

  test("swaps a misplaced mirror shot with a non-mirror shot on a mirror location", () => {
    const shots = ["mirror", "selfie", "candid"] as const;
    const places = [{ mirror: undefined }, { mirror: true as const }, { mirror: undefined }];
    expect(placeMirrorShots([...shots], places)).toEqual(["selfie", "mirror", "candid"]);
  });

  test("falls back to selfie when no mirror location is available to swap with", () => {
    const shots = ["mirror", "friend", "candid"] as const;
    const places = [{ mirror: undefined }, { mirror: undefined }, { mirror: undefined }];
    expect(placeMirrorShots([...shots], places)).toEqual(["selfie", "friend", "candid"]);
  });

  test("leaves a mirror shot already on a mirror location untouched", () => {
    const shots = ["mirror", "friend"] as const;
    const places = [{ mirror: true as const }, { mirror: undefined }];
    expect(placeMirrorShots([...shots], places)).toEqual(["mirror", "friend"]);
  });

  test("leaves non-mirror shots untouched", () => {
    const shots = ["friend", "selfie", "candid", "photographer"] as const;
    const places = [{ mirror: undefined }, { mirror: true as const }, { mirror: undefined }, { mirror: undefined }];
    expect(placeMirrorShots([...shots], places)).toEqual([...shots]);
  });

  test("a second misplaced mirror shot falls back to selfie once the only mirror location is taken", () => {
    const shots = ["mirror", "mirror", "candid", "friend"] as const;
    const places = [{ mirror: undefined }, { mirror: undefined }, { mirror: true as const }, { mirror: undefined }];
    // slot 0 swaps with slot 2 (the only non-mirror shot on a mirror location);
    // slot 1 then has no swap candidate left and falls back to selfie.
    expect(placeMirrorShots([...shots], places)).toEqual(["candid", "selfie", "mirror", "friend"]);
  });
});

describe("Photoshoot's own shot deck: 3 photographer, 2 candid", () => {
  test("a full 5-slot photoshoot plan draws exactly 3 photographer and 2 candid shots", () => {
    const p = plan({ seed: 1, count: 5, categories: ["photoshoot"] });
    expect(p.slots.map((s) => s.shot).sort()).toEqual(["candid", "candid", "photographer", "photographer", "photographer"]);
  });

  test("no photoshoot slot is ever a selfie, mirror or friend shot, across many seeds", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const p = plan({ seed, count: 12, categories: ["photoshoot"] });
      expect(p.slots.every((s) => s.shot === "photographer" || s.shot === "candid")).toBe(true);
    }
  });
});

describe("no revealing outfit anywhere", () => {
  test("across a large plan spanning every category, no outfit is revealing", () => {
    const p = plan({ seed: 1, count: 40, categories: ALL_CATEGORIES });
    for (const slot of p.slots) expect(slot.outfit).not.toMatch(REVEALING);
  });
});

describe("exclusion of the avatar's recent (location, outfit) pairs", () => {
  test("avoids repeating an excluded pair when an alternative outfit exists, and marks nothing as repeated", () => {
    const base = plan({ seed: 1, count: 4, categories: ["fitness"] });
    const excludePairs: ExcludedPair[] = base.slots.map((s) => ({ location: s.location, outfit: s.outfit }));
    const next = plan({ seed: 1, count: 4, categories: ["fitness"], excludePairs });
    for (const slot of next.slots) {
      expect(excludePairs).not.toContainEqual({ location: slot.location, outfit: slot.outfit });
    }
    expect(next.slots.every((s) => s.repeatedPair === false)).toBe(true);
  });

  test("gracefully accepts a repeat when every outfit for a location is excluded, and flags that one slot as repeatedPair", () => {
    const location = POOLS.fitness.locations[0]!.name;
    const excludePairs: ExcludedPair[] = POOLS.fitness.outfits.map((outfit) => ({ location, outfit }));
    const p = plan({ seed: 1, count: POOLS.fitness.locations.length, categories: ["fitness"], excludePairs });

    const atExcludedLocation = p.slots.filter((s) => s.location === location);
    const elsewhere = p.slots.filter((s) => s.location !== location);
    expect(atExcludedLocation.every((s) => s.repeatedPair === true)).toBe(true);
    expect(elsewhere.every((s) => s.repeatedPair === false)).toBe(true);
  });

  test("repeatedPair is false on every slot when no exclusion is given", () => {
    const p = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    expect(p.slots.every((s) => s.repeatedPair === false)).toBe(true);
  });

  test("an empty exclusion list changes nothing", () => {
    const a = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES });
    const b = plan({ seed: 1, count: 20, categories: ALL_CATEGORIES, excludePairs: [] });
    expect(a).toEqual(b);
  });

  test("only exact (location, outfit) pairs are excluded: the same location with a different outfit is fine", () => {
    const location = POOLS.home.locations[0]!.name;
    const excludedOutfit = POOLS.home.outfits[0]!;
    const p = plan({ seed: 1, count: 5, categories: ["home"], excludePairs: [{ location, outfit: excludedOutfit }] });
    expect(p.slots.some((s) => s.location === location)).toBe(true);
  });
});

describe("outfits and locations never repeat within one category before every option is used once", () => {
  test("a full pass (count = pool size) uses every outfit exactly once", () => {
    const n = POOLS.home.outfits.length;
    const p = plan({ seed: 1, count: n, categories: ["home"] });
    expect(new Set(p.slots.map((s) => s.outfit)).size).toBe(n);
  });
});

describe("per-category rng isolation: a pool edit must only change its own category's plans", () => {
  test("adding a location to one category's pool leaves every other category's slots byte-identical, for the same seed", () => {
    const base = planWithPools({ seed: 1, count: 20, categories: ALL_CATEGORIES }, POOLS);
    const extraLocation = {
      name: "a mutated test location used only by this isolation test",
      times: ["morning"],
      activities: [{ text: "standing still", twoHanded: false }],
    };
    const mutatedPools = { ...POOLS, home: { ...POOLS.home, locations: [...POOLS.home.locations, extraLocation] } };
    const mutated = planWithPools({ seed: 1, count: 20, categories: ALL_CATEGORIES }, mutatedPools);

    for (const category of ALL_CATEGORIES.filter((c) => c !== "home")) {
      expect(mutated.slots.filter((s) => s.category === category)).toEqual(base.slots.filter((s) => s.category === category));
    }
  });

  test("adding an outfit to one category's pool leaves every other category's slots byte-identical, for the same seed", () => {
    const base = planWithPools({ seed: 7, count: 20, categories: ALL_CATEGORIES }, POOLS);
    const mutatedPools = { ...POOLS, glamour: { ...POOLS.glamour, outfits: [...POOLS.glamour.outfits, "a plain black dress"] } };
    const mutated = planWithPools({ seed: 7, count: 20, categories: ALL_CATEGORIES }, mutatedPools);

    for (const category of ALL_CATEGORIES.filter((c) => c !== "glamour")) {
      expect(mutated.slots.filter((s) => s.category === category)).toEqual(base.slots.filter((s) => s.category === category));
    }
  });
});
