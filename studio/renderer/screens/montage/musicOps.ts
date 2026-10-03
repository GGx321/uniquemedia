import { MAX_PEAK_BARS, MAX_SOURCE_OFFSET_MS, MIN_PEAK_BARS, type MontageDraft, type TrackSummary } from "../../../shared/engine";
import { STEP_MS } from "../../../shared/montage";
import { totalMs } from "./clipOps";
import type { Range } from "./layerOps";

// 3d.3b: the music track on the timeline, as pure functions. The block always spans the whole montage: the render cuts
// and pads the audio to its exact length (3c.5), so the montage's end IS the music's end and nothing here trims it. The
// one edit is where in the track the music starts (`startMs`, any whole ms, N16), moved by a drag in 100 ms steps (AM8)
// and never so late that the montage would run past the track's end (`track-too-short`). A start the montage outgrew
// (a clip was lengthened after the start was chosen) may only come back, like a layer past the montage's end.

/**
 * Why the start was not set:
 * - `no-music`: the draft has no track (it was removed meanwhile);
 * - `outside-track`: before 0, or so late that the montage would run past the track's end (or further past it).
 */
export type MusicRefusal = "no-music" | "outside-track";

export type MusicEdit = { readonly ok: true; readonly spec: MontageDraft } | { readonly ok: false; readonly reason: MusicRefusal };

export type Highlight = TrackSummary["highlights"][number];

/** About one waveform bar per this many pixels of the block: 72 bars on the mockup's 9.6 s block (K26). */
export const WAVE_PITCH_PX = 9;

function assertTime(ms: number, what: string): void {
  if (!Number.isFinite(ms)) throw new RangeError(`${what} must be a finite number, got ${ms}`);
}

/**
 * Where the music may start, `currentMs` being where it starts now: from 0 to the last start that keeps the whole
 * montage (`totalMs`) inside the track (`trackMs`), or to the current start when the montage already runs past the
 * track's end; never past `MAX_SOURCE_OFFSET_MS`.
 */
export function musicStartRange(currentMs: number, totalMs: number, trackMs: number): Range {
  return { min: 0, max: Math.min(MAX_SOURCE_OFFSET_MS, Math.max(0, trackMs - totalMs, currentMs)) };
}

/** A drag's start: a whole ms inside `musicStartRange`. */
export function clampMusicStart(currentMs: number, wantedMs: number, totalMs: number, trackMs: number): number {
  assertTime(wantedMs, "a start");
  const range = musicStartRange(currentMs, totalMs, trackMs);
  return Math.min(range.max, Math.max(range.min, Math.round(wantedMs)));
}

/**
 * The start after a drag of `deltaMs` along the timeline, in whole 100 ms steps. The waveform follows the pointer: dragged
 * to the right, the music from EARLIER in the track comes under the playhead, so the start goes back.
 */
export function slipStart(fromMs: number, deltaMs: number): number {
  assertTime(deltaMs, "a drag");
  const steps = Math.round(deltaMs / STEP_MS);
  return steps === 0 ? fromMs : fromMs - steps * STEP_MS;
}

/** The music starting at `startMs` of a track `trackMs` long; the same draft when the start stays. */
export function setMusicStart(spec: MontageDraft, startMs: number, trackMs: number): MusicEdit {
  const music = spec.music;
  if (music === null) return { ok: false, reason: "no-music" };
  assertTime(startMs, "a start");
  if (startMs === music.startMs) return { ok: true, spec };
  const range = musicStartRange(music.startMs, totalMs(spec), trackMs);
  if (!Number.isSafeInteger(startMs) || startMs < range.min || startMs > range.max) return { ok: false, reason: "outside-track" };
  return { ok: true, spec: { ...spec, music: { ...music, startMs } } };
}

/** How many bars the waveform of a block `widthPx` wide asks `music.peaks` for: one about every 9 px, in fours, 16..256. */
export function waveBars(widthPx: number): number {
  const fours = Math.round(Math.max(0, widthPx) / WAVE_PITCH_PX / 4) * 4;
  return Math.min(MAX_PEAK_BARS, Math.max(MIN_PEAK_BARS, fours));
}

/**
 * The track's highlights that fall inside the montage's part of it, after its start (`(startMs, startMs + totalMs)`), each
 * with its place along the block (0 = the block's start). A start on a highlight is the tag's ★, not a mark under the
 * tag. The likely `1500` default is a guess at "the start of the track", not a highlight anyone chose, so it is not marked.
 */
export function highlightMarks(highlights: readonly Highlight[], startMs: number, totalMs: number): { ms: number; at: number }[] {
  if (totalMs <= 0) return [];
  return highlights.filter((h) => !h.likelyDefault && h.ms > startMs && h.ms < startMs + totalMs).map((h) => ({ ms: h.ms, at: (h.ms - startMs) / totalMs }));
}

/** Whether the music starts exactly on one of the track's quick picks (the ★ on the block's tag). */
export function atHighlight(highlights: readonly Highlight[], startMs: number): boolean {
  return highlights.some((h) => h.ms === startMs);
}
