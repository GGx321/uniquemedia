import { PORTRAIT_MIN_LIKENESS } from "../../shared/engine";
import { passesAgeThreshold } from "../avatars/ageCheck";
import type { PhotoSidecar } from "./schemas";

// Stage 5, S5.3a: the rules for the reference portrait of an imported avatar. A portrait is not a new kind of photo: it is a generated photo of the avatar whose slot is
// `portrait-N` and whose `qa.faceCos` is its likeness to the imported photo (the avatar's «source»). Wizard candidates are `candidate-N`, so the two never collide, and a
// portrait never carries a scene category, so it is never a gallery photo and never eligible for a video (`looksLikeRunPhoto`, `isEligiblePhoto`).

const PORTRAIT_SLOT = /^portrait-[1-5]$/;

/** A generated photo in a portrait slot (`portrait-1` to `portrait-5`) with no scene category. */
export function isPortraitPhoto(sidecar: PhotoSidecar): boolean {
  return sidecar.source.kind === "generated" && sidecar.source.category === undefined && sidecar.source.slot !== undefined && PORTRAIT_SLOT.test(sidecar.source.slot);
}

/**
 * Whether a portrait may become the master (I5.17): its stored likeness reaches the face gate's threshold and its stored age verdict still passes today's threshold.
 * A portrait with no stored likeness is never pickable: only a ranked image is stored, so one without a score was not made by this feature.
 */
export function isPickablePortrait(sidecar: PhotoSidecar): boolean {
  const likeness = sidecar.qa.faceCos;
  return isPortraitPhoto(sidecar) && likeness !== undefined && likeness >= PORTRAIT_MIN_LIKENESS && passesAgeThreshold(sidecar.qa.age);
}

/** Best likeness first, ties by photo id: the order every list of portraits uses. */
export function byLikenessThenId(a: PhotoSidecar, b: PhotoSidecar): number {
  const diff = (b.qa.faceCos ?? -Infinity) - (a.qa.faceCos ?? -Infinity);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
