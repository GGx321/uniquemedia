import { createContext, useContext } from "react";
import type { PhotoSummary } from "../../../shared/engine";
import { montagePickRefusal } from "./photoState";

/** 5b.2 (S5.WB4, Q-J = 1): what a gallery pick is for — a montage («Монтаж из выбранных») or a batch of clips («Оживить выбранные»). */
export type PickMode = "montage" | "clips";

// Slice review 5-L3: the photos the owner picked on an avatar's Photos screen for «Монтаж из выбранных», kept by the window while it runs, per
// avatar and in the order picked. The screen unmounts on any navigation (a look at Settings, the editor and back); the picks must not go with it.
// A draft made of them clears them. One per window (App provides it), never saved: a new window starts with none.
// 5b.2 (S5.WB4, Q-J = 1): the gallery's «Выбор: для монтажа · для клипов» — each mode has its own set, and the mode on show is kept per avatar too, so a
// look elsewhere and back finds both sets and the mode as they were. A montage is the default mode.

export class MontagePicks {
  readonly #picked: Record<PickMode, Map<string, readonly string[]>> = { montage: new Map(), clips: new Map() };
  readonly #modes = new Map<string, PickMode>();

  /** The photos picked for `avatarId` in `mode` (a montage by default), in the order they were picked. */
  get(avatarId: string, mode: PickMode = "montage"): ReadonlySet<string> {
    return new Set(this.#picked[mode].get(avatarId) ?? []);
  }

  /** The picks of `avatarId` in `mode` are now `picked` (none: forgotten); the other mode's stay. */
  set(avatarId: string, picked: ReadonlySet<string>, mode: PickMode = "montage"): void {
    if (picked.size === 0) this.#picked[mode].delete(avatarId);
    else this.#picked[mode].set(avatarId, [...picked]);
  }

  /** What a pick on `avatarId`'s gallery is for now: a montage until the owner switches. */
  mode(avatarId: string): PickMode {
    return this.#modes.get(avatarId) ?? "montage";
  }

  setMode(avatarId: string, mode: PickMode): void {
    if (mode === "montage") this.#modes.delete(avatarId);
    else this.#modes.set(avatarId, mode);
  }

  /** Forgets every avatar's picks and modes: the library was switched (review r1 LOW-7), its photos are another library's. */
  clear(): void {
    this.#picked.montage.clear();
    this.#picked.clips.clear();
    this.#modes.clear();
  }
}

/**
 * The picks the gallery still offers (review r1 LOW-6), in the order picked: kept picks are checked once the gallery answers, since a photo may have
 * gone into a video or a render, been rejected, or left the library while the screen was away. The same set when none goes.
 *
 * `partial` (S4.P2): `photos` is not the whole gallery but some of its pages, so a pick it does not list may stand on a page not read yet; it is
 * kept, and checked when its page comes in.
 *
 * `refusal` (5b.2): the mode's own predicate — `montagePickRefusal` by default, `clipPickRefusal` for the clips' set (which keeps a photo in a video or a rejected one).
 */
export function usablePicks(picked: ReadonlySet<string>, photos: readonly PhotoSummary[], partial = false, refusal: (photo: PhotoSummary) => string | null = montagePickRefusal): ReadonlySet<string> {
  const offered = new Set(photos.filter((p) => refusal(p) === null).map((p) => p.photoId));
  const listed = new Set(photos.map((p) => p.photoId));
  const kept = [...picked].filter((photoId) => offered.has(photoId) || (partial && !listed.has(photoId)));
  return kept.length === picked.size ? picked : new Set(kept);
}

const MontagePicksContext = createContext<MontagePicks | null>(null);

export const MontagePicksProvider = MontagePicksContext.Provider;

export function useMontagePicks(): MontagePicks {
  const picks = useContext(MontagePicksContext);
  if (!picks) throw new Error("useMontagePicks must be used inside <MontagePicksProvider>");
  return picks;
}

/**
 * S4.P2 (review MEDIUM-2): once every page is read, a pick of a photo on none of them is of a photo that has gone (left the library,
 * unreadable now) while the pick was kept for its page; it goes. Only those: a listed pick, usable or not, is the first check's to judge.
 * The same set when none goes.
 */
export function listedPicks(picked: ReadonlySet<string>, photos: readonly PhotoSummary[]): ReadonlySet<string> {
  const listed = new Set(photos.map((p) => p.photoId));
  const kept = [...picked].filter((photoId) => listed.has(photoId));
  return kept.length === picked.size ? picked : new Set(kept);
}
