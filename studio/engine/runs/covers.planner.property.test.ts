import { describe, expect, test } from "bun:test";
import type { CategoryPool, PoolShot, ScenePose } from "../../shared/engine";
import { covers } from "../../shared/scenes/custom";
import { fnv1a } from "../../shared/scenes/hash";
import { planWithPools, POOLS } from "../scenes";
import { localSentences } from "../scenes/localSentences";
import { slotKeyOf } from "../scenes/phoneLook";
import { poolOf } from "../scenes/poolGen";
import { sceneCategory } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6R, I5.22 / I5.30): `covers(pool)` is the money side of «a covered category reserves no writer». Its own property test restates covers' rule; this one
// asks the REAL planner (settleHandShots' fallbacks included: a hand-held shot that finds no clean place becomes a selfie on a clean one, or a friend's snap that
// the deck may not hold) over random decks. Covered ⇒ no slot the planner draws is null at the template, whatever the seed, count and the run's pose toggles.

const REF = "cat-covers-planner" as const;
const ACTIVITIES = [
  { text: "holding a mug", twoHanded: false },
  { text: "browsing the shelves", twoHanded: false },
  { text: "on her stomach, scrolling", twoHanded: false },
  { text: "carrying two bags", twoHanded: true },
  { text: "scrolling her phone", twoHanded: false },
  { text: "smiling at the camera", twoHanded: false },
  { text: "taking a selfie", twoHanded: false },
  { text: "a quiet moment", twoHanded: false },
  { text: "morning stretches", twoHanded: false },
  { text: "reading a menu", twoHanded: false },
] as const;
const PLACES = ["a quiet bookshop", "the beach", "a cafe terrace", "a phone repair shop", "a selfie wall", "her bedroom"];
const OUTFITS = ["a cozy cardigan", "jeans and a tee", "a phone-print hoodie"];
const SHOTS: readonly PoolShot[] = ["friend", "selfie", "mirror", "candid", "photographer"];
const POSES: readonly ScenePose[] = ["front", "three-quarter", "profile", "back"];

function randomPool(seed: number): CategoryPool {
  let state = fnv1a(`covers-planner:${seed}`);
  const next = (n: number): number => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    state = (state + 0x6d2b79f5) >>> 0;
    return state % n;
  };
  const locations = Array.from({ length: 1 + next(3) }, (_, i) => ({
    name: PLACES[(i + next(PLACES.length)) % PLACES.length] ?? "her bedroom",
    times: ["midday" as const],
    mirror: next(2) === 0,
    activities: Array.from({ length: 1 + next(3) }, () => ACTIVITIES[next(ACTIVITIES.length)] ?? ACTIVITIES[0]).map((a) => ({ ...a })),
  }));
  const hasMirror = locations.some((l) => l.mirror);
  const shotDeck = Array.from({ length: 5 }, () => SHOTS[next(SHOTS.length)] ?? "friend").map((s): PoolShot => (s === "mirror" && !hasMirror ? "selfie" : s));
  const poses = next(3) === 0 ? [POSES[next(4)] ?? "front"] : undefined;
  return {
    locations,
    outfits: Array.from({ length: 1 + next(2) }, () => OUTFITS[next(OUTFITS.length)] ?? "a cozy cardigan"),
    shotDeck,
    ...(poses === undefined ? {} : { poses }),
  };
}

const POOLS_UNDER_TEST = Array.from({ length: 500 }, (_, i) => randomPool(i));
const COUNTS = [1, 4, 9, 25];

function nullSlots(pool: CategoryPool, seed: number, count: number): string[] {
  const scenes = planWithPools({ seed, count, categories: [sceneCategory(REF)] }, { ...POOLS, [REF]: poolOf(pool) });
  const local = localSentences({ slots: scenes.slots.map((s) => ({ ...s, route: s.route })), keyOf: (slot) => slotKeyOf("run-00000001", slot.attemptIdBase), snapshots: [{ ref: REF }] });
  return scenes.slots.filter((slot) => local(slot) === null).map((slot) => `${slot.shot}/${slot.pose} @ ${slot.location} / ${slot.activity}`);
}

describe("covers agrees with the real planner (I5.22)", () => {
  test("the random decks are a mix of covered and uncovered pools", () => {
    const covered = POOLS_UNDER_TEST.filter((pool) => covers(poolOf(pool))).length;
    expect(covered).toBeGreaterThan(30);
    expect(covered).toBeLessThan(450);
  });

  test("a pool counted covered never yields a null slot from the real planner", () => {
    for (const [index, pool] of POOLS_UNDER_TEST.entries()) {
      if (!covers(poolOf(pool))) continue;
      for (const count of COUNTS) {
        for (let seed = 1; seed <= 5; seed++) {
          const bad = nullSlots(pool, seed, count);
          if (bad.length > 0) throw new Error(`pool #${index} ${JSON.stringify(pool)} (seed ${seed}, ${count}): covered but ${bad.length} null slot(s): ${bad[0]}`);
        }
      }
    }
  });
});
