import { describe, expect, test } from "bun:test";
import { MAX_PEAK_BARS, MAX_SOURCE_OFFSET_MS, MIN_PEAK_BARS, MontageDraft } from "../../../shared/engine";
import { atHighlight, clampMusicStart, highlightMarks, type MusicEdit, musicStartRange, setMusicStart, slipStart, trackProblem, waveBars } from "./musicOps";
import { draftSpec } from "./testkit";

// 3d.3b: the music track on the timeline. The block always spans the whole montage (the render cuts and pads the audio to
// its exact length, 3c.5), so the only edit here is WHERE in the track it starts: `startMs`, any whole ms (N16), moved in
// 100 ms steps by a drag (AM8), never so late that the montage would run past the track's end.

const TRENDING = { source: "trending", trackId: "track-espresso-01", startMs: 42_000 } as const;
/** Four 2.4 s clips: a 9.6 s montage. */
const spec = draftSpec(
  [0, 1, 2, 3].map((i) => ({ clipId: `clip-00${i + 1}`, durationMs: 2_400, transitionIn: "cut" as const, kind: "photo" as const, cell: { photo: { source: "scene" as const, photoId: `photo-mia-000${i + 1}` }, focus: null }, motion: "kenburns" as const })),
  { music: TRENDING },
);
const TRACK_MS = 175_000;

