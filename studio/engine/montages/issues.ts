import { MAX_MONTAGE_ISSUES, montageIssues, type MontageDraft, type MontageIssue } from "../../shared/engine/montage";
import type { Library } from "../library";
import { photoAvailability, type Availability } from "./availability";
import { notYetSupportedIssues } from "../../shared/montage/notYetSupported";
import { trackIssues } from "../../shared/montage/trackIssues";
import type { TrackLookup } from "../music/renderTrack";
import { stickerIssues } from "../../shared/stickers/stickerIssues";

// The engine's verdict on a draft (`montages.get`, `montages.list`): the structural issues a render would raise
// (`montageIssues(spec, "spec")`, the same function `videos.render` uses), what a render refuses for a part whose slice
// has not landed (`not-yet-supported`, N9), plus the REFERENTIAL ones, which need the
// library. So the window's Render reason and its cell highlights are the engine's own answer.
//
// Referential checks, by the issue code the contract reserves for them (K7), and where each stands:
//   photo-unavailable    DONE  a scene photo that is not eligible, is in a video, or is held by a render.
//   sticker-unavailable  DONE  for a built-in sticker (its manifest is in the build). An own sticker: see below.
//   caption-invalid      TODO(3b.3): the caption rules (charset, emoji coverage, youth words, the number table) do not
//                        exist yet; the check is `layers.i.value` against them, wired when 3b.3 and 3b.4b land.
//   media-unavailable    TODO(3f.1, 3f.3b): an own media id (`clips.i`, `clips.i.cells.j`, `music`, `layers.i.sticker`)
//                        missing or of the wrong kind; there is no media store to ask until slice 3f.
//   sticker-unavailable  TODO(3f.5) for an OWN sticker (its media id, in the same store).
//   track-unavailable    DONE  a trending track that is not in the track store (`music`), by `trackIssues`, the function the mock uses
//                        too; with no store wired no track is held. TODO(3f.4) for an own track.
//   track-too-short      DONE  a trending track shorter than `startMs` plus the montage's total (`music`). TODO(3f.4) for an own track.
// Nothing is invented for the TODOs: a render still refuses those parts with `not-yet-supported` (N9) until their slices land.

/** One scene-photo cell of a draft and where it is (the issue's path). */
interface SceneCell {
  readonly photoId: string;
  readonly path: (string | number)[];
}

function sceneCells(spec: Pick<MontageDraft, "clips">): SceneCell[] {
  const cells: SceneCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "scene") cells.push({ photoId: clip.cell.photo.photoId, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "scene") cells.push({ photoId: cell.photo.photoId, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

/** The referential issues of a draft, in order: photos (clips, then cells), then stickers (layers), then the music track. Not bounded here. */
export function referentialIssues(spec: MontageDraft, availability: Availability, tracks?: TrackLookup): MontageIssue[] {
  const issues: MontageIssue[] = [];
  for (const cell of sceneCells(spec)) {
    if (!availability.usable(cell.photoId)) issues.push({ code: "photo-unavailable", path: cell.path });
  }
  issues.push(...stickerIssues(spec));
  issues.push(...trackIssues(spec, tracks === undefined ? undefined : (trackId) => tracks.stored(trackId)));
  return issues;
}

/**
 * Every issue of `spec` as the engine sees it now: what a render would refuse first (structure, then N9), then the referential ones, cut at `MAX_MONTAGE_ISSUES`. `availability`
 * is the avatar's photo state (`photoAvailability`); a caller judging many drafts of one avatar asks it once.
 */
export function draftIssues(library: Library, spec: MontageDraft, log: (line: string) => void, availability?: Availability, tracks?: TrackLookup): MontageIssue[] {
  const known = availability ?? photoAvailability(library, spec.avatarId, log);
  return [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...referentialIssues(spec, known, tracks)].slice(0, MAX_MONTAGE_ISSUES);
}
