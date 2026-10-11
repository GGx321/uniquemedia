import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { legwearFits } from "../../shared/scenes/template";
import { fittingMoments, generalOutfits, kindOfDeck, outfitInfoOf, pinnedOutfitsOf, poseForCapture, settleFit } from "./fit";
import { allowedActivities, hasCleanActivity, usableOutfits, type Activity, type Place, type Pool } from "./pools";
import { drawFromPoses, drawPose, NO_EXTRA_POSES } from "./poses";
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
  // 5a.2 (S5.6b): a built-in pool deals captures, and its scene is redrawn the way the planner draws it.
  if (input.pool.captureDeck !== undefined) return redrawBuiltIn(input, input.pool.captureDeck);
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
  // S5.R1, the planner's rule (planner.ts settleHandShots): a selfie or mirror only goes where it has a clean activity. A mirror with no clean mirror place becomes a selfie on a clean
  // place, and a pool with no clean place turns the scene into a friend's snap.
  if (isPhoneInHandShot(shot)) {
    const clean = places.filter(hasCleanActivity);
    if (clean.length > 0) places = clean;
    else {
      const anywhere = pool.locations.filter(hasCleanActivity);
      if (anywhere.length > 0) {
        shot = "selfie";
        places = anywhere;
      } else {
        shot = "friend";
        places = pool.locations;
      }
    }
  }
  const place = rngPick(rng, preferred(places, (p) => p.name, avoid.locations, slot.location));
  // The owner's denim rule (S5.6b): a custom pool stored before it may hold denim shorts or skirts; they are never drawn.
  const outfit = rngPick(rng, preferred(usableOutfits(pool.outfits), (o) => o, avoid.outfits, slot.outfit));
  return {
    slotIndex: slot.slotIndex,
    category: slot.category,
    location: place.name,
    timeOfDay: rngPick(rng, place.times),
    activity: rngPick(rng, allowedActivities(place, shot)).text,
    outfit,
    shot,
    pose: angled === null ? drawPose(poseRng, shot, NO_EXTRA_POSES) : angled.pose,
    attemptIdBase: slot.attemptIdBase,
    repeatedPair: false,
  };
}

/**
 * A built-in scene's redraw (plan r1.5 §5.2): the scene keeps its capture (an old scene whose capture the pool no longer deals takes one of the deck's, its own
 * shot's if the deck has one), draws a pose, then a place with a fitting moment (tiered against the set as before), one of its fitting moments, the moment's
 * pinned outfits first, and the legwear. The tiers prefer what the set does not already show, then anything but the scene's own.
 */
function redrawBuiltIn(input: RedrawInput, deck: readonly Capture[]): PlanSlot {
  const { seed, k, slot, pool, avoid } = input;
  const rng = makeRng(subSeed(seed, `redraw:${slot.slotIndex}:${k}`));
  const poseRng = makeRng(subSeed(seed, `redraw-pose:${slot.slotIndex}:${k}`));
  const fixRng = makeRng(subSeed(seed, `redraw-clean:${slot.slotIndex}:${k}`));
  const stored = slot.capture ?? captureOfShot(slot.shot);
  const sameShot = deck.filter((capture) => shotOf(capture) === shotOf(stored));
  const capture = deck.includes(stored) ? stored : rngPick(rng, sameShot.length > 0 ? sameShot : deck);
  const drawnPose = poseForCapture(capture, drawPose(poseRng, shotOf(capture), NO_EXTRA_POSES));
  // «Подача» (S5.7b): the scene keeps its level; a flirty one may take the flirty moments and, among its choices, takes one.
  const level = slot.level ?? "ordinary";
  const settled = settleFit(pool, kindOfDeck(deck), capture, drawnPose, level);
  const stepped = settled.capture !== capture || settled.pose !== drawnPose;
  // The angle comes from the scene (S5.7b, I5.26): the redrawn scene's pose is its moment's `angle`. A redraw never adds an away scene (a scene facing the camera never
  // redraws into one facing away), so a set keeps its ⌊n/5⌋ cap whatever its replacements; a scene that faces away may stay away or turn to the camera.
  const wasAway = slot.pose === "profile" || slot.pose === "back";
  const allowed = (m: Activity): boolean => wasAway || (m.angle !== "profile" && m.angle !== "back");
  const permitted = settled.places.filter((p) => fittingMoments(p, settled.capture, settled.pose, level).some(allowed));
  const place = rngPick(stepped ? fixRng : rng, preferred(permitted.length > 0 ? permitted : settled.places, (p) => p.name, avoid.locations, slot.location));
  const moments = fittingMoments(place, settled.capture, settled.pose, level).filter(allowed);
  const others = moments.filter((m) => m.text !== slot.activity);
  const choices = others.length > 0 ? others : moments;
  const flirtyChoices = level === "flirty" ? choices.filter((m) => m.level === "flirty") : [];
  const moment = rngPick(rng, flirtyChoices.length > 0 ? flirtyChoices : choices);
  const pinned = pinnedOutfitsOf(moment);
  const outfit = rngPick(rng, preferred(pinned.length > 0 ? pinned : generalOutfits(pool), (o) => o, avoid.outfits, slot.outfit));
  const roll = rng();
  const item = pool.legwear === undefined ? undefined : rngPick(rng, pool.legwear.items);
  const meta = outfitInfoOf(pool).find((o) => o.text === outfit);
  const legwear = pool.legwear !== undefined && meta !== undefined && legwearFits(moment, meta) && roll < pool.legwear.share ? item : undefined;
  return {
    slotIndex: slot.slotIndex,
    category: slot.category,
    location: place.name,
    timeOfDay: rngPick(rng, place.times),
    activity: moment.text,
    outfit,
    shot: shotOf(settled.capture),
    pose: moment.angle ?? settled.pose,
    attemptIdBase: slot.attemptIdBase,
    repeatedPair: false,
    ...(settled.capture === captureOfShot(shotOf(settled.capture)) ? {} : { capture: settled.capture }),
    ...(legwear === undefined ? {} : { legwear }),
    ...(level === "flirty" ? { level } : {}),
  };
}

export interface OwnDraw {
  shot: Shot;
  pose: Pose;
}

/** What «Авто» draws a shot from: the default deck without the mirror (an own scene has no place for a mirror to sit on). */
const AUTO_SHOTS: readonly Shot[] = ["friend", "selfie", "candid", "friend"];

/** The shot and the pose of each of an idea write's `count` own scenes. An explicit shot is kept as asked; «Авто» never draws the mirror. */
export function drawOwnScenes(input: { seed: number; k: number; count: number; shot: Shot | null }): OwnDraw[] {
  const rng = makeRng(subSeed(input.seed, `own:${input.k}`));
  const poseRng = makeRng(subSeed(input.seed, `own-pose:${input.k}`));
  return Array.from({ length: input.count }, () => {
    const shot = input.shot ?? rngPick(rng, AUTO_SHOTS);
    return { shot, pose: drawPose(poseRng, shot, NO_EXTRA_POSES) };
  });
}
