import { describe, expect, test } from "bun:test";
import type { PoolShot, ScenePose } from "../engine";
import { captureOfShot } from "./captures";
import { covers, customActivityAllowed, type CustomActivity, type CustomPool } from "./custom";
import { fnv1a } from "./hash";
import { templateSentence } from "./template";

// 5a.2 (S5.6a, I5.22): `covers(pool)` is true exactly when the template renders every (place, activity, shot, pose) the planner can draw from the
// pool. An equivalence property over random pools: the slots are drawn here the way the 5a.2 planner draws them (the pose first, then an activity the
// slot allows, the planner's fallback when none does), independently of `covers`' own loop. Soundness is the money side: a covered pool reserves no
// writer, so none of its slots may come out null.

const ACTIVITIES: readonly CustomActivity[] = [
  { text: "holding a mug", twoHanded: false },
  { text: "browsing the shelves", twoHanded: false },
  { text: "on her stomach, scrolling", twoHanded: false },
  { text: "carrying two bags", twoHanded: true },
  { text: "scrolling her phone", twoHanded: false },
  { text: "smiling at the camera", twoHanded: false },
  { text: "taking a selfie", twoHanded: false },
  { text: "a quiet moment", twoHanded: false },
  { text: "morning stretches", twoHanded: false },
  { text: "the big clean-up", twoHanded: true },
];
const PLACES = ["a quiet bookshop", "the beach", "a cafe terrace", "a phone repair shop", "a selfie wall", "her bedroom"];
const OUTFITS = ["a cozy cardigan", "jeans and a tee", "a phone-print hoodie"];
const SHOTS: readonly PoolShot[] = ["friend", "selfie", "mirror", "candid", "photographer"];
const POSES: readonly ScenePose[] = ["front", "three-quarter", "profile", "back"];

function randomPool(seed: number): CustomPool {
  let state = fnv1a(`pool:${seed}`);
  const next = (n: number): number => {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    state = (state + 0x6d2b79f5) >>> 0;
    return state % n;
  };
  const places = Array.from({ length: 1 + next(3) }, (_, i) => ({
    name: PLACES[(i + next(PLACES.length)) % PLACES.length] ?? "her bedroom",
    mirror: next(2) === 0,
    activities: Array.from({ length: 1 + next(3) }, () => ACTIVITIES[next(ACTIVITIES.length)] ?? { text: "holding a mug", twoHanded: false }),
  }));
  const poses = next(3) === 0 ? [POSES[next(4)] ?? "front"] : undefined;
  return {
    locations: places,
    outfits: Array.from({ length: 1 + next(2) }, () => OUTFITS[next(OUTFITS.length)] ?? "a cozy cardigan"),
    shotDeck: Array.from({ length: 5 }, () => SHOTS[next(SHOTS.length)] ?? "friend"),
    ...(poses === undefined ? {} : { poses }),
  };
}

/** Every slot the 5a.2 planner can draw from the pool (written apart from `covers`). */
function drawableSlots(pool: CustomPool): Array<{ location: string; activity: string; outfit: string; shot: PoolShot; pose: ScenePose }> {
  const out: Array<{ location: string; activity: string; outfit: string; shot: PoolShot; pose: ScenePose }> = [];
  const hand = (shot: PoolShot): boolean => shot === "selfie" || shot === "mirror";
  for (const place of pool.locations) {
    for (const shot of pool.shotDeck) {
      if (shot === "mirror" && place.mirror !== true) continue;
      // The planner moves a hand-held shot off a place with no clean activity or with «selfie» in its name (settleHandShots).
      // A custom category's capture is derived from its stored shot (plan r1.2): a photographer is a friend.
      const capture = captureOfShot(shot);
      if (hand(shot) && (/selfie/i.test(place.name) || !place.activities.some((a) => customActivityAllowed(a, capture, "front")))) continue;
      for (const pose of pool.poses ?? POSES) {
        if (hand(shot) && pose !== "front" && pose !== "three-quarter") continue;
        let slotShot = shot;
        let slotPose = pose;
        let allowed = place.activities.filter((a) => customActivityAllowed(a, capture, slotPose));
        if (allowed.length === 0) {
          slotShot = shot === "candid" ? "friend" : shot;
          slotPose = "three-quarter";
          allowed = place.activities.filter((a) => customActivityAllowed(a, captureOfShot(slotShot), slotPose));
        }
        for (const activity of allowed) for (const outfit of pool.outfits) out.push({ location: place.name, activity: activity.text, outfit, shot: slotShot, pose: slotPose });
      }
    }
  }
  return out;
}

const REF = "cat-propertytest";
const renders = (slot: ReturnType<typeof drawableSlots>[number], key: string): boolean => templateSentence({ category: REF, ...slot }, { key, snapshots: [{ ref: REF }] }) !== null;

describe("covers is exact (I5.22)", () => {
  const POOLS = Array.from({ length: 400 }, (_, i) => randomPool(i));

  test("the random pools are a mix of covered and uncovered ones", () => {
    const covered = POOLS.filter(covers).length;
    expect(covered).toBeGreaterThan(40);
    expect(covered).toBeLessThan(360);
  });

  test("a covered pool renders every slot the planner can draw, whatever the key (no null slot without a writer reserve)", () => {
    for (const pool of POOLS.filter(covers)) for (const slot of drawableSlots(pool)) for (const key of ["a", "b"]) expect(renders(slot, key)).toBe(true);
  });

  test("an uncovered pool has a slot the planner can draw that the template does not render", () => {
    for (const pool of POOLS.filter((p) => !covers(p))) expect(drawableSlots(pool).some((slot) => !renders(slot, "a"))).toBe(true);
  });
});
