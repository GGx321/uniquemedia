import type { MontageDraft } from "../../../shared/engine";
import { clipAtFrame, clipRanges, FPS, FRAMES_PER_STEP, msToFrameFloor, STEP_MS, totalFrames, videoClipWindow } from "../../../shared/montage";
import { type AudioAction, type AudioState, audioCorrection } from "./audioSync";

// 3f.3b: an own video clip in the preview. A `<video>` of the clip's mezzanine (the very file the render cuts from, a constant 30 fps) follows the playhead
// clock, which stays the master (3d.4):
// - AT REST (paused, scrubbed, sought) the element is paused and shows exactly the stored frame the render puts on the playhead's frame: the clip's first
//   frame in the video (`videoClipWindow`, the trim) plus the frame's place in the clip. It is sought to the MIDDLE of that frame, so a time that rounds
//   either way still lands inside it, and never sought again while it already shows it or while a seek is under way (the element's own `seeked` asks
//   again, so the last frame a scrub asked for is the one that stays);
// - WHILE PLAYING it plays from the same place and is kept in step exactly as the music is (`audioCorrection`: nudged with hysteresis, moved when far
//   off, nothing corrected while it seeks or waits for data, silent past its end).
// A clip that asks for more than the video holds (`video-too-short`, which the render refuses) shows the video's last frame, never a time it lacks.

/** `HTMLMediaElement.HAVE_METADATA`: the element knows the file's length and size, so a seek means something. */
export const HAVE_METADATA = 1;

/** What the window can read off the `<video>`: the same as off the music's `<audio>`. */
export type VideoState = AudioState;

export interface VideoTarget {
  readonly clipId: string;
  readonly mediaId: string;
  /** Whether the montage is playing over this clip now. */
  readonly play: boolean;
  /** The stored video's frame on screen. */
  readonly frame: number;
  /** Where the element should be, in seconds of the stored video: the middle of `frame` at rest, the continuous time while playing. */
  readonly atSec: number;
}

/** A stored video's frame count from its record's length: the mezzanine's `durationMs` is `round(frames × 1000 / 30)`. */
export function storedFrames(durationMs: number): number {
  return Math.round((durationMs * FPS) / 1000);
}

/** The frame of a 30 fps video that time `sec` falls in (a hair of tolerance, so a frame's own start never reads as the frame before it). */
export function videoFrameAt(sec: number): number {
  return Math.floor(sec * FPS + 1e-6);
}

/**
 * What the `<video>` should show for the playhead: the own video clip under it and where in its stored video, or null when the frame on screen is not an
 * own video clip's. The frame is the preview stage's own (the montage's last frame at or past its end). `framesOf` gives a stored video's frame count
 * once its record is known (null before that): a clip asking past it shows the last frame.
 */
export function videoTarget(spec: MontageDraft, playhead: { readonly ms: number; readonly playing: boolean }, framesOf: (mediaId: string) => number | null): VideoTarget | null {
  const total = totalFrames(spec.clips);
  if (total === 0) return null;
  const ms = Math.max(0, playhead.ms);
  const at = clipAtFrame(clipRanges(spec.clips), Math.min(total - 1, msToFrameFloor(ms)));
  const clip = at === null ? undefined : spec.clips[at.index];
  if (at === null || clip === undefined || clip.kind !== "video") return null;
  const stored = framesOf(clip.mediaId);
  const last = stored === null ? Number.POSITIVE_INFINITY : Math.max(0, stored - 1);
  const frame = Math.min(videoClipWindow(clip).startFrame + at.localFrame, last);
  const totalMs = (total / FRAMES_PER_STEP) * STEP_MS;
  const play = playhead.playing && ms < totalMs;
  const base = { clipId: clip.clipId, mediaId: clip.mediaId, frame };
  if (!play) return { ...base, play: false, atSec: (frame + 0.5) / FPS };
  // The clip's start on the timeline is a whole number of 100 ms steps: no float creeps into the time.
  const clipStartMs = (at.range.startFrame / FRAMES_PER_STEP) * STEP_MS;
  return { ...base, play: true, atSec: (clip.trimStartMs + (ms - clipStartMs)) / 1000 };
}

/** What to do to the element so it shows `target`. */
export function videoCorrection(target: VideoTarget, video: VideoState): AudioAction {
  if (target.play) return audioCorrection({ play: true, atSec: target.atSec }, video);
  const play = video.paused ? null : false;
  // Getting somewhere already, or not knowing the file yet: its `seeked` / `loadedmetadata` asks again.
  if (video.seeking || video.readyState < HAVE_METADATA) return { seekSec: null, rate: 1, play };
  if (videoFrameAt(video.currentTimeSec) === target.frame) return { seekSec: null, rate: 1, play };
  return { seekSec: target.atSec, rate: 1, play };
}
