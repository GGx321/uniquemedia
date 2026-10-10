import type { Place, Pool } from "./pools";
import { drawFromPoses, drawPose, type PoseAllowance } from "./poses";
import { makeRng, rngPick, subSeed } from "./rngUtil";
import { isPhoneInHandShot, type PlanSlot, type Pose } from "./schema";
import type { Shot } from "./types";

// CS.4b: the two draws a review-time write makes BEFORE its call. Both are pure functions of (set seed, write number, scene) and what they are given, on
// their own rng streams (never a category's own, so no plan's draws move), and the engine stores the result in the write's record before the first request:
// a crash-resume of the same write draws nothing at all.

export interface RedrawInput {
  /** The set's own seed (`seedOfSet`). */
  seed: number;
  /** The write's number: the draw differs per write, so «Другая сцена» again gives another scene. */
  k: number;
  /** The scene as it is now; its id, category, shot and attempt id base are kept. */
  slot: PlanSlot;
  /** The category's pool as it is NOW (a custom category may have been regenerated since the set was made). */
  pool: Pool;
  /** The places and outfits the set already shows. */
  avoid: { locations: ReadonlySet<string>; outfits: ReadonlySet<string> };
  poses: PoseAllowance;
}

/**
 * The candidates for one draw, in tiers: those the set does not already show; else those other than the scene's own current one; else everything. «Where it
 * can»: a pool the set has used up still draws, and still draws something other than what the scene had when it has anything else.
 */
function preferred<T>(items: readonly T[], nameOf: (item: T) => string, avoid: ReadonlySet<string>, own: string): readonly T[] {
  const fresh = items.filter((item) => !avoid.has(nameOf(item)));
  if (fresh.length > 0) return fresh;
  const other = items.filter((item) => nameOf(item) !== own);
  return other.length > 0 ? other : items;
}

/**
 * A new place, outfit, activity, time of day and pose for a planned scene, from the category's current pool. A mirror shot stays on a mirror place (and
 * becomes a selfie in a pool that has none, as the planner does); a selfie or mirror never gets a two-handed activity and faces the camera.
 */
export function redrawSlot(input: RedrawInput): PlanSlot {
  const { seed, k, slot, pool, avoid } = input;
  const rng = makeRng(subSeed(seed, `redraw:${slot.slotIndex}:${k}`));
  const poseRng = makeRng(subSeed(seed, `redraw-pose:${slot.slotIndex}:${k}`));
  // CS.8a: a category with `poses` redraws its pose from them (the set's toggles are not asked); a selfie or mirror scene that turns away takes another shot of the
  // deck. A pool without `poses` draws as it always did.
  const angled = pool.poses === undefined ? null : drawFromPoses(poseRng, slot.shot, pool.poses, pool.shotDeck);
  let shot = angled === null ? slot.shot : angled.shot;
  let places: readonly Place[] = pool.locations;
  if (shot === "mirror") {
    const mirrors = places.filter((place) => place.mirror === true);
    if (mirrors.length === 0) shot = "selfie";
    else places = mirrors;
  }
  const place = rngPick(rng, preferred(places, (p) => p.name, avoid.locations, slot.location));
  const outfit = rngPick(rng, preferred(pool.outfits, (o) => o, avoid.outfits, slot.outfit));
  const phoneInHand = isPhoneInHandShot(shot);
  const activities = place.activities.filter((a) => !(phoneInHand && a.twoHanded));
  return {
    slotIndex: slot.slotIndex,
    category: slot.category,
    location: place.name,
    timeOfDay: rngPick(rng, place.times),
    activity: rngPick(rng, activities).text,
    outfit,
    shot,
    pose: angled === null ? drawPose(poseRng, shot, input.poses) : angled.pose,
    attemptIdBase: slot.attemptIdBase,
    repeatedPair: false,
  };
}

export interface OwnDraw {
  shot: Shot;
  pose: Pose;
}

/** What «Авто» draws a shot from: the default deck without the mirror (an own scene has no place for a mirror to sit on). */
const AUTO_SHOTS: readonly Shot[] = ["friend", "selfie", "candid", "friend"];

/** The shot and the pose of each of an idea write's `count` own scenes. An explicit shot is kept as asked; «Авто» never draws the mirror. */
export function drawOwnScenes(input: { seed: number; k: number; count: number; shot: Shot | null; poses: PoseAllowance }): OwnDraw[] {
  const rng = makeRng(subSeed(input.seed, `own:${input.k}`));
  const poseRng = makeRng(subSeed(input.seed, `own-pose:${input.k}`));
  return Array.from({ length: input.count }, () => {
    const shot = input.shot ?? rngPick(rng, AUTO_SHOTS);
    return { shot, pose: drawPose(poseRng, shot, input.poses) };
  });
}
