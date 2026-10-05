import { describe, expect, test } from "bun:test";
import { MAX_SOURCE_OFFSET_MS, MontageDraft, type TrackSummary } from "../../../shared/engine";
import { trackIssues } from "../../../shared/montage";
import { highlightPicks, musicWindow, ownTrackTooShort, pickOwnTrack, pickStartMs, pickTrack, type TrackFacts, trackRows } from "./musicOps";
import { draftSpec, photoClip } from "./testkit";

// 3d.5: choosing a track in the «Музыка» tab and the start in the music card (EditorMusic.dc.html; U4–U10, R44–R48). Free: the list
// and the waveform are `music.list` / `music.peaks`, nothing here can spend a request. A picked track starts at its first highlight
// that leaves the whole montage inside the track (U9), else at 0, so a pick never makes the engine say `track-too-short`; a track
// shorter than the montage is not picked at all (U10). The highlights are offered ascending with the likely `1500` default last (K23).

/** Four 2.4 s clips: a 9.6 s montage. */
const NINE_SIX = draftSpec([0, 1, 2, 3].map((i) => photoClip(i, `photo-mia-000${i + 1}`, 2_400)));
const TOTAL = 9_600;

const hl = (ms: number, likelyDefault = false) => ({ ms, likelyDefault });

/** A 60 s track with highlights at 12 s and 30 s and the likely 1500 default. */
const TRACK: TrackFacts = { trackId: "track-espresso-01", durationMs: 60_000, highlights: [hl(12_000), hl(30_000), hl(1_500, true)] };

function summary(trackId: string, patch: Partial<TrackSummary> = {}): TrackSummary {
  return { trackId, title: trackId, artist: null, durationMs: 60_000, explicit: false, highlights: [], hasCover: false, ...patch };
}

/** What the engine's referential check says of the draft, with `track` stored at its proven length. */
const judged = (spec: MontageDraft, track: TrackFacts): string[] => trackIssues(spec, (id) => (id === track.trackId ? { decodedMs: track.durationMs } : null)).map((i) => i.code);

describe("where a picked track starts (U9: the first highlight that fits, else 0)", () => {
  test("the earliest highlight that leaves the whole montage inside the track", () => {
    expect(pickStartMs(TRACK, TOTAL)).toBe(12_000);
    expect(pickStartMs({ ...TRACK, highlights: [hl(52_000), hl(40_000)] }, TOTAL)).toBe(40_000);
  });

  test("a highlight at the very end that still holds the montage fits; one ms later it does not", () => {
    expect(pickStartMs({ ...TRACK, highlights: [hl(60_000 - TOTAL)] }, TOTAL)).toBe(50_400);
    expect(pickStartMs({ ...TRACK, highlights: [hl(60_000 - TOTAL + 1)] }, TOTAL)).toBe(0);
  });

  test("no highlight fits: from the start of the track", () => {
    expect(pickStartMs({ ...TRACK, highlights: [hl(55_000), hl(58_000)] }, TOTAL)).toBe(0);
    expect(pickStartMs({ ...TRACK, highlights: [] }, TOTAL)).toBe(0);
  });

  test("the likely 1500 default is a guess at the track's start, not a pick: it is never where a pick starts", () => {
    expect(pickStartMs({ ...TRACK, highlights: [hl(1_500, true)] }, TOTAL)).toBe(0);
  });

  test("never past the furthest a start may point into a track (10 min)", () => {
    expect(pickStartMs({ trackId: "track-long-0001", durationMs: 900_000, highlights: [hl(MAX_SOURCE_OFFSET_MS + 1_000)] }, TOTAL)).toBe(0);
    expect(pickStartMs({ trackId: "track-long-0001", durationMs: 900_000, highlights: [hl(MAX_SOURCE_OFFSET_MS)] }, TOTAL)).toBe(MAX_SOURCE_OFFSET_MS);
  });

  test("an empty montage takes the first highlight", () => {
    expect(pickStartMs(TRACK, 0)).toBe(12_000);
  });

  // Review round 1: a montage under 4 s cannot be rendered yet; it will be at least 4 s, so a start must leave room for that.
  test("a montage shorter than 4 s is judged as 4 s: a highlight no valid montage fits is not taken", () => {
    const late: TrackFacts = { trackId: "track-late-0002", durationMs: 20_000, highlights: [hl(16_000), hl(17_000)] };
    expect(pickStartMs(late, 2_000)).toBe(16_000);
    expect(pickStartMs({ ...late, highlights: [hl(17_000)] }, 2_000)).toBe(0);
    expect(pickStartMs({ ...late, highlights: [hl(16_001)] }, 0)).toBe(0);
  });
});

