import { MAX_PEAK_BARS, MAX_SOURCE_OFFSET_MS, MIN_PEAK_BARS, type MontageDraft, type MontageIssue, type TrackSummary } from "../../../shared/engine";
import { MIN_TOTAL_MS, STEP_MS } from "../../../shared/montage";
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

/** What is wrong with the draft's track (`track-unavailable`, `track-too-short`). */
export type MusicProblem = "unavailable" | "too-short";

/** The engine's verdict on the track for the spec on screen, or `judged: false` while it has not judged that spec. */
export type TrackVerdict = { readonly judged: false } | { readonly judged: true; readonly problem: MusicProblem | null };

/**
 * What the music block says is wrong with the track (3d.3b verify). A track the store does not hold (`music.peaks` answered
 * NOT_FOUND) is unavailable. Otherwise the engine's verdict on the spec on screen wins, both ways: it judges by the length the
 * decode proved, which the window may not know. Only while the engine has not judged that spec (an edit it has not seen yet)
 * does the window's own guess from the listed length stand, so an edit that outgrows the track says so at once.
 */
export function trackProblem(facts: { readonly missing: boolean; readonly verdict: TrackVerdict; readonly guessTooShort: boolean }): MusicProblem | null {
  if (facts.missing) return "unavailable";
  if (facts.verdict.judged) return facts.verdict.problem;
  return facts.guessTooShort ? "too-short" : null;
}

/**
 * The engine's verdict on the music, from the issues of the spec it judged (3f.4). A trending track the store lacks is `track-unavailable`; an own track
 * the library lacks is `media-unavailable` AT THE MUSIC (an own media gone from a clip or a layer is not the music's problem); a track too short for its
 * start is `track-too-short` for both. Unavailable is told before too-short. `judgedNow` is whether the engine judged THE SPEC ON SCREEN: otherwise the
 * block has no verdict and trusts none.
 */
export function musicVerdictOf(judgedNow: boolean, issues: readonly MontageIssue[]): TrackVerdict {
  if (!judgedNow) return { judged: false };
  const unavailable = issues.some((issue) => issue.code === "track-unavailable" || (issue.code === "media-unavailable" && issue.path[0] === "music" && issue.path.length === 1));
  if (unavailable) return { judged: true, problem: "unavailable" };
  return { judged: true, problem: issues.some((issue) => issue.code === "track-too-short") ? "too-short" : null };
}

/** Whether the music starts exactly on one of the track's quick picks (the ★ on the block's tag). */
export function atHighlight(highlights: readonly Highlight[], startMs: number): boolean {
  return highlights.some((h) => h.ms === startMs);
}

// ---------- choosing a track and its start (3d.5: the «Музыка» tab and the music card) ----------
//
// All free: the tab reads `music.list` and the card `music.peaks`; nothing here can lead to `music.refresh`, which spends one of
// the 30 flashapi requests and lives in Settings only, behind its confirmation (3c.6). Every length is the one the store's decode
// PROVED (`TrackSummary.durationMs`), the one the engine judges `track-too-short` by.

/** What a pick needs of a listed track. */
export type TrackFacts = Pick<TrackSummary, "trackId" | "durationMs" | "highlights">;

/**
 * A start that keeps the whole montage inside the track and that a draft may hold (≤ 10 min into the track). A montage under 4 s
 * is judged as 4 s (review round 1): it cannot be rendered shorter, so a start that only fits the montage as it is now would turn
 * into `track-too-short` once it is long enough to render.
 */
const startFits = (ms: number, totalMs: number, trackMs: number): boolean => ms + Math.max(totalMs, MIN_TOTAL_MS) <= trackMs && ms <= MAX_SOURCE_OFFSET_MS;

/** The track's earliest REAL highlight a pick can start at (`startFits`), or null; never the likely `1500` default. */
function pickHighlight(track: TrackFacts, totalMs: number): number | null {
  const fitting = track.highlights.filter((h) => !h.likelyDefault && startFits(h.ms, totalMs, track.durationMs)).map((h) => h.ms);
  return fitting.length === 0 ? null : Math.min(...fitting);
}

/**
 * Where a picked track starts (U9): its earliest highlight that leaves the whole montage inside the track, else 0. The likely
 * `1500` default is a guess at "the start of the track", not a part anyone chose (the timeline does not mark it either): never.
 */
export function pickStartMs(track: TrackFacts, totalMs: number): number {
  return pickHighlight(track, totalMs) ?? 0;
}

/**
 * The draft's music as the trending `track`, at `pickStartMs` (one undo step: it replaces the track there). The track already in
 * the draft is the same draft, so the start the owner chose stays. Refused when the track is shorter than the montage (U10).
 */
