// 3d.4: the montage's music in the preview. An `<audio>` element plays the stored track from `music.startMs` (3c.5: the render cuts
// the track there, for exactly the montage's length), kept in step with the playhead clock, which is the master: the picture is
// drawn from it. The element starts late (its `play()` resolves after the decoder is ready) and drifts against the clock, so on
// every frame the window compares where the element is with where the clock says it should be:
// - nudged by its playback rate (`NUDGE_RATE` faster or slower) once it is more than `NUDGE_ON_MS` off, and back to normal speed
//   once it is within `NUDGE_OFF_MS` (hysteresis: no flapping around one threshold), so it meets the clock without a jump;
// - moved to its place when more than `HARD_DRIFT_MS` off;
// - never corrected while a seek is under way, nor while it has too little data to play on (`readyState` below
//   HAVE_FUTURE_DATA): a cold file on a slow disk would otherwise be seeked again on every frame (review round 1).
// The render also attenuates a hot track's peaks (A5); the preview plays the file as stored.

/** A nudge goes on past this drift (about a 30 fps frame)... */
export const NUDGE_ON_MS = 40;
/** ...and off again within this one. */
export const NUDGE_OFF_MS = 10;
/** Past this, the element is moved to its place instead of nudged. */
export const HARD_DRIFT_MS = 250;
/** How much faster or slower a nudged element plays. */
export const NUDGE_RATE = 0.05;
/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough data to play on from where it is. */
export const HAVE_FUTURE_DATA = 3;

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
  /** A seek is under way. */
  readonly seeking: boolean;
  /** `HTMLMediaElement.readyState`, 0 to 4. */
  readonly readyState: number;
  /** The playback rate it plays at now: not 1 while a nudge is on. */
  readonly rate: number;
}

export interface AudioAction {
  /** Move the element here (seconds), or leave it. */
  readonly seekSec: number | null;
  readonly rate: number;
  /** `true` start it, `false` pause it, null leave it as it is. */
  readonly play: boolean | null;
}

/** Where the music should be for the playhead: the track's start plus the playhead, sounding while the montage plays (never past its end). */
export function audioTarget(playhead: { readonly ms: number; readonly playing: boolean }, music: { readonly startMs: number } | null, totalMs: number): AudioTarget {
  if (music === null) return { play: false, atSec: null };
  const ms = Math.min(Math.max(0, playhead.ms), Math.max(0, totalMs));
  return { play: playhead.playing && ms < totalMs, atSec: (music.startMs + ms) / 1000 };
}

/** What to do to the element so it plays `target`. */
export function audioCorrection(target: AudioTarget, audio: AudioState): AudioAction {
  const silent = !target.play || target.atSec === null || (Number.isFinite(audio.durationSec) && target.atSec >= audio.durationSec);
  if (silent) return { seekSec: null, rate: 1, play: audio.paused ? null : false };
  const at = target.atSec;
  // Start: moved to its place and played; one already seeking (it was just moved) is only played.
  if (audio.paused) return { seekSec: audio.seeking ? null : at, rate: 1, play: true };
  // Nothing is corrected while it is getting there or waiting for data: its time does not mean much yet.
  if (audio.seeking || audio.readyState < HAVE_FUTURE_DATA) return { seekSec: null, rate: audio.rate, play: null };
  const driftMs = (audio.currentTimeSec - at) * 1000;
  if (Math.abs(driftMs) > HARD_DRIFT_MS) return { seekSec: at, rate: 1, play: null };
  const nudging = audio.rate !== 1;
  const off = Math.abs(driftMs) > (nudging ? NUDGE_OFF_MS : NUDGE_ON_MS);
  return { seekSec: null, rate: off ? (driftMs > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE) : 1, play: null };
}
