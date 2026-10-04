import type { Focus, MontageDraft, MontageIssue } from "../engine/montage";
import { FRAME_H, FRAME_W } from "./constants";
import { coverCrop } from "./crop";
import { msToFrames } from "./timeline";
import type { Rect, Size } from "./types";

// An own video clip (Stage 3, 3f.3b): where a spec names one, which of them the library cannot give, and which part of the stored video it plays. Pure, and
// shared: the engine (`videos.render`'s admission, `montages.get` and `list`, the pass-1 builder) and the renderer (the mock, the preview) use THESE, so a
// draft's issues, a render's refusal and the picture cannot be worded or drawn differently. The check itself (does the library hold this media as a video,
// and how long is it) is the caller's: it is asked by id.
//
// The stored video is the importer's mezzanine (3f.3a): constant 30 fps, so a time on the montage's 100 ms grid is a whole number of frames
// (`FRAMES_PER_STEP` = 3), its `durationMs` is `round(frames * 1000 / 30)`, and a clip is the frames `[startFrame, startFrame + frames)` of it.

/** One own video clip in a spec: its media id, the clip's place as an issue's path (`["clips", 2]`), where it starts in the stored video and how long it plays. */
export interface OwnVideoClip {
  readonly mediaId: string;
  readonly path: (string | number)[];
  readonly trimStartMs: number;
  readonly durationMs: number;
}

/** Every own video clip of `spec`, in clip order. A media used by two clips is listed twice. */
export function ownVideoClips(spec: Pick<MontageDraft, "clips">): OwnVideoClip[] {
  const clips: OwnVideoClip[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "video") clips.push({ mediaId: clip.mediaId, path: ["clips", i], trimStartMs: clip.trimStartMs, durationMs: clip.durationMs });
  });
  return clips;
}

/**
 * The referential issues of the own video clips, one per clip, in clip order: `media-unavailable` at the clip when `stored` says the library does not hold its
 * media as a video a render can read (null), `video-too-short` when `trimStartMs` plus the clip's length is more than the stored video's length (equal passes).
 * A media that is not there is never also too short: there is no length to judge.
 */
export function ownVideoIssues(spec: Pick<MontageDraft, "clips">, stored: (mediaId: string) => { readonly durationMs: number } | null): MontageIssue[] {
  const issues: MontageIssue[] = [];
  for (const clip of ownVideoClips(spec)) {
    const held = stored(clip.mediaId);
    if (held === null) issues.push({ code: "media-unavailable", path: clip.path });
    else if (clip.trimStartMs + clip.durationMs > held.durationMs) issues.push({ code: "video-too-short", path: clip.path });
  }
  return issues;
}

/**
 * The frames a video clip plays out of the stored video: from `startFrame`, `frames` of them. Exact: a time off the 100 ms grid is a `RangeError`, never
 * rounded (the contract already refuses one).
 */
export function videoClipWindow(clip: { readonly trimStartMs: number; readonly durationMs: number }): { startFrame: number; frames: number } {
  return { startFrame: msToFrames(clip.trimStartMs), frames: msToFrames(clip.durationMs) };
}

/**
 * The part of a stored video (in its own pixels, whole and even) that fills the whole 1080 x 1920 frame: the same cover-crop a photo's cell gets, centred on the
 * clip's focus (or the face-less fallback for none). The graph builder crops exactly this and the preview shows exactly this region.
 */
export function videoClipCrop(source: Size, focus: Focus | null): Rect {
  return coverCrop(source, { w: FRAME_W, h: FRAME_H }, focus);
}