export function pickTrack(spec: MontageDraft, track: TrackFacts): MusicEdit | { readonly ok: false; readonly reason: "too-short" } {
  if (spec.music?.source === "trending" && spec.music.trackId === track.trackId) return { ok: true, spec };
  const total = totalMs(spec);
  if (track.durationMs < total) return { ok: false, reason: "too-short" };
  return { ok: true, spec: { ...spec, music: { source: "trending", trackId: track.trackId, startMs: pickStartMs(track, total) } } };
}

/**
 * An own track is too short for the montage when it is shorter than the montage (U10's rule, the «Музыка» tab's own), and always when it is
 * shorter than the shortest montage that renders (4 s): the engine refuses such a track at import now, but an older library may still hold one.
 */
export function ownTrackTooShort(track: { readonly durationMs: number }, totalMs: number): boolean {
  return track.durationMs < Math.max(totalMs, MIN_TOTAL_MS);
}

/**
 * The draft's music as the own track `track` from «Мои» (3f.6, M11): from its start, `{source: "own", mediaId, startMs: 0}` (one undo step:
 * it replaces the track there). The own track already in the draft is the same draft, so the start the owner chose stays. Refused when the
 * track is shorter than the montage (M10).
 */
export function pickOwnTrack(spec: MontageDraft, track: { readonly mediaId: string; readonly durationMs: number }): MusicEdit | { readonly ok: false; readonly reason: "too-short" } {
  if (spec.music?.source === "own" && spec.music.mediaId === track.mediaId) return { ok: true, spec };
  if (ownTrackTooShort(track, totalMs(spec))) return { ok: false, reason: "too-short" };
  return { ok: true, spec: { ...spec, music: { source: "own", mediaId: track.mediaId, startMs: 0 } } };
}

/** A quick pick of the music card (R47): where it would start the music, whether the montage then fits, and whether it starts there now. */
export interface HighlightPick {
  readonly ms: number;
  readonly likelyDefault: boolean;
  readonly fits: boolean;
  readonly on: boolean;
}

/** The card's picks: ascending, with the likely `1500` default last (CF6, K23), whatever order they come in. */
export function highlightPicks(highlights: readonly Highlight[], startMs: number, totalMs: number, trackMs: number): HighlightPick[] {
  const ordered = [...highlights].sort((a, b) => Number(a.likelyDefault) - Number(b.likelyDefault) || a.ms - b.ms);
  return ordered.map((h) => ({ ms: h.ms, likelyDefault: h.likelyDefault, fits: startFits(h.ms, totalMs, trackMs), on: h.ms === startMs }));
}

/**
 * The montage's window over the whole track's waveform (R46), as parts of the track. It always starts where the music does; a
 * montage that outgrew the track runs off its end, so the window is cut there (never slid back to look as if it fit).
 */
export function musicWindow(startMs: number, totalMs: number, trackMs: number): { from: number; width: number } {
  if (!(trackMs > 0)) return { from: 0, width: 0 };
  const start = Math.min(trackMs, Math.max(0, startMs));
  // In ms first, then one division each: the window's end lands exactly on the track's.
  return { from: start / trackMs, width: Math.max(0, Math.min(totalMs, trackMs - start)) / trackMs };
}

/** A row of the «Музыка» tab (U4–U10). */
export interface TrackRow {
  readonly track: TrackSummary;
  /** «✓ в ролике». */
  readonly inDraft: boolean;
  /** «короче ролика»: shorter than the montage, so it cannot be picked (U10). */
  readonly tooShort: boolean;
  /** «★ 1:02»: the highlight a pick would start at (`pickStartMs`'s), or null when it would start at 0 for want of one. */
  readonly star: number | null;
}

/**
 * The tab's rows in the list's own order. There is no "trending only" filter (`is_trending_in_clips` is always false): every
 * stored track is listed. Explicit tracks carry «E» and stay pickable; «Скрыть E» (the artboard's chip, off by default) hides them,
 * except the draft's own track, which is always shown.
 */
export function trackRows(tracks: readonly TrackSummary[], music: MontageDraft["music"], totalMs: number, options: { readonly hideExplicit: boolean }): TrackRow[] {
  const current = music?.source === "trending" ? music.trackId : null;
  return tracks
    .filter((track) => !options.hideExplicit || !track.explicit || track.trackId === current)
    .map((track) => {
      return { track, inDraft: track.trackId === current, tooShort: track.durationMs < totalMs, star: pickHighlight(track, totalMs) };
    });
}
