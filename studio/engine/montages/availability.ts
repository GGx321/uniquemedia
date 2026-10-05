import type { PhotoUnavailableReason } from "../../shared/engine";
import { LibraryError, type Library } from "../library";
import type { PhotoState } from "../library/eligibility";

// Whether an avatar's scene photos may go into a video, as the montage commands ask it (`montages.create`'s refusal,
// `montages.get` and `montages.list`'s issues). ONE question, answered by the library's own refusal-aware function
// (`eligibleUnusedPhotos`: eligible by the one rule, in no video record, held by no queued or running render), so a
// draft's verdict and a render's refusal can never disagree.
//
// While the avatar's usage cannot be trusted (an unreadable record or reject log, a stale used index, a record from a
// newer Studio) `eligibleUnusedPhotos` throws: a photo may look free and be in a video. Every caller then fails CLOSED,
// as `videos.render` does: no photo is usable. `montages.create` refuses (with the state told apart, `too-new` being
// LIBRARY_TOO_NEW), and `montages.get` and `montages.list` mark every photo of the draft `photo-unavailable`, so the
// window's Render reason is what the render will say.

export type Availability =
  | { readonly state: "known"; usable(photoId: string): boolean; why(photoId: string): PhotoUnavailableReason | undefined }
  | { readonly state: "too-new"; usable(photoId: string): boolean }
  | { readonly state: "untrusted"; readonly reason: Extract<PhotoUnavailableReason, "index-stale" | "log-needs-repair">; usable(photoId: string): boolean };

/**
 * Why an ELIGIBLE photo that is not free is not (`PhotoUnavailableReason`): it is in a video, or a queued or running render holds it. Undefined for a
 * photo the one eligibility rule already refuses (rejected, master, foreign, missing: nothing the owner can wait out) and for a free one.
 */
export function refusalReasonOf(state: PhotoState | undefined): PhotoUnavailableReason | undefined {
  if (state === undefined || !state.eligible) return undefined;
  if (state.usedIn.length > 0) return "in-video";
  return state.reserved ? "held-by-render" : undefined;
}

/** `usable` for a `known` state: eligible, unused and unreserved. For any other state: nothing is usable (fail closed). */
export function photoAvailability(library: Library, avatarId: string, log?: (line: string) => void): Availability {
  try {
    const free = new Set(library.eligibleUnusedPhotos(avatarId).map((photo) => photo.id));
    const states = library.photoStates(avatarId);
    return { state: "known", usable: (photoId) => free.has(photoId), why: (photoId) => refusalReasonOf(states.get(photoId)) };
  } catch (error) {
    if (error instanceof LibraryError) {
      const none = (): boolean => false;
      if (error.code === "library-too-new") {
        log?.("the usage of an avatar's photos cannot be judged: a video record was written by a newer Studio; none of its photos is usable until then");
        return { state: "too-new", usable: none };
      }
      if (error.code === "index-stale" || error.code === "log-needs-repair") {
        // The library's message names a record file: only its code is kept.
        log?.(`the usage of an avatar's photos cannot be trusted right now (${error.code}); none of its photos is usable until then`);
        return { state: "untrusted", reason: error.code, usable: none };
      }
    }
    throw error;
  }
}
