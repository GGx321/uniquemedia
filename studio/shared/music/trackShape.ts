import { MAX_TRACK_HIGHLIGHTS } from "../engine";

// The pure rules of a stored track's shape (3c.4, K23, K26), shared so the engine's track store and the dev mock answer
// `music.list` and `music.peaks` from ONE implementation: how highlights are offered, and how a window of the waveform is read.

/** A likely "start of the track" default seen in 20 of 60 cached items (SP5): flagged, and shown last. */
export const LIKELY_DEFAULT_MS = 1500;

/**
 * The highlights of a track as the editor offers them (K23): unique, ascending, a start past the end of the track
 * dropped (nothing can be played from it), at most eight, and a `1500` flagged as the likely default and put last. The
 * API sends them unsorted (36 of 60 cached items), so "first" never means "earliest".
 */
export function normaliseHighlights(raw: readonly number[], durationMs: number): { ms: number; likelyDefault: boolean }[] {
  const valid = [...new Set(raw)].filter((ms) => Number.isSafeInteger(ms) && ms >= 0 && ms < durationMs);
  const hasDefault = valid.includes(LIKELY_DEFAULT_MS);
  const others = valid.filter((ms) => ms !== LIKELY_DEFAULT_MS).sort((a, b) => a - b);
  const kept = others.slice(0, hasDefault ? MAX_TRACK_HIGHLIGHTS - 1 : MAX_TRACK_HIGHLIGHTS).map((ms) => ({ ms, likelyDefault: false }));
  return hasDefault ? [...kept, { ms: LIKELY_DEFAULT_MS, likelyDefault: true }] : kept;
}

/**
 * The waveform of a window of a track (K26): `bars` integers from 0 to 1000, each the largest envelope value among the
 * steps its slice of the window covers (a slice narrower than a step reads that one step). Time past the end of the
 * track is silence. Pure arithmetic on the envelope kept at download time: no decode and no file.
 */
export function windowPeaks(envelope: { stepMs: number; peaks: readonly number[] }, startMs: number, durationMs: number, bars: number): number[] {
  const { stepMs, peaks } = envelope;
  const out: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = startMs + (bar * durationMs) / bars;
    const to = startMs + ((bar + 1) * durationMs) / bars;
    const first = Math.floor(from / stepMs);
    const last = Math.max(first, Math.ceil(to / stepMs) - 1);
    let max = 0;
    for (let step = first; step <= last && step < peaks.length; step++) {
      const value = peaks[step] ?? 0;
      if (value > max) max = value;
    }
    out.push(Math.min(1000, Math.max(0, Math.round(max))));
  }
  return out;
}

/**
 * A stored track as `music.list` describes it (K23, 3d.3b verify): its length is the one its decode PROVED (`decodedMs`),
 * the length every render and `montages.get` judge a start by, never the list's claim (the decode lets the two differ by
 * up to max(2 s, 5 %)); and a highlight at or past that end is dropped, as `normaliseHighlights` drops one past the claim.
 */
export function provenShape(highlights: readonly { ms: number; likelyDefault: boolean }[], decodedMs: number): { durationMs: number; highlights: { ms: number; likelyDefault: boolean }[] } {
  return { durationMs: decodedMs, highlights: highlights.filter((highlight) => highlight.ms < decodedMs).map((highlight) => ({ ms: highlight.ms, likelyDefault: highlight.likelyDefault })) };
}
