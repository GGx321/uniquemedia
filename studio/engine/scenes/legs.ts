import { shotOf, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import type { Outfit } from "../../shared/scenes/banks/types";
import { generalOutfits, outfitInfoOf } from "./fit";
import type { Activity, Place, Pool } from "./pools";

// 5a.2c (S5.8a, plan s5a2 §7.2, I5.29): the pure core of «Ножки» in the planner and in «Другая сцена». A legs slot is not dealt a capture from the category's deck: it
// draws a legs moment of a place that has one, and the capture comes with the moment (`pov-legs`, `low-feet`, or a mirror frame with her feet to the glass). Nothing
// is drawn here.

/** A legs moment: the bank tags it `legs`, and it is drawn only on a legs slot (`momentAllowed` with the framing). */
export const isLegsMoment = (moment: Activity): boolean => moment.legs !== undefined;

/**
 * The captures a legs moment may take at a place: those it lists that a legs slot allows (a hand-held capture takes no two-handed or phone moment), a mirror frame
 * only at a mirror place. Its pose is the moment's angle, else front: the legs frame's own pose phrase does not read it.
 */
export function legsCapturesAt(place: Pick<Place, "mirror">, moment: Activity): readonly Capture[] {
  return (moment.captures ?? []).filter((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && momentAllowed(moment, capture, moment.angle ?? "front", "ordinary", "legs"));
}

/** The legs moments of a place a legs slot can take, each with at least one capture. */
export function legsMomentsAt(place: Pick<Place, "activities" | "mirror">): readonly Activity[] {
  return place.activities.filter((moment) => isLegsMoment(moment) && legsCapturesAt(place, moment).length > 0);
}

/** The places of a pool that have a legs moment. Empty for a custom pool: a custom category draws no legs. */
export function legsPlacesOf(pool: Pick<Pool, "locations">): readonly Place[] {
  return pool.locations.filter((place) => legsMomentsAt(place).length > 0);
}

/** Whether a pool can deal a legs slot at all: a built-in pool (it deals captures) with a legs moment. */
export function hasLegs(pool: Pick<Pool, "locations" | "captureDeck">): boolean {
  return pool.captureDeck !== undefined && legsPlacesOf(pool).length > 0;
}

/** The outfits a legs slot draws from when its moment pins none: the general ones that show her legs (all the general ones if the pool has none that does). */
export function legsOutfitsOf(pool: Pick<Pool, "outfits" | "outfitInfo" | "locations">): readonly string[] {
  const general = generalOutfits(pool);
  const info: readonly Outfit[] = outfitInfoOf(pool);
  const showing = general.filter((text) => info.find((o) => o.text === text)?.showsLegs === true);
  return showing.length > 0 ? showing : general;
}
