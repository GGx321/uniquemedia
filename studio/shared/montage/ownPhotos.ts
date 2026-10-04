import type { MontageDraft, MontageIssue } from "../engine/montage";

// An own photo in a cell (Stage 3, 3f.2): where the spec names one, and which of them the library no longer holds. Pure, and shared: the
// engine (`videos.render`'s admission, `montages.get` and `list`) and the renderer's mock use THESE, so a draft's issues and a render's refusal
// cannot be worded differently. The check itself (does the library hold this media, as a photo) is the caller's: it is asked by id.

/** One own photo in a spec: its media id and the cell it sits in, as an issue's path (`["clips", 2, "cells", 1]`). */
export interface OwnPhotoCell {
  readonly mediaId: string;
  readonly path: (string | number)[];
}

/** Every own photo of `spec`, in clip order and cell order. A media used by two cells is listed twice. */
export function ownPhotoCells(spec: Pick<MontageDraft, "clips">): OwnPhotoCell[] {
  const cells: OwnPhotoCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "own") cells.push({ mediaId: clip.cell.photo.mediaId, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "own") cells.push({ mediaId: cell.photo.mediaId, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

/** `media-unavailable` at the cell of each own photo that `isAvailable` says is gone (or not a photo): one issue per cell, in order. */
export function ownPhotoIssues(spec: Pick<MontageDraft, "clips">, isAvailable: (mediaId: string) => boolean): MontageIssue[] {
  return ownPhotoCells(spec)
    .filter((cell) => !isAvailable(cell.mediaId))
    .map((cell) => ({ code: "media-unavailable" as const, path: cell.path }));
}
