import type { MontageDraft, MontageIssue } from "../engine/montage";

// An own sticker in a layer (Stage 3, 3f.5): where the spec names one, and which of them the library no longer holds (as a sticker). Pure, and
// shared: the engine (`videos.render`'s admission, `montages.get` and `list`) and the renderer's mock use THESE, so a draft's issues and a render's
// refusal cannot be worded differently. The check itself (does the library hold this media, as a sticker) is the caller's: it is asked by id.
// Built-in stickers are judged by `stickerIssues` (`sticker-unavailable`); an own one is `media-unavailable`, as an own photo is.

/** One own sticker in a spec: its media id and where it is, as an issue's path (`["layers", 2, "sticker"]`). */
export interface OwnStickerCell {
  readonly mediaId: string;
  readonly path: (string | number)[];
}

/** Every own sticker of `spec`, in layer order. A media used by two layers is listed twice. */
export function ownStickerCells(spec: Pick<MontageDraft, "layers">): OwnStickerCell[] {
  const cells: OwnStickerCell[] = [];
  spec.layers.forEach((layer, i) => {
    if (layer.kind === "sticker" && layer.sticker.source === "own") cells.push({ mediaId: layer.sticker.mediaId, path: ["layers", i, "sticker"] });
  });
  return cells;
}

/** `media-unavailable` at the sticker of each own-sticker layer that `isAvailable` says is gone (or not a sticker): one issue per layer, in order. */
export function ownStickerIssues(spec: Pick<MontageDraft, "layers">, isAvailable: (mediaId: string) => boolean): MontageIssue[] {
  return ownStickerCells(spec)
    .filter((cell) => !isAvailable(cell.mediaId))
    .map((cell) => ({ code: "media-unavailable" as const, path: cell.path }));
}