describe("picking a track (U9, U10)", () => {
  test("a draft with no music gets the trending track at its start", () => {
    const edit = pickTrack(NINE_SIX, TRACK);
    if (!edit.ok) throw new Error(edit.reason);
    expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
    expect(edit.spec.music).toEqual({ source: "trending", trackId: TRACK.trackId, startMs: 12_000 });
    expect(edit.spec.clips).toBe(NINE_SIX.clips);
  });

  test("another track replaces the one there, at its own start", () => {
    const other: TrackFacts = { trackId: "track-luther-0001", durationMs: 177_000, highlights: [hl(34_000)] };
    const edit = pickTrack({ ...NINE_SIX, music: { source: "trending", trackId: TRACK.trackId, startMs: 30_000 } }, other);
    expect(edit.ok && edit.spec.music).toEqual({ source: "trending", trackId: other.trackId, startMs: 34_000 });
  });

  test("the track already in the draft is the same draft: the start the owner chose stays", () => {
    const spec = { ...NINE_SIX, music: { source: "trending" as const, trackId: TRACK.trackId, startMs: 30_000 } };
    const edit = pickTrack(spec, TRACK);
    expect(edit.ok && edit.spec).toBe(spec);
  });

  test("a track shorter than the montage is refused; one exactly as long fits, from its start", () => {
    expect(pickTrack(NINE_SIX, { trackId: "track-short-0001", durationMs: TOTAL - 1, highlights: [] })).toEqual({ ok: false, reason: "too-short" });
    const edit = pickTrack(NINE_SIX, { trackId: "track-exact-0001", durationMs: TOTAL, highlights: [hl(0)] });
    expect(edit.ok && edit.spec.music).toEqual({ source: "trending", trackId: "track-exact-0001", startMs: 0 });
  });

  test("whatever is picked, the engine's own check finds the track long enough (never `track-too-short`)", () => {
    const tracks: TrackFacts[] = [
      TRACK,
      { trackId: "track-end-00001", durationMs: 60_000, highlights: [hl(50_400), hl(50_401)] },
      { trackId: "track-late-0001", durationMs: 20_000, highlights: [hl(15_000), hl(1_500, true)] },
      { trackId: "track-exact-0001", durationMs: TOTAL, highlights: [] },
    ];
    for (const track of tracks) {
      const edit = pickTrack(NINE_SIX, track);
      if (!edit.ok) throw new Error(`${track.trackId}: ${edit.reason}`);
      expect(judged(edit.spec, track)).toEqual([]);
    }
  });
});

describe("the highlight picks of the music card (R47, CF6: ascending, the likely default last)", () => {
  test("ascending with the likely default last, whatever order they come in; the one the music starts at is on", () => {
    const picks = highlightPicks([hl(30_000), hl(1_500, true), hl(12_000)], 30_000, TOTAL, 60_000);
    expect(picks.map((p) => [p.ms, p.likelyDefault, p.on])).toEqual([
      [12_000, false, false],
      [30_000, false, true],
      [1_500, true, false],
    ]);
  });

  test("a pick that would run the montage past the track's end does not fit; one that ends exactly on it does", () => {
    const picks = highlightPicks([hl(50_400), hl(50_401)], 0, TOTAL, 60_000);
    expect(picks.map((p) => [p.ms, p.fits])).toEqual([
      [50_400, true],
      [50_401, false],
    ]);
  });

  test("no highlights: no picks", () => {
    expect(highlightPicks([], 0, TOTAL, 60_000)).toEqual([]);
  });

  test("under 4 s the montage is judged as 4 s: a pick fits only if a valid montage would", () => {
    const picks = highlightPicks([hl(16_000), hl(16_001)], 0, 2_000, 20_000);
    expect(picks.map((p) => [p.ms, p.fits])).toEqual([
      [16_000, true],
      [16_001, false],
    ]);
  });
});

describe("the montage's window over the whole waveform (R46)", () => {
  test("where it starts and how wide it is, as parts of the track", () => {
    expect(musicWindow(12_000, TOTAL, 60_000)).toEqual({ from: 0.2, width: 0.16 });
  });

  test("held inside the waveform when the montage outgrew the track; nothing for a track of no length", () => {
    expect(musicWindow(55_000, TOTAL, 60_000)).toEqual({ from: 55_000 / 60_000, width: 5_000 / 60_000 });
    expect(musicWindow(0, 90_000, 60_000)).toEqual({ from: 0, width: 1 });
    expect(musicWindow(0, TOTAL, 0)).toEqual({ from: 0, width: 0 });
  });
});

