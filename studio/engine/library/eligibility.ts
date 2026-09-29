import { passesAgeThreshold } from "../avatars/ageCheck";
import { looksLikeRunPhoto } from "./photoRecords";
import type { PhotoSidecar, RejectedEntry } from "./schemas";

// The ONE eligibility rule (Stage 3 plan, A1, invariant 18): may this photo go
// into a video? `Library.photoStates` applies it once per photo, and
// `photos.list`, the avatar counts, the montage bin, `eligibleUnusedPhotos`
// and the render's own refusal all read that answer. Nothing else decides.

/** Where one photo stands, from the library's own records; `Library.photoStates` answers one per photo. */
export interface PhotoState {
  /** The rule's verdict. Used and reserved are not part of it. */
  eligible: boolean;
  /** The owner's own «do not use» mark. */
  rejected: boolean;
  /** A queued or running render holds it (S16). */
  reserved: boolean;
  /** The videos whose records list it, sorted; non-empty means used. */
  usedIn: string[];
}

/**
 * A photo may go into a video only when ALL of these hold:
 * - it is a generated scene photo of a photo run (`looksLikeRunPhoto`: a
 *   generated frame that carries a scene category). Never a candidate portrait
 *   (no category), never an imported avatar's photo (not generated), and never
 *   the master portrait, even one that somehow carries a category;
 * - `passesAgeThreshold`: a stored verdict must pass today's threshold. A photo
 *   with NO verdict passes. The per-photo age check is off by default (owner,
 *   2026-09-27), so an unchecked photo is the normal case, and requiring a
 *   verdict would leave nothing eligible with the default settings. With the
 *   check on, invariant 8 already keeps a failing photo out of the library;
 * - the owner has not rejected it.
 *
 * Whether the photo belongs to a given avatar is the caller's lookup: the
 * library asks per avatar, so another avatar's photo is never a candidate.
 */
export function isEligiblePhoto(photo: PhotoSidecar, context: { masterPhotoId: string | null; rejected: boolean }): boolean {
  return looksLikeRunPhoto(photo) && photo.id !== context.masterPhotoId && passesAgeThreshold(photo.qa.age) && !context.rejected;
}

/** The photos left rejected once the marks are replayed in order: the last op per photo wins. */
export function replayRejected(entries: readonly RejectedEntry[]): Set<string> {
  const rejected = new Set<string>();
  for (const entry of entries) {
    if (entry.op === "reject") rejected.add(entry.photoId);
    else rejected.delete(entry.photoId);
  }
  return rejected;
}
