// 3d.4: the montage's music in the preview. An `<audio>` element plays the stored track from `music.startMs` (3c.5: the render cuts
// the track there, for exactly the montage's length), kept in step with the playhead clock, which is the master: the picture is
// drawn from it. The element starts late (its `play()` resolves after the decoder is ready) and drifts against the clock, so on
// every frame the window compares where the element is with where the clock says it should be:
// - within `SOFT_DRIFT_MS` (about a frame): left alone, at normal speed;
// - within `HARD_DRIFT_MS`: nudged by its playback rate (`NUDGE_RATE` faster or slower), so it meets the clock without a jump;
// - further off: moved to its place.
// The render also attenuates a hot track's peaks (A5); the preview plays the file as stored.

/** Drift a listener cannot tell from none: about one 30 fps frame. */
export const SOFT_DRIFT_MS = 40;
/** Past this, the element is moved to its place instead of nudged. */
export const HARD_DRIFT_MS = 250;
/** How much faster or slower a nudged element plays. */
export const NUDGE_RATE = 0.05;

export interface AudioTarget {
  /** Whether the music should be sounding now. */
  readonly play: boolean;
  /** Where in the track it should be, in seconds; null without music. */
  readonly atSec: number | null;
}

/** What the window can read off the element. */
export interface AudioState {
  readonly currentTimeSec: number;
  readonly paused: boolean;
  /** The file's length; NaN while the element does not know it. */
  readonly durationSec: number;
}

export interface AudioAction {
  /** Move the element here (seconds), or leave it. */
  readonly seekSec: number | null;
  readonly rate: number;
  /** `true` start it, `false` pause it, null leave it as it is. */
  readonly play: boolean | null;
}

const LEAVE: AudioAction = { seekSec: null, rate: 1, play: null };
const PAUSE: AudioAction = { seekSec: null, rate: 1, play: false };

/** Where the music should be for the playhead: the track's start plus the playhead, sounding while the montage plays (never past its end). */
export function audioTarget(playhead: { readonly ms: number; readonly playing: boolean }, music: { readonly startMs: number } | null, totalMs: number): AudioTarget {
  if (music === null) return { play: false, atSec: null };
  const ms = Math.min(Math.max(0, playhead.ms), Math.max(0, totalMs));
  return { play: playhead.playing && ms < totalMs, atSec: (music.startMs + ms) / 1000 };
}

/** What to do to the element so it plays `target`. */
export function audioCorrection(target: AudioTarget, audio: AudioState): AudioAction {
  const silent = !target.play || target.atSec === null || (Number.isFinite(audio.durationSec) && target.atSec >= audio.durationSec);
  if (silent) return audio.paused ? LEAVE : PAUSE;
  const at = target.atSec;
  if (audio.paused) return { seekSec: at, rate: 1, play: true };
  const driftMs = (audio.currentTimeSec - at) * 1000;
  if (Math.abs(driftMs) > HARD_DRIFT_MS) return { seekSec: at, rate: 1, play: null };
  if (Math.abs(driftMs) > SOFT_DRIFT_MS) return { seekSec: null, rate: driftMs > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE, play: null };
  return LEAVE;
}
