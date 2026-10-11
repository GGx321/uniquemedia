import type { ScenePose } from "../../shared/engine";
import { posesFor, shotOf, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { isOwnerBannedOutfit } from "../../shared/scenes/words";
import type { Level, Outfit } from "../../shared/scenes/banks/types";
import { EVERYDAY_OUTFITS, type Activity, type Place, type Pool } from "./pools";

// 5a.2 (S5.6b, I5.23, plan s5a2 §5.2): the pure core of the built-in draw. The planner picks a slot's capture from the category's deck, then its pose, then
// a PLACE THAT HAS A FITTING MOMENT, then the least-used fitting moment there. «Fitting» is the shared `momentAllowed` (the moment lists the capture and fits
// the pose; a hand-held capture takes no two-handed or phone moment; a viewer-gaze moment is never on a candid, profile, back or face-hidden frame). With the
// banks' coverage rule (every deck capture has a moment for every pose the slice can draw) every built-in slot finds a place and a moment here, so the
// fallback chain below is never read by a built-in plan: only a custom pool, or an impossible case a test builds, ever reaches it, and it draws on `clean:`.

/** The moments of a place a slot of this capture, pose and level may take: a flirty slot takes the flirty moments and the ordinary ones, an ordinary slot only the ordinary. */
export function fittingMoments(place: { activities: readonly Activity[] }, capture: Capture, pose: ScenePose, level: Level = "ordinary"): readonly Activity[] {
  return place.activities.filter((activity) => momentAllowed(activity, capture, pose, level));
}

/** The places of a pool that have a fitting moment for the capture and pose; a mirror capture only on a mirror place. */
export function fittingPlaces(pool: Pick<Pool, "locations">, capture: Capture, pose: ScenePose, level: Level = "ordinary"): Place[] {
  const mirror = shotOf(capture) === "mirror";
  return pool.locations.filter((place) => (!mirror || place.mirror === true) && fittingMoments(place, capture, pose, level).length > 0);
}

/** Who takes a category's photos, read from its deck: all herself («Дом»: no friend), mostly someone she asked («Улица», «Виды»), or both («Гламур», «Фитнес»). */
export type PoolKind = "self" | "asked" | "mixed";

/** A pool's kind from its deck: no friend or candid in it is self-shot; a deck of friends with no mirror is asked; the rest is mixed. */
export function kindOfDeck(deck: readonly Capture[]): PoolKind {
  if (!deck.some((capture) => capture === "friend" || capture === "candid")) return "self";
  return deck.some((capture) => shotOf(capture) === "mirror") ? "mixed" : "asked";
}

const SELF_STEP: Partial<Record<Capture, Capture>> = { "mirror-hidden": "mirror", mirror: "selfie", "over-shoulder": "prone", prone: "above", above: "selfie", timer: "selfie" };
const ASKED_STEP: Partial<Record<Capture, Capture>> = { timer: "friend", selfie: "friend" };
// «Гламур», «Фитнес»: as the self-shot family, then a friend.
const MIXED_STEP: Partial<Record<Capture, Capture>> = { ...SELF_STEP, selfie: "friend" };

/**
 * The next capture of the fallback chain (plan §5.2 step 2), or undefined at its end. The family stays within the category's kind: «Дом» never steps to a
 * friend, so I5.32's «no friend at home» holds even for a slot nothing fits.
 */
export function stepDownOf(kind: PoolKind, capture: Capture): Capture | undefined {
  return (kind === "self" ? SELF_STEP : kind === "asked" ? ASKED_STEP : MIXED_STEP)[capture];
}

export interface Settled {
  capture: Capture;
  pose: ScenePose;
  places: Place[];
}

/**
 * The slot's capture and pose and the places that fit them, after the fallback chain if nothing fits (plan §5.2). The first step, a redraw of the place
 * among the places with a moment for the capture, is the caller's own pick among `places` (on `clean:`); the chain here is the rest, one step at a time:
 * 1. step the capture down its family (`stepDownOf`), a pose it cannot take becoming three-quarter;
 * 2. a back or profile pose becomes three-quarter;
 * 3. a candid becomes a friend (asked and mixed decks only).
 * Nothing is drawn here, so a built-in plan that needs no step never touches the `clean:` stream. Throws when the whole chain finds nothing (an empty pool):
 * that is a bug in the pool, never a run.
 */
export function settleFit(pool: Pick<Pool, "locations">, kind: PoolKind, capture: Capture, pose: ScenePose, level: Level = "ordinary"): Settled {
  let current = capture;
  let currentPose = pose;
  for (let guard = 0; guard < 16; guard++) {
    const places = fittingPlaces(pool, current, currentPose, level);
    if (places.length > 0) return { capture: current, pose: currentPose, places };
    const down = stepDownOf(kind, current);
    if (down !== undefined) {
      current = down;
      if (!posesFor(current).includes(currentPose)) currentPose = "three-quarter";
    } else if (currentPose !== "front" && currentPose !== "three-quarter") currentPose = "three-quarter";
    else if (current === "candid" && kind !== "self") current = "friend";
    else break;
  }
  throw new RangeError(`no place of the pool has a moment for ${capture} at ${pose}, nor for any step down the fallback chain`);
}

/** A pool's outfits with their marks: a built-in pool's, or (a custom pool, a test pool) the plain texts. */
export function outfitInfoOf(pool: Pick<Pool, "outfits" | "outfitInfo">): readonly Outfit[] {
  return pool.outfitInfo ?? pool.outfits.map((text) => ({ text }));
}

/**
 * The pose a drawn pose becomes for a capture (plan r1.5 #3): the over-the-shoulder POV looks back along her body, so it is always three-quarter; the pose stream still
 * draws one pose per slot, so no other stream moves. Any other capture keeps the pose it drew (a hand-held one was drawn front or three-quarter already).
 */
export function poseForCapture(capture: Capture, drawn: ScenePose): ScenePose {
  return posesFor(capture).includes(drawn) ? drawn : "three-quarter";
}

/**
 * The outfits of the general draw (plan r1.5, 22.3): not pin-only (those are worn only by the moment that pins them) and not the owner's denim shorts or skirts. An
 * outfit some moment pins stays in the general draw: the pin only decides what THAT moment wears. A pool left with none draws the shared everyday list.
 */
export function generalOutfits(pool: Pick<Pool, "outfits" | "outfitInfo" | "locations">): readonly string[] {
  const general = outfitInfoOf(pool)
    .filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text))
    .map((o) => o.text);
  return general.length > 0 ? general : EVERYDAY_OUTFITS;
}

/** The outfits a moment pins, after the owner's denim rule; empty when it pins none (or none are left). */
export function pinnedOutfitsOf(moment: Pick<Activity, "outfits">): readonly string[] {
  return (moment.outfits ?? []).filter((outfit) => !isOwnerBannedOutfit(outfit));
}
