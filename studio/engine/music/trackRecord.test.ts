import { describe, expect, test } from "bun:test";
import { TrackSummary } from "../../shared/engine";
import { expiresAtFor, EXPIRY_CEILING_MS, EXPIRY_FALLBACK_MS, normaliseHighlights, toSummary, windowPeaks, type TrackEntry } from "./trackRecord";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const FETCHED = Date.UTC(2026, 8, 27, 20, 42, 44);
const HOUR = 3600 * 1000;
const url = (query: string): string => `https://scontent-fra3-1.cdninstagram.com/v/t/track.m4a?${query}`;
const oe = (at: number): string => `oh=00_x&oe=${Math.floor(at / 1000).toString(16).toUpperCase()}`;

describe("highlights", () => {
  test("are sorted ascending: they arrive unsorted, so `first` must never mean `earliest`", () => {
    expect(normaliseHighlights([90_000, 30_000, 60_000], 200_000)).toEqual([
      { ms: 30_000, likelyDefault: false },
      { ms: 60_000, likelyDefault: false },
      { ms: 90_000, likelyDefault: false },
    ]);
  });

  test("a 1500 is flagged as a likely default and shown last, whatever its place in the input", () => {
    expect(normaliseHighlights([1_500, 90_000, 30_000], 200_000)).toEqual([
      { ms: 30_000, likelyDefault: false },
      { ms: 90_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ]);
  });

  test("a 1500 that is the only highlight is still flagged", () => {
    expect(normaliseHighlights([1_500], 200_000)).toEqual([{ ms: 1_500, likelyDefault: true }]);
  });

  test("values near 1500 are not the default: only exactly 1500 is", () => {
    expect(normaliseHighlights([1_499, 1_501], 200_000).every((h) => !h.likelyDefault)).toBe(true);
  });

  test("a repeated value appears once, and a repeated 1500 too", () => {
    expect(normaliseHighlights([30_000, 30_000, 1_500, 1_500], 200_000)).toEqual([
      { ms: 30_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ]);
  });

  test("a highlight at or past the end of the track is dropped: it cannot be played from", () => {
    expect(normaliseHighlights([30_000, 199_999, 200_000, 500_000], 200_000)).toEqual([
      { ms: 30_000, likelyDefault: false },
      { ms: 199_999, likelyDefault: false },
    ]);
  });

  test("at most eight are kept, and a kept default takes one of the eight", () => {
    const many = Array.from({ length: 20 }, (_, i) => (i + 2) * 1000);
    const kept = normaliseHighlights(many, 100_000);
    expect(kept).toHaveLength(8);
    expect(kept.map((h) => h.ms)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
    const withDefault = normaliseHighlights([...many, 1_500], 100_000);
    expect(withDefault).toHaveLength(8);
    expect(withDefault.at(-1)).toEqual({ ms: 1_500, likelyDefault: true });
    expect(withDefault.slice(0, 7).map((h) => h.ms)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000]);
  });

  test("none is none", () => {
    expect(normaliseHighlights([], 100_000)).toEqual([]);
  });

  test("a zero is a start of the track and is kept ascending like any other", () => {
    expect(normaliseHighlights([30_000, 0], 100_000)).toEqual([
      { ms: 0, likelyDefault: false },
      { ms: 30_000, likelyDefault: false },
    ]);
  });
});

describe("when a signed URL expires", () => {
  test("is the URL's own `oe`, when it is inside the 104 hour ceiling", () => {
    const at = FETCHED + 100 * HOUR;
    expect(expiresAtFor(url(oe(at)), FETCHED)).toBe(Math.floor(at / 1000) * 1000);
  });

  test("is capped at 104 hours after the response, whatever a longer `oe` says", () => {
    expect(EXPIRY_CEILING_MS).toBe(104 * HOUR);
    expect(expiresAtFor(url(oe(FETCHED + 200 * HOUR)), FETCHED)).toBe(FETCHED + 104 * HOUR);
  });

  test("an `oe` exactly at the ceiling is the ceiling", () => {
    const at = Math.floor((FETCHED + 104 * HOUR) / 1000) * 1000;
    expect(expiresAtFor(url(oe(at)), FETCHED)).toBe(Math.min(at, FETCHED + 104 * HOUR));
  });

  test("a missing `oe` counts as 24 hours", () => {
    expect(EXPIRY_FALLBACK_MS).toBe(24 * HOUR);
    expect(expiresAtFor(url("oh=00_x"), FETCHED)).toBe(FETCHED + 24 * HOUR);
  });

  test.each(["oe=", "oe=zz", "oe=0", "oe=FFFFFFFFFFFFF", "oe=-5", "oe=12 34"])("an unparseable `oe` (%j) counts as 24 hours", (query) => {
    expect(expiresAtFor(url(query), FETCHED)).toBe(FETCHED + 24 * HOUR);
  });

  test("an `oe` already in the past is a time in the past: the download will not be attempted", () => {
    expect(expiresAtFor(url(oe(FETCHED - HOUR)), FETCHED)).toBeLessThan(FETCHED);
  });

  test("a URL that is not a URL counts as 24 hours", () => {
    expect(expiresAtFor("not a url", FETCHED)).toBe(FETCHED + 24 * HOUR);
  });
});

describe("the waveform of a window", () => {
  /** An envelope of one value per 50 ms. */
  const envelope = (values: number[]) => ({ stepMs: 50, peaks: values });

  test("has exactly `bars` values", () => {
    expect(windowPeaks(envelope(Array(200).fill(100)), 0, 10_000, 72)).toHaveLength(72);
    expect(windowPeaks(envelope(Array(200).fill(100)), 0, 10_000, 16)).toHaveLength(16);
    expect(windowPeaks(envelope(Array(200).fill(100)), 0, 10_000, 256)).toHaveLength(256);
  });

  test("each bar is the largest value of the steps it covers", () => {
    // 16 bars over 800 ms is 50 ms a bar: one step each.
    const values = Array.from({ length: 16 }, (_, i) => i * 10);
    expect(windowPeaks(envelope(values), 0, 800, 16)).toEqual(values);
    // 16 bars over 1600 ms is two steps a bar: the max of each pair.
    const ascending = Array.from({ length: 32 }, (_, i) => i);
    expect(windowPeaks(envelope(ascending), 0, 1600, 16)).toEqual(Array.from({ length: 16 }, (_, bar) => bar * 2 + 1));
  });

  test("starts where the window starts", () => {
    const values = Array.from({ length: 100 }, (_, i) => i * 10);
    const got = windowPeaks(envelope(values), 1000, 800, 16);
    expect(got[0]).toBe(200);
    expect(got[15]).toBe(350);
  });

  test("a part of the window past the end of the track is silent, not an error", () => {
    const got = windowPeaks(envelope(Array(20).fill(500)), 0, 2000, 16);
    expect(got.slice(0, 8).every((v) => v === 500)).toBe(true);
    expect(got.slice(8).every((v) => v === 0)).toBe(true);
  });

  test("a window that starts past the end is all silence", () => {
    expect(windowPeaks(envelope(Array(20).fill(500)), 5000, 1000, 16)).toEqual(Array(16).fill(0));
  });

  test("bars narrower than a step still read a step: a short window over a long one's resolution", () => {
    const got = windowPeaks(envelope([100, 900, 100, 100]), 0, 100, 16);
    expect(got).toHaveLength(16);
    expect(got.every((v) => v === 100 || v === 900)).toBe(true);
  });

  test("an empty envelope is silence", () => {
    expect(windowPeaks(envelope([]), 0, 1000, 16)).toEqual(Array(16).fill(0));
  });

  test("never returns a value outside 0..1000, whatever the envelope holds", () => {
    const got = windowPeaks(envelope([5000, -30, 1000.7]), 0, 150, 16);
    expect(got.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000)).toBe(true);
  });
});

describe("a track as the editor lists it", () => {
  const entry: TrackEntry = {
    trackId: "4199287736976977",
    title: "Espresso",
    artist: "Sabrina Carpenter",
    durationMs: 175_000,
    explicit: true,
    highlights: [
      { ms: 42_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ],
    monetization: "REVSHARE",
    licensedSubtype: null,
    inList: true,
    audio: { state: "stored", bytes: 1_000, sha256: "a".repeat(64), audioObjectType: 5, sampleRate: 44100, channels: 2, decodedMs: 175_000 },
    cover: { state: "stored", ext: "jpg", bytes: 500, sha256: "b".repeat(64) },
  };

  test("is a valid TrackSummary with no URL, path or hash in it", () => {
    const summary = toSummary(entry);
    expect(TrackSummary.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/https?:|sha|\/|\\/);
    expect(Object.keys(summary).sort()).toEqual(["artist", "durationMs", "explicit", "hasCover", "highlights", "title", "trackId"]);
  });

  test("keeps explicit, so the editor can badge it and the autopilot can skip it", () => {
    expect(toSummary(entry).explicit).toBe(true);
  });

  test("hasCover is true only for a stored cover", () => {
    expect(toSummary(entry).hasCover).toBe(true);
    expect(toSummary({ ...entry, cover: { state: "failed", reason: "cover-status" } }).hasCover).toBe(false);
    expect(toSummary({ ...entry, cover: { state: "none" } }).hasCover).toBe(false);
  });

  test("a track with no title gets one, so the summary stays valid", () => {
    const summary = toSummary({ ...entry, title: null });
    expect(TrackSummary.safeParse(summary).success).toBe(true);
    expect(summary.title.length).toBeGreaterThan(0);
  });
});
