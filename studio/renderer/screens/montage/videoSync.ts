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
  /**
   * Where the video's time sits against the montage's on this clip: `trimStartMs` less the clip's start on the timeline. Constant while one clip plays
   * (and across the parts of a plain split, which continue the video); it changes where the video's time JUMPS: a cut to a part that starts elsewhere
   * in the video, or a trim edited while playing.
   */
  readonly offsetMs: number;
  /** The stored video's frame on screen. */
  readonly frame: number;
  /** Where the element should be, in seconds of the stored video: the middle of `frame` at rest, the continuous time while playing. */
  readonly atSec: number;
}

/** What to do to the element, and the offset (`VideoTarget.offsetMs`) it plays on after it: passed back to the next correction. */
export interface VideoAction extends AudioAction {
  readonly anchorMs: number;
}

/** Half a 30 fps frame: a jump the element already sits within needs no seek. */
export const HALF_FRAME_SEC = 0.5 / FPS;

/**
 * The most a seek while playing is led by (fix round 1, the open question): a slow software decoder takes long enough over a seek (340 ms probed in
 * Chrome at 6× CPU throttling, over a second at 20×) that the element lands that far behind the clock and is sought again, and again; led by the last
 * seek's own time, it lands about where the clock is by then. Past a second the decoder is too slow to follow anyway.
 */
export const MAX_SEEK_LEAD_SEC = 1;

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
  // The clip's start on the timeline is a whole number of 100 ms steps: no float creeps into the time.
  const clipStartMs = (at.range.startFrame / FRAMES_PER_STEP) * STEP_MS;
  const base = { clipId: clip.clipId, mediaId: clip.mediaId, offsetMs: clip.trimStartMs - clipStartMs, frame };
  if (!play) return { ...base, play: false, atSec: (frame + 0.5) / FPS };
  return { ...base, play: true, atSec: (clip.trimStartMs + (ms - clipStartMs)) / 1000 };
}

/**
 * Stored frame `frame` of video `mediaId` at rest: what «Обрезка» shows while one of its edges or its window is dragged (fix round 1, L8), whatever the
 * playhead. The clip and offset are the playhead's own target's when it is on this video (so a playback that goes on after the drag sees no jump).
 */
export function peekTarget(onScreen: VideoTarget | null, mediaId: string, frame: number): VideoTarget {
  const same = onScreen !== null && onScreen.mediaId === mediaId;
  return { clipId: same ? onScreen.clipId : "", mediaId, play: false, offsetMs: same ? onScreen.offsetMs : 0, frame, atSec: (frame + 0.5) / FPS };
}

/**
 * What to do to the element so it shows `target`. `anchorMs` is the offset the element was put on last (the previous action's `anchorMs`; null before its
 * first): while playing, a different offset is a JUMP in the video's time (fix round 1, M2), and the element is moved there at once when it is more than
 * half a frame off, as the render cuts; it waits (keeping the old anchor, so the jump is seen again) while a seek is under way. Without a jump the
 * music's discipline holds: nudged with hysteresis for genuine drift, moved only when far off.
 */
export function videoCorrection(target: VideoTarget, video: VideoState, anchorMs: number | null = null, leadSec = 0): VideoAction {
  const anchored = (action: AudioAction): VideoAction => ({ ...action, anchorMs: target.offsetMs });
  if (target.play) {
    // A seek while playing lands where the clock will be once it is done (`leadSec`: how long the last one took), never past the file's end.
    const led = (action: AudioAction): AudioAction => {
      if (action.seekSec === null) return action;
      const ahead = action.seekSec + Math.min(Math.max(0, leadSec), MAX_SEEK_LEAD_SEC);
      return { ...action, seekSec: Number.isFinite(video.durationSec) ? Math.min(ahead, video.durationSec) : ahead };
    };
    const jumped = anchorMs !== null && anchorMs !== target.offsetMs && !video.paused;
    if (jumped && video.seeking) return { seekSec: null, rate: video.rate, play: null, anchorMs };
    if (jumped && Math.abs(video.currentTimeSec - target.atSec) > HALF_FRAME_SEC) return anchored(led({ seekSec: target.atSec, rate: 1, play: null }));
    return anchored(led(audioCorrection({ play: true, atSec: target.atSec }, video)));
  }
  const play = video.paused ? null : false;
  // Getting somewhere already, or not knowing the file yet: its `seeked` / `loadedmetadata` asks again.
  if (video.seeking || video.readyState < HAVE_METADATA) return anchored({ seekSec: null, rate: 1, play });
  if (videoFrameAt(video.currentTimeSec) === target.frame) return anchored({ seekSec: null, rate: 1, play });
  return anchored({ seekSec: target.atSec, rate: 1, play });
}