describe("the «Музыка» tab's rows (U4–U10: the E badge, no trending-only filter)", () => {
  const tracks = [
    summary("track-a-000001", { highlights: [hl(42_000), hl(1_500, true)] }),
    summary("track-b-000001", { explicit: true, highlights: [hl(1_500, true)] }),
    summary("track-c-000001", { durationMs: TOTAL - 1 }),
    summary("track-d-000001", { durationMs: TOTAL }),
  ];

  test("in list order: the draft's track marked, a track shorter than the montage marked, the first real highlight as the star", () => {
    const rows = trackRows(tracks, { source: "trending", trackId: "track-a-000001", startMs: 42_000 }, TOTAL, { hideExplicit: false });
    expect(rows.map((r) => [r.track.trackId, r.inDraft, r.tooShort, r.star])).toEqual([
      ["track-a-000001", true, false, 42_000],
      ["track-b-000001", false, false, null],
      ["track-c-000001", false, true, null],
      ["track-d-000001", false, false, null],
    ]);
  });

  test("the star is where a pick would really start: a highlight the montage does not fit after is no star", () => {
    const rows = trackRows(
      [summary("track-e-000001", { durationMs: 20_000, highlights: [hl(15_000)] }), summary("track-f-000001", { durationMs: 20_000, highlights: [hl(9_000), hl(15_000)] })],
      null,
      TOTAL,
      { hideExplicit: false },
    );
    expect(rows.map((r) => r.star)).toEqual([null, 9_000]);
    // A montage under 4 s is judged as 4 s here too.
    expect(trackRows([summary("track-g-000001", { durationMs: 20_000, highlights: [hl(17_000)] })], null, 2_000, { hideExplicit: false })[0]?.star).toBe(null);
  });

  test("explicit tracks are listed and pickable by default; hiding them never hides the draft's own track", () => {
    expect(trackRows(tracks, null, TOTAL, { hideExplicit: false }).some((r) => r.track.explicit && !r.tooShort)).toBe(true);
    expect(trackRows(tracks, null, TOTAL, { hideExplicit: true }).map((r) => r.track.trackId)).toEqual(["track-a-000001", "track-c-000001", "track-d-000001"]);
    const own = trackRows(tracks, { source: "trending", trackId: "track-b-000001", startMs: 0 }, TOTAL, { hideExplicit: true });
    expect(own.map((r) => r.track.trackId)).toEqual(["track-a-000001", "track-b-000001", "track-c-000001", "track-d-000001"]);
  });
});

describe("an own track from «Мои» (3f.6, M10–M11): from its start, never one shorter than the montage", () => {
  const OWN = { mediaId: "media-track-0001", durationMs: 42_000 };

  test("the music becomes the own track from 0; it replaces a trending one", () => {
    const edit = pickOwnTrack(NINE_SIX, OWN);
    if (!edit.ok) throw new Error(edit.reason);
    expect(edit.spec.music).toEqual({ source: "own", mediaId: OWN.mediaId, startMs: 0 });
    const replaced = pickOwnTrack({ ...NINE_SIX, music: { source: "trending", trackId: TRACK.trackId, startMs: 12_000 } }, OWN);
    expect(replaced.ok && replaced.spec.music).toEqual({ source: "own", mediaId: OWN.mediaId, startMs: 0 });
    expect(MontageDraft.safeParse(replaced.ok ? replaced.spec : null).success).toBe(true);
  });

  test("the own track already in the montage is the same draft: the start the owner chose stays", () => {
    const chosen = { ...NINE_SIX, music: { source: "own" as const, mediaId: OWN.mediaId, startMs: 5_000 } };
    const edit = pickOwnTrack(chosen, OWN);
    expect(edit.ok && edit.spec).toBe(chosen);
  });

  test("a track under 4 s is too short for any montage (round 2: the engine now refuses one at import, but older libraries still hold some)", () => {
    const short = { ...OWN, durationMs: 3_900 };
    const twoSeconds = draftSpec([photoClip(0, "photo-mia-0001", 2_000)]);
    expect(ownTrackTooShort(short, 2_000)).toBe(true);
    expect(pickOwnTrack(twoSeconds, short)).toEqual({ ok: false, reason: "too-short" });
    expect(ownTrackTooShort({ durationMs: 4_000 }, 2_000)).toBe(false);
  });

  test("a track shorter than the montage is refused (U10's rule for own tracks); exactly as long fits", () => {
    expect(pickOwnTrack(NINE_SIX, { ...OWN, durationMs: TOTAL - 1 })).toEqual({ ok: false, reason: "too-short" });
    expect(pickOwnTrack(NINE_SIX, { ...OWN, durationMs: TOTAL }).ok).toBe(true);
    expect(ownTrackTooShort({ durationMs: TOTAL - 1 }, TOTAL)).toBe(true);
    expect(ownTrackTooShort({ durationMs: TOTAL }, TOTAL)).toBe(false);
  });
});
