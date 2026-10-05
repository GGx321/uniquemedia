import { MAX_MONTAGE_ISSUES, montageIssues, type MontageDraft, type MontageIssue } from "../../shared/engine/montage";
import type { Library } from "../library";
import { photoAvailability, type Availability } from "./availability";
import { notYetSupportedIssues } from "../../shared/montage/notYetSupported";
import { trackIssues } from "../../shared/montage/trackIssues";
import type { TrackLookup } from "../music/renderTrack";
import { ownStickerIssues } from "../../shared/montage/ownStickers";
import { ownVideoIssues } from "../../shared/montage/ownVideos";
import { stickerIssues } from "../../shared/stickers/stickerIssues";
import { draftCaptionIssues } from "../../shared/text/draftCaptionIssues";

// The engine's verdict on a draft (`montages.get`, `montages.list`): the structural issues a render would raise
// (`montageIssues(spec, "spec")`, the same function `videos.render` uses), what a render refuses for a part whose slice
// has not landed (`not-yet-supported`, N9), plus the REFERENTIAL ones, which need the
// library. So the window's Render reason and its cell highlights are the engine's own answer.
//
// Referential checks, by the issue code the contract reserves for them (K7), and where each stands:
//   photo-unavailable    DONE  a scene photo that is not eligible, is in a video, or is held by a render.
//   sticker-unavailable  DONE  for a built-in sticker (its manifest is in the build). An own sticker: see below.
//   caption-invalid      DONE  a text layer whose caption breaks the shared caption rules (`layers.i.value`), by `draftCaptionIssues`, the function
//                        `videos.render` and the mock use too. The emoji font is not asked here: `emoji-missing` stays the rasteriser's.
//   media-unavailable    DONE  for an own PHOTO (`clips.i.cell`, `clips.i.cells.j`): the library does not hold it as a photo (3f.2).
//   media-unavailable   DONE  for an own VIDEO clip (`clips.i`): the library does not hold it as a video the render can read (3f.3b), judged after the photos.
//   media-unavailable    DONE  for an own STICKER (`layers.i.sticker`): the library does not hold it as a sticker (3f.5), judged after the
//                        built-in stickers' own verdict.
//   track-unavailable    DONE  a trending track that is not in the track store (`music`), by `trackIssues`, the function the mock uses
//                        too; with no store wired no track is held. TODO(3f.4) for an own track.
//   video-too-short      DONE  an own video clip that asks for more than its stored video has: `trimStartMs` plus the clip's length past the video's end (`clips.i`, 3f.3b).
//   track-too-short      DONE  a track (trending or own) shorter than `startMs` plus the montage's total (`music`).

/** One photo cell of a draft, scene or own, and where it is (the issue's path). */
interface PhotoCell {
  readonly photo: { readonly source: "scene"; readonly photoId: string } | { readonly source: "own"; readonly mediaId: string };
  readonly path: (string | number)[];
}

/** Every photo cell, in clip order and cell order. An empty cell has no photo to judge. */
function photoCells(spec: Pick<MontageDraft, "clips">): PhotoCell[] {
  const cells: PhotoCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo !== null) cells.push({ photo: clip.cell.photo, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo !== null) cells.push({ photo: cell.photo, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

/**
 * The referential issues of a draft, in order: photos (clips, then cells: a scene photo that is not usable, an own photo the library does
 * not hold), then stickers and captions (layers), then the music track. Not bounded here. `holdsOwnPhoto` says whether the library holds a media as a
 * photo, `holdsOwnSticker` as a sticker (3f.5), `ownTrack` as a track a render can read and how long it is (3f.4), `ownVideo` as a video a render can read and how long
 * it is (3f.3b); absent, none is held (an engine with no media store refuses an own photo, video, sticker or track the way a render does).
 */
export function referentialIssues(
  spec: MontageDraft,
  availability: Availability,
  tracks?: TrackLookup,
  holdsOwnPhoto?: (mediaId: string) => boolean,
  holdsOwnSticker?: (mediaId: string) => boolean,
  ownTrack?: (mediaId: string) => { readonly durationMs: number } | null,
  ownVideo?: (mediaId: string) => { readonly durationMs: number } | null,
): MontageIssue[] {
  const issues: MontageIssue[] = [];
  for (const cell of photoCells(spec)) {
    if (cell.photo.source === "scene") {
      if (!availability.usable(cell.photo.photoId)) issues.push({ code: "photo-unavailable", path: cell.path });
    } else if (!(holdsOwnPhoto?.(cell.photo.mediaId) ?? false)) {
      issues.push({ code: "media-unavailable", path: cell.path });
    }
  }
  issues.push(...ownVideoIssues(spec, (mediaId) => ownVideo?.(mediaId) ?? null));
  issues.push(...stickerIssues(spec));
  issues.push(...ownStickerIssues(spec, (mediaId) => holdsOwnSticker?.(mediaId) ?? false));
  issues.push(...draftCaptionIssues(spec));
  issues.push(...trackIssues(spec, tracks === undefined ? undefined : (trackId) => tracks.stored(trackId), ownTrack));
  return issues;
}

/**
 * Every issue of `spec` as the engine sees it now: what a render would refuse first (structure, then N9), then the referential ones, cut at `MAX_MONTAGE_ISSUES`. `availability`
 * is the avatar's photo state (`photoAvailability`); a caller judging many drafts of one avatar asks it once.
 */
export function draftIssues(
  library: Library,
  spec: MontageDraft,
  log: (line: string) => void,
  availability?: Availability,
  tracks?: TrackLookup,
  holdsOwnPhoto?: (mediaId: string) => boolean,
  holdsOwnSticker?: (mediaId: string) => boolean,
  ownTrack?: (mediaId: string) => { readonly durationMs: number } | null,
  ownVideo?: (mediaId: string) => { readonly durationMs: number } | null,
): MontageIssue[] {
  const known = availability ?? photoAvailability(library, spec.avatarId, log);
  return [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...referentialIssues(spec, known, tracks, holdsOwnPhoto, holdsOwnSticker, ownTrack, ownVideo)].slice(0, MAX_MONTAGE_ISSUES);
}
