import { describe, expect, test } from "bun:test";
import { parseEngineCommand, parseMessage } from "./messages";
import { ENGINE_COMMAND_TYPES } from "./commands";
import { MUSIC_QUOTA_LOG_STATES, MusicListResult, MusicPeaksResult, MusicStatus, TrackSummary } from "./state";
import { PROTOCOL_VERSION } from ".";

// Stage 3, task 3c.3: the music status (K24) and the commands and event around it (K25).

const idle = {
  listFetchedAt: "2026-09-27T20:42:44.190Z",
  trackCount: 30,
  bytesOnDisk: 52_000_000,
  sentLast31d: 2,
  limit: 30,
  serverRemaining: 28,
  nextFreeAt: "2026-10-28T20:42:44.190Z",
  refresh: { state: "idle" },
  quotaLog: "ok",
};

describe("MusicStatus", () => {
  test("accepts an idle status with a list", () => {
    expect(MusicStatus.safeParse(idle).success).toBe(true);
  });

  test("accepts a status that never refreshed: no list, no server count, no next free time", () => {
    const fresh = { ...idle, listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, serverRemaining: null, nextFreeAt: null };
    expect(MusicStatus.safeParse(fresh).success).toBe(true);
  });

  test("accepts a running refresh with its progress", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "running", done: 3, total: 61 } }).success).toBe(true);
  });

  test("rejects a running refresh that is further along than its total", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "running", done: 4, total: 3 } }).success).toBe(false);
  });

  test("accepts a failed refresh with its error", () => {
    const failed = { state: "failed", error: { code: "MUSIC_KEY_REJECTED" } };
    expect(MusicStatus.safeParse({ ...idle, refresh: failed }).success).toBe(true);
  });

  test("rejects a failed refresh without an error, and an unknown state", () => {
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "failed" } }).success).toBe(false);
    expect(MusicStatus.safeParse({ ...idle, refresh: { state: "paused" } }).success).toBe(false);
  });

  test.each([
    ["thirty sends, the most the window can hold", 30, true],
    ["thirty-one sends", 31, false],
    ["a negative count", -1, false],
    ["a fractional count", 1.5, false],
  ])("sentLast31d: %s", (_label, sentLast31d, ok) => {
    expect(MusicStatus.safeParse({ ...idle, sentLast31d }).success).toBe(ok);
  });

  test("the limit is 30", () => {
    expect(MusicStatus.safeParse({ ...idle, limit: 25 }).success).toBe(false);
  });

  test("rejects a nextFreeAt that is not an ISO time, and an unknown field", () => {
    expect(MusicStatus.safeParse({ ...idle, nextFreeAt: "tomorrow" }).success).toBe(false);
    expect(MusicStatus.safeParse({ ...idle, apiKey: "x" }).success).toBe(false);
  });
});

// Stage 3, task 3c.6: the quota log's own state, so the card can say why «Обновить» is closed before a click, and offer the
// recovery of a damaged log.
describe("MusicStatus.quotaLog", () => {
  test("the states are exactly: ok, held (a result or key line waits to be written), corrupt and unreadable", () => {
    expect([...MUSIC_QUOTA_LOG_STATES]).toEqual(["ok", "held", "corrupt", "unreadable"]);
  });

  test("is required: a status that does not say whether its count can be trusted is refused", () => {
    const { quotaLog: _quotaLog, ...without } = idle;
    expect(MusicStatus.safeParse(without).success).toBe(false);
  });

  test("an unknown state is refused", () => {
    expect(MusicStatus.safeParse({ ...idle, quotaLog: "fine" }).success).toBe(false);
  });

  test("a held line keeps the count it has: the held lines already count", () => {
    expect(MusicStatus.safeParse({ ...idle, quotaLog: "held", sentLast31d: 4 }).success).toBe(true);
  });

  test.each(["corrupt", "unreadable"] as const)("a %s log reads 30 of 30: it can never show room the log cannot vouch for", (quotaLog) => {
    expect(MusicStatus.safeParse({ ...idle, quotaLog, sentLast31d: 30, serverRemaining: null, nextFreeAt: null }).success).toBe(true);
    expect(MusicStatus.safeParse({ ...idle, quotaLog, sentLast31d: 29, serverRemaining: null, nextFreeAt: null }).success).toBe(false);
    expect(MusicStatus.safeParse({ ...idle, quotaLog, sentLast31d: 0, serverRemaining: null, nextFreeAt: null }).success).toBe(false);
  });
});

