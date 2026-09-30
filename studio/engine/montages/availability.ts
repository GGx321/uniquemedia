import { LibraryError, type Library } from "../library";

// Whether an avatar's scene photos may go into a video, as the montage commands ask it (`montages.create`'s refusal,
// `montages.get` and `montages.list`'s issues). ONE question, answered by the library's own refusal-aware function
// (`eligibleUnusedPhotos`: eligible by the one rule, in no video record, held by no queued or running render), so a
// draft's verdict and a render's refusal can never disagree.
//
// While the avatar's usage cannot be trusted (an unreadable record or reject log, a stale used index, a record from a
// newer Studio) `eligibleUnusedPhotos` throws: a photo may look free and be in a video. What each caller does then
// differs, so this answers the state and leaves the decision to it:
//   - `montages.create` refuses (fail closed, like `videos.render`);
//   - `montages.get` and `montages.list` fall back to the eligibility rule alone (`usable`), which still catches a
//     rejected, missing, foreign or master photo, and say nothing about "used" (the render still refuses those).

export type Availability =
  | { readonly state: "known"; usable(photoId: string): boolean }
  | { readonly state: "too-new"; usable(photoId: string): boolean }
  | { readonly state: "untrusted"; readonly reason: "index-stale" | "log-needs-repair"; usable(photoId: string): boolean };

/** `usable` for a `known` state: eligible, unused and unreserved. For any other state: eligible by the rule alone. */
export function photoAvailability(library: Library, avatarId: string, log?: (line: string) => void): Availability {
  try {
    const free = new Set(library.eligibleUnusedPhotos(avatarId).map((photo) => photo.id));
    return { state: "known", usable: (photoId) => free.has(photoId) };
  } catch (error) {
    if (error instanceof LibraryError) {
      const eligibleOnly = (photoId: string): boolean => library.isEligible(avatarId, photoId);
      if (error.code === "library-too-new") {
        log?.("the usage of an avatar's photos cannot be judged: a video record was written by a newer Studio; photos are judged by the eligibility rule alone");
        return { state: "too-new", usable: eligibleOnly };
      }
      if (error.code === "index-stale" || error.code === "log-needs-repair") {
        // The library's message names a record file: only its code is kept.
        log?.(`the usage of an avatar's photos cannot be trusted right now (${error.code}); photos are judged by the eligibility rule alone`);
        return { state: "untrusted", reason: error.code, usable: eligibleOnly };
      }
    }
    throw error;
  }
}