function ok(edit: MusicEdit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

describe("where the music may start", () => {
  test("from 0 to the last start that keeps the whole montage inside the track", () => {
    expect(musicStartRange(42_000, 9_600, TRACK_MS)).toEqual({ min: 0, max: 165_400 });
    expect(musicStartRange(0, 9_600, 9_600)).toEqual({ min: 0, max: 0 });
  });

  test("a start the montage outgrew (a clip was lengthened) may only come back", () => {
    expect(musicStartRange(170_000, 9_600, TRACK_MS)).toEqual({ min: 0, max: 170_000 });
    // A track shorter than the montage has no good start at all: it may only move towards 0.
    expect(musicStartRange(500, 9_600, 9_000)).toEqual({ min: 0, max: 500 });
  });

  test("never further into a track than the contract lets a start point (10 minutes)", () => {
    expect(musicStartRange(0, 9_600, 1_200_000)).toEqual({ min: 0, max: MAX_SOURCE_OFFSET_MS });
  });

  test("a drag's start is a whole ms inside that range", () => {
    expect(clampMusicStart(42_000, 50_000.4, 9_600, TRACK_MS)).toBe(50_000);
    expect(clampMusicStart(42_000, 999_999, 9_600, TRACK_MS)).toBe(165_400);
    expect(clampMusicStart(42_000, -10, 9_600, TRACK_MS)).toBe(0);
    expect(() => clampMusicStart(42_000, Number.NaN, 9_600, TRACK_MS)).toThrow(RangeError);
  });
});

describe("a drag moves the start in 100 ms steps (AM8), the waveform following the pointer", () => {
  test("dragged right, earlier music comes under the playhead: the start goes back by whole steps", () => {
    expect(slipStart(42_137, 250)).toBe(41_837);
    expect(slipStart(42_137, -51)).toBe(42_237);
    expect(slipStart(42_137, -49)).toBe(42_137);
    expect(slipStart(42_137, 0)).toBe(42_137);
  });
});

describe("setting the start", () => {
  test("only the start changes", () => {
    const next = ok(setMusicStart(spec, 41_000, TRACK_MS));
    expect(next).toEqual({ ...spec, music: { ...TRENDING, startMs: 41_000 } });
  });

  test("the same start is the same draft", () => {
    const same = setMusicStart(spec, 42_000, TRACK_MS);
    expect(same.ok && same.spec === spec).toBe(true);
  });

  test("past the last good start, or before 0, is outside the track", () => {
    ok(setMusicStart(spec, 165_400, TRACK_MS));
    expect(setMusicStart(spec, 165_401, TRACK_MS)).toEqual({ ok: false, reason: "outside-track" });
    expect(setMusicStart(spec, -1, TRACK_MS)).toEqual({ ok: false, reason: "outside-track" });
  });

  test("a draft with no music has no start to set; an own track (3f) moves the same way", () => {
    expect(setMusicStart(draftSpec(4), 0, TRACK_MS)).toEqual({ ok: false, reason: "no-music" });
    const own = draftSpec(4, { music: { source: "own", mediaId: "media-own-0002", startMs: 0 } });
    expect(ok(setMusicStart(own, 1_234, TRACK_MS)).music).toEqual({ source: "own", mediaId: "media-own-0002", startMs: 1_234 });
  });
});

// 3d.3b verify: the engine judges a track by the length its decode PROVED; the window's own guess (from the listed length)
// stands only until the engine has judged the spec on screen, then its verdict wins both ways.
describe("what the block says is wrong with the track", () => {
  const judged = (problem: "unavailable" | "too-short" | null) => ({ judged: true, problem }) as const;
  const unjudged = { judged: false } as const;

  test("the engine's verdict on the spec on screen wins over the window's guess, both ways", () => {
    expect(trackProblem({ missing: false, verdict: judged(null), guessTooShort: true })).toBe(null);
    expect(trackProblem({ missing: false, verdict: judged("too-short"), guessTooShort: false })).toBe("too-short");
    expect(trackProblem({ missing: false, verdict: judged("unavailable"), guessTooShort: false })).toBe("unavailable");
  });

  test("not judged yet (an edit the engine has not seen): the window's guess, at once", () => {
    expect(trackProblem({ missing: false, verdict: unjudged, guessTooShort: true })).toBe("too-short");
    expect(trackProblem({ missing: false, verdict: unjudged, guessTooShort: false })).toBe(null);
  });

  test("a track the store does not hold (music.peaks NOT_FOUND) is unavailable, whatever else is known", () => {
    expect(trackProblem({ missing: true, verdict: judged(null), guessTooShort: false })).toBe("unavailable");
    expect(trackProblem({ missing: true, verdict: unjudged, guessTooShort: true })).toBe("unavailable");
  });
});

describe("the waveform and the highlights on the block", () => {
  test("a bar about every 9 px of the block (72 at the mockup's 9.6 s), within the contract's 16..256", () => {
    expect(waveBars(655)).toBe(72);
    expect(waveBars(0)).toBe(MIN_PEAK_BARS);
    expect(waveBars(100_000)).toBe(MAX_PEAK_BARS);
    // Quantised to fours, so a resize by a few pixels asks for no new waveform.
    expect(waveBars(652)).toBe(waveBars(660));
  });

  const highlights = [
    { ms: 18_000, likelyDefault: false },
    { ms: 42_000, likelyDefault: false },
    { ms: 75_000, likelyDefault: false },
    { ms: 1_500, likelyDefault: true },
  ];

  test("the highlights inside the montage's part of the track, placed along the block; the likely default is no highlight", () => {
    expect(highlightMarks(highlights, 40_000, 9_600)).toEqual([{ ms: 42_000, at: 2_000 / 9_600 }]);
    // A start on a highlight is the tag's ★, not a mark under the tag.
    expect(highlightMarks(highlights, 18_000, 9_600)).toEqual([]);
    expect(highlightMarks(highlights, 17_999, 9_600)).toEqual([{ ms: 18_000, at: 1 / 9_600 }]);
    expect(highlightMarks(highlights, 0, 9_600)).toEqual([]);
    // The block's end belongs to what follows it.
    expect(highlightMarks(highlights, 32_400, 9_600)).toEqual([]);
  });

  test("a start on a highlight (the likely default included: it is still a quick pick) earns the ★", () => {
    expect(atHighlight(highlights, 42_000)).toBe(true);
    expect(atHighlight(highlights, 1_500)).toBe(true);
    expect(atHighlight(highlights, 42_001)).toBe(false);
    expect(atHighlight([], 0)).toBe(false);
  });
});