describe("the music commands and event", () => {
  const send = (type: string, payload: unknown) => parseEngineCommand({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type, payload }).ok;
  const event = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "music.changed", payload });

  test("music.refresh needs confirm: true, so a stray call cannot spend a request", () => {
    expect(send("music.refresh", { confirm: true })).toBe(true);
    expect(send("music.refresh", {})).toBe(false);
    expect(send("music.refresh", { confirm: false })).toBe(false);
    expect(send("music.refresh", { confirm: "yes" })).toBe(false);
  });

  test("music.status takes an empty payload", () => {
    expect(send("music.status", {})).toBe(true);
    expect(send("music.status", { refresh: true })).toBe(false);
  });

  test("music.changed carries the whole status and nothing else", () => {
    expect(parseMessage(event({ status: idle })).ok).toBe(true);
    expect(parseMessage(event({ status: idle, key: "x" })).ok).toBe(false);
    expect(parseMessage(event({})).ok).toBe(false);
  });

  test("the music commands are the engine's, not main's", () => {
    expect(ENGINE_COMMAND_TYPES).toContain("music.status");
    expect(ENGINE_COMMAND_TYPES).toContain("music.refresh");
    expect(ENGINE_COMMAND_TYPES).toContain("music.list");
    expect(ENGINE_COMMAND_TYPES).toContain("music.peaks");
  });

  test("music.list takes an empty payload", () => {
    expect(send("music.list", {})).toBe(true);
    expect(send("music.list", { limit: 5 })).toBe(false);
  });

  const trending = { source: "trending", trackId: "4199287736976977" };
  const peaksRequest = { track: trending, startMs: 0, durationMs: 15_000, bars: 72 };

  test("music.peaks takes a trending track or an own one, a window and 16..256 bars", () => {
    expect(send("music.peaks", peaksRequest)).toBe(true);
    expect(send("music.peaks", { ...peaksRequest, track: { source: "own", mediaId: "media-00000001" } })).toBe(true);
    expect(send("music.peaks", { ...peaksRequest, bars: 16 })).toBe(true);
    expect(send("music.peaks", { ...peaksRequest, bars: 256 })).toBe(true);
  });

  test.each([
    ["15 bars", { bars: 15 }],
    ["257 bars", { bars: 257 }],
    ["a fractional bar count", { bars: 72.5 }],
    ["a negative start", { startMs: -1 }],
    ["a zero-length window", { durationMs: 0 }],
    ["a fractional start", { startMs: 0.5 }],
    ["a track id that could be a path", { track: { source: "trending", trackId: "../../etc/passwd" } }],
    ["a trending track with a media id", { track: { source: "trending", mediaId: "media-00000001" } }],
    ["an own track with a track id", { track: { source: "own", trackId: "4199287736976977" } }],
    ["an unknown source", { track: { source: "spotify", trackId: "4199287736976977" } }],
    ["an extra field", { path: "/tmp/x" }],
  ])("music.peaks refuses %s", (_label, patch) => {
    expect(send("music.peaks", { ...peaksRequest, ...patch })).toBe(false);
  });
});

describe("TrackSummary (K23)", () => {
  const summary = {
    trackId: "4199287736976977",
    title: "Espresso",
    artist: "Sabrina Carpenter",
    durationMs: 175_000,
    explicit: false,
    highlights: [
      { ms: 42_000, likelyDefault: false },
      { ms: 78_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ],
    hasCover: true,
  };

  test("accepts a track with its highlights, the likely default last", () => {
    expect(TrackSummary.safeParse(summary).success).toBe(true);
  });

  test("accepts a track with no artist, no highlights and no cover", () => {
    expect(TrackSummary.safeParse({ ...summary, artist: null, highlights: [], hasCover: false }).success).toBe(true);
  });

  test("rejects highlights that are not ascending before the likely default", () => {
    const shuffled = [
      { ms: 78_000, likelyDefault: false },
      { ms: 42_000, likelyDefault: false },
    ];
    expect(TrackSummary.safeParse({ ...summary, highlights: shuffled }).success).toBe(false);
  });

  test("rejects a likely default that is not last", () => {
    const early = [
      { ms: 1_500, likelyDefault: true },
      { ms: 42_000, likelyDefault: false },
    ];
    expect(TrackSummary.safeParse({ ...summary, highlights: early }).success).toBe(false);
  });

  test("rejects more than one likely default", () => {
    const two = [
      { ms: 1_500, likelyDefault: true },
      { ms: 3_000, likelyDefault: true },
    ];
    expect(TrackSummary.safeParse({ ...summary, highlights: two }).success).toBe(false);
  });

  test("allows 8 highlights and refuses 9", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ms: (i + 1) * 1000, likelyDefault: false }));
    expect(TrackSummary.safeParse({ ...summary, highlights: many(8) }).success).toBe(true);
    expect(TrackSummary.safeParse({ ...summary, highlights: many(9) }).success).toBe(false);
  });

  test.each([
    ["an empty title", { title: "" }],
    ["a 121-char title", { title: "x".repeat(121) }],
    ["an empty artist", { artist: "" }],
    ["a 121-char artist", { artist: "x".repeat(121) }],
    ["a fractional duration", { durationMs: 1.5 }],
    ["a track id that could be a path", { trackId: "../x" }],
    ["a signed URL field", { downloadUrl: "https://scontent-fra3-1.cdninstagram.com/x" }],
  ])("rejects %s", (_label, patch) => {
    expect(TrackSummary.safeParse({ ...summary, ...patch }).success).toBe(false);
  });

  test("music.list answers at most 100 tracks", () => {
    const answer = (n: number) => ({ tracks: Array.from({ length: n }, () => summary) });
    expect(MusicListResult.safeParse(answer(100)).success).toBe(true);
    expect(MusicListResult.safeParse(answer(101)).success).toBe(false);
  });

  test("music.peaks answers integers from 0 to 1000, one per bar", () => {
    const peaks = (values: number[]) => MusicPeaksResult.safeParse({ peaks: values }).success;
    expect(peaks(Array.from({ length: 72 }, (_, i) => (i * 14) % 1001))).toBe(true);
    expect(peaks(Array.from({ length: 72 }, () => 1001))).toBe(false);
    expect(peaks(Array.from({ length: 72 }, () => -1))).toBe(false);
    expect(peaks(Array.from({ length: 72 }, () => 0.5))).toBe(false);
    expect(peaks(Array.from({ length: 15 }, () => 0))).toBe(false);
    expect(peaks(Array.from({ length: 257 }, () => 0))).toBe(false);
  });
});
