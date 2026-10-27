import { describe, expect, test } from "bun:test";
import type { PoolShot, ScenePose } from "../engine";
import { captureOfShot, posesFor } from "./captures";
import { covers, type CustomActivity, type CustomPool } from "./custom";
import { fnv1a } from "./hash";
import { templateSentence } from "./template";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6a, I5.22): `covers(pool)` is true exactly when the template renders every (place, activity, shot, pose) the planner can draw from the
// pool. An equivalence property over random pools: the slots are drawn here the way the planner draws them (a shot with its fallbacks, a pose, then
// ANY activity the shot allows), independently of `covers`' own loop; engine/runs/covers.planner.property.test.ts holds `covers` to the real planner. Soundness is the money side: a covered pool reserves no
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

type DrawnSlot = { location: string; activity: string; outfit: string; shot: PoolShot; pose: ScenePose };

/**
 * Every slot the planner can draw from the pool, written from the planner's stages (engine/scenes/planner.ts, poses.ts), apart from `covers`: a shot of the deck
 * (a mirror on a mirror place only), a hand-held shot moved off a place with no clean activity or with «selfie» in its name (settleHandShots: onto a clean place, a mirror
 * that finds no clean mirror place becoming a selfie, a pool with no clean place a friend's snap), a pose from the pool's angles (a back or a profile angle takes a
 * non-phone shot of the deck, drawFromPoses), then ANY activity the shot allows: the planner never asks the pose which one. The REAL planner is checked against `covers`
 * in engine/runs/covers.planner.property.test.ts; this model is what lets the other direction (uncovered ⇒ a null slot) be exact.
 */
function drawableSlots(pool: CustomPool): DrawnSlot[] {
  const out: DrawnSlot[] = [];
  const hand = (shot: PoolShot): boolean => shot === "selfie" || shot === "mirror";
  const clean = (a: CustomActivity): boolean => !a.twoHanded && !PHONE_WORDS.test(a.text) && !SELFIE_WORDS.test(a.text);
  const cleanPlace = (place: CustomPool["locations"][number]): boolean => !SELFIE_WORDS.test(place.name) && place.activities.some(clean);
  const deck = new Set(pool.shotDeck);
  const plain = [...deck].filter((shot) => !hand(shot));
  const anyCleanPlace = pool.locations.some(cleanPlace);
  const angles = pool.poses ?? POSES;
  for (const place of pool.locations) {
    const shots = new Set<PoolShot>(plain);
    if (cleanPlace(place)) {
      if (deck.has("selfie") || deck.has("mirror")) shots.add("selfie");
      if (deck.has("mirror") && place.mirror === true) shots.add("mirror");
    }
    if ((deck.has("selfie") || deck.has("mirror")) && !anyCleanPlace) shots.add("friend");
    if (angles.some((p) => p === "back" || p === "profile") && plain.length === 0 && (deck.has("selfie") || deck.has("mirror"))) shots.add("friend");
    for (const shot of shots) {
      const capture = captureOfShot(shot);
      for (const pose of angles.filter((p) => posesFor(capture).includes(p))) {
        for (const activity of hand(shot) ? place.activities.filter(clean) : place.activities) {
          for (const outfit of pool.outfits) out.push({ location: place.name, activity: activity.text, outfit, shot, pose });
        }
      }
    }
  }
  return out;
}

const REF = "cat-propertytest";
const renders = (slot: ReturnType<typeof drawableSlots>[number], key: string): boolean => templateSentence({ route: undefined, category: REF, ...slot }, { key, snapshots: [{ ref: REF }] }) !== null;

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
