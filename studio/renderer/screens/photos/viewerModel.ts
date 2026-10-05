import type { PhotoSummary } from "../../../shared/engine";

// The photo viewer on the «Фото» tab, its logic pure: the photo on screen is held by its id, so a list that changes under it
// (a run's new photo in front, a mark set, a photo gone) moves its number, never what it shows; a photo the list no longer
// holds has no place, and the viewer closes.

/** Where the photo on screen stands in the viewer's list. */
export interface ViewerPlace {
  /** The photo as the list has it now: a mark set since is already on it. */
  readonly photo: PhotoSummary;
  /** From zero: the title shows `index + 1`. */
  readonly index: number;
  readonly total: number;
  /** The photo before it and after it, or null at an end (no wrap). */
  readonly prevId: string | null;
  readonly nextId: string | null;
}

/** The photo's place in `list`, by id; null when the list no longer holds it. */
export function viewerPlace(list: readonly PhotoSummary[], photoId: string): ViewerPlace | null {
  const index = list.findIndex((p) => p.photoId === photoId);
  const photo = list[index];
  if (photo === undefined) return null;
  return { photo, index, total: list.length, prevId: list[index - 1]?.photoId ?? null, nextId: list[index + 1]?.photoId ?? null };
}

/**
 * What the arrows step through: the gallery's photos under its filter (`shown`, in the gallery's order), and the photo on
 * screen even when it no longer matches that filter, for whatever reason (rejected in the viewer under «Неиспользованные»,
 * restored under «Отклонённые», marked or put into a video by another window): it keeps its gallery place until the owner
 * steps away from it, so a change of state never closes the viewer under him. A photo gone from the gallery itself (`all`)
 * is not brought back.
 */
export function viewerPhotos(all: readonly PhotoSummary[], shown: readonly PhotoSummary[], currentId: string | null): readonly PhotoSummary[] {
  if (currentId === null || shown.some((p) => p.photoId === currentId)) return shown;
  const kept = new Set(shown.map((p) => p.photoId));
  return all.filter((p) => kept.has(p.photoId) || p.photoId === currentId);
}

export type ViewerStep = "prev" | "next";

/** The parts of a keydown the viewer reads. */
export interface StepKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** ← and → step; with a modifier held they belong to someone else (the system, a text field), and do not. */
export function viewerStep(event: StepKey): ViewerStep | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return "prev";
  if (event.key === "ArrowRight") return "next";
  return null;
}
