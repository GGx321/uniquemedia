import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isWaterPlaceName } from "../../shared/scenes/custom";
import { plan, planWithPools, type PlanInput } from "./planner";
import { POOLS, type Pool } from "./pools";
import { ORDINARY_BUILT_INS, type PlannerCategory } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 §7.4, §8 BA3): the golden of «Смелая» on every category, beside the one of the two «Смелая» categories (planner.boldGolden.test.ts) and the five's (planner.custom.test.ts, frozen to main 3a9cd498). Each
// entry hashes the plans of a category set at «Смелая» for six seeds, five sizes and the three legs shares, for an imported avatar (the planner's default: no implied cover) and a Studio-created one, so a
// change to a companion or a custom bank, to the whole-request tiers, to the water split or the world, or to a stream shows up as a changed hash.
//
// REGENERATE deliberately, never to turn a red test green, and in a COPY of the repo outside it (the owner's rule for goldens): `PLANNER_BOLD_ANY_WRITE_GOLDEN=<path> bun test --no-env-file
// studio/engine/scenes/planner.boldAnyGolden.test.ts` writes the fixture to <path>; READ the diff against fixtures/planner-bold-any.json: every changed hash is a plan that moved.

const FIXTURE = join(import.meta.dir, "fixtures", "planner-bold-any.json");
const SEEDS = [1, 7, 42, 2026, 123456789, 4294967295];
const COUNTS = [1, 7, 20, 33, 100];
const SHARES = [0, 15, 30] as const;
const ORIGINS = ["imported", "studio"] as const;
const CUSTOM = "cat-paris-trip";
const OTHER = "cat-night-market";

/** The custom pools of the golden: a Paris trip with two water places out of five, and a market with none. */
const PARIS: Pool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a coffee with both hands", twoHanded: true }] },
    { name: "a hotel pool in Nice", times: ["midday"], activities: [{ text: "floating on her back", twoHanded: false }] },
    { name: "a bridge over the Seine", times: ["golden hour", "evening"], activities: [{ text: "leaning on the railing", twoHanded: false }] },
    { name: "the sundeck of a sailing yacht", times: ["golden hour"], activities: [{ text: "watching the waves", twoHanded: false }] },
    { name: "a tiny bookshop", times: ["midday", "evening"], activities: [{ text: "browsing a shelf", twoHanded: false }] },
  ],
  outfits: ["a beige trench coat and jeans", "a striped knit top and a midi skirt", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const MARKET: Pool = {
  locations: [
    { name: "a lantern-lit food stall", times: ["night"], activities: [{ text: "pointing at a menu", twoHanded: false }] },
    { name: "a crowded market lane", times: ["evening", "night"], activities: [{ text: "tasting a snack", twoHanded: false }] },
    { name: "a stall with paper lamps", times: ["night"], activities: [{ text: "choosing a lamp", twoHanded: false }], mirror: true },
    { name: "a noodle counter", times: ["evening"], activities: [{ text: "waiting for a bowl", twoHanded: false }] },
    { name: "a rooftop terrace", times: ["night"], activities: [{ text: "looking at the lights", twoHanded: false }] },
  ],
  outfits: ["a denim jacket and a white tee", "a satin shirt and black trousers", "a knit dress and boots"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};
const POOLS_WITH_CUSTOM: Record<string, Pool> = { ...POOLS, [CUSTOM]: PARIS, [OTHER]: MARKET };

const SETS: readonly (readonly PlannerCategory[])[] = [
  ...ORDINARY_BUILT_INS.map((c) => [c] as const),
  [...ORDINARY_BUILT_INS],
  ["nightwear"],
  ["home", "nightwear", "beach"],
  [CUSTOM],
  [CUSTOM, OTHER],
  ["home", "travel", CUSTOM],
  [...ORDINARY_BUILT_INS, "nightwear", "beach", CUSTOM, OTHER],
];
const keyOf = (categories: readonly PlannerCategory[], origin: (typeof ORIGINS)[number]): string => `${categories.join(",")}@bold/${origin}`;

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function hashOf(categories: readonly PlannerCategory[], origin: (typeof ORIGINS)[number]): string {
  const all: unknown[] = [];
  for (const seed of SEEDS) {
    for (const count of COUNTS) {
      for (const legsShare of SHARES) {
        // A custom category draws no legs, so a request of custom categories alone is refused for «Ножки» (QB-6) before the planner: its golden is told at no legs.
        if (legsShare > 0 && categories.every((c) => c.startsWith("cat-"))) continue;
        const input: PlanInput = { seed, count, categories: [...categories], level: "bold", legsShare, impliedNudity: origin === "studio" };
        all.push(categories.some((c) => c.startsWith("cat-")) ? planWithPools(input, POOLS_WITH_CUSTOM) : plan(input));
      }
    }
  }
  return sha(all);
}

function hashesNow(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const categories of SETS) for (const origin of ORIGINS) out[keyOf(categories, origin)] = hashOf(categories, origin);
  return out;
}

const WRITE = process.env.PLANNER_BOLD_ANY_WRITE_GOLDEN;
if (WRITE !== undefined && WRITE !== "") writeFileSync(WRITE, `${JSON.stringify({ seeds: SEEDS, counts: COUNTS, legsShares: SHARES, hashes: hashesNow() }, null, 2)}\n`);

describe("«Смелая» on every category is pinned (S5.BA3)", () => {
  const fixture: { seeds: number[]; counts: number[]; legsShares: number[]; hashes: Record<string, string> } = JSON.parse(readFileSync(FIXTURE, "utf8"));

  test("the fixture covers the category sets for both origins, over the seeds, sizes and legs shares it names", () => {
    expect(Object.keys(fixture.hashes).sort()).toEqual(SETS.flatMap((c) => ORIGINS.map((o) => keyOf(c, o))).sort());
    expect({ seeds: fixture.seeds, counts: fixture.counts, legsShares: fixture.legsShares }).toEqual({ seeds: SEEDS, counts: COUNTS, legsShares: [...SHARES] });
  });

  test("the custom pool of the golden has water places and the market none", () => {
    expect(PARIS.locations.filter((l) => isWaterPlaceName(l.name))).toHaveLength(2);
    expect(MARKET.locations.filter((l) => isWaterPlaceName(l.name))).toHaveLength(0);
  });

  for (const categories of SETS) {
    for (const origin of ORIGINS) {
      test(`${categories.join(", ")} at bold, ${origin}: every seed, size and legs share`, () => {
        expect(hashOf(categories, origin)).toBe(fixture.hashes[keyOf(categories, origin)]);
      });
    }
  }
});
