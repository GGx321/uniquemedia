import { describe, expect, test } from "bun:test";
import { MAX_LISTED_TRACKS, MAX_TRACK_HIGHLIGHTS, MusicListResult, MusicPeaksResult, type EngineError } from "../../shared/engine";
import type { MockTrackSeed } from "./mockMusicStore";
import { makeMock, MIA, PHOTO_IDS, unwrap, type Mock } from "./mockEngine.testkit";

// 3d.1b: the dev mock answers `music.list` and `music.peaks` as the engine's track store does (studio/engine/music/trackStore.ts):
// the stored tracks in list order with their highlights ascending and the likely default last, a waveform window read from the
// envelope kept at download time, NOT_FOUND for a track that is not stored. The same stories run against the real engine in
// studio/engine/parity.

const seed = (n: number, over: Partial<MockTrackSeed> = {}): MockTrackSeed => ({
  trackId: `4199287736976${String(n).padStart(3, "0")}`,
  title: `Track ${n}`,
  artist: n % 2 === 0 ? null : `Artist ${n}`,
  durationMs: 8000,
  explicit: false,
  highlightsMs: [],
  hasCover: true,
  peaks: Array.from({ length: 160 }, (_, i) => (i * 7) % 1000),
  ...over,
});

const list = async (mock: Mock) => MusicListResult.parse(await unwrap(mock.client.request("music.list", {})));
const peaks = (mock: Mock, trackId: string, startMs = 0, durationMs = 8000, bars = 16) =>
  mock.client.request("music.peaks", { track: { source: "trending", trackId }, startMs, durationMs, bars });

async function refused(reply: ReturnType<typeof peaks>): Promise<EngineError> {
  const answer = await reply;
  if (answer.ok) throw new Error("expected a refusal");
  return answer.error;
}

describe("music.list", () => {
  test("of a mock with no track: nothing", async () => {
    expect(await list(makeMock())).toEqual({ tracks: [] });
  });

  test("answers the stored tracks in the order they were given, as the contract's summaries", async () => {
    const mock = makeMock({ music: { tracks: [seed(1), seed(2), seed(3)] } });
    const { tracks } = await list(mock);
    expect(tracks.map((t) => t.trackId)).toEqual([seed(1).trackId, seed(2).trackId, seed(3).trackId]);
    expect(tracks[0]).toEqual({ trackId: seed(1).trackId, title: "Track 1", artist: "Artist 1", durationMs: 8000, explicit: false, highlights: [], hasCover: true });
  });

  test("carries the explicit flag, and an artist that is null", async () => {
    const mock = makeMock({ music: { tracks: [seed(2, { explicit: true })] } });
    const [track] = (await list(mock)).tracks;
    expect(track?.explicit).toBe(true);
    expect(track?.artist).toBe(null);
  });

  test("a track with no cover says so", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { hasCover: false })] } });
    expect((await list(mock)).tracks[0]?.hasCover).toBe(false);
  });

  test("highlights come ascending, with the 1500 default last and flagged", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { highlightsMs: [5000, 1500, 800, 3000] })] } });
    expect((await list(mock)).tracks[0]?.highlights).toEqual([
      { ms: 800, likelyDefault: false },
      { ms: 3000, likelyDefault: false },
      { ms: 5000, likelyDefault: false },
      { ms: 1500, likelyDefault: true },
    ]);
  });

  test("a start at or past the end of the track is dropped, and a repeat is kept once", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { highlightsMs: [7999, 8000, 99_000, 7999] })] } });
    expect((await list(mock)).tracks[0]?.highlights).toEqual([{ ms: 7999, likelyDefault: false }]);
  });

  test("keeps at most eight highlights, the default among them", async () => {
    const many = Array.from({ length: 12 }, (_, i) => 100 + i * 100).filter((ms) => ms !== 1500);
    const mock = makeMock({ music: { tracks: [seed(1, { durationMs: 60_000, highlightsMs: [...many, 1500] })] } });
    const highlights = (await list(mock)).tracks[0]?.highlights ?? [];
    expect(highlights.length).toBe(MAX_TRACK_HIGHLIGHTS);
    expect(highlights.at(-1)).toEqual({ ms: 1500, likelyDefault: true });
  });

  test("answers at most 100 tracks", async () => {
    const mock = makeMock({ music: { tracks: Array.from({ length: MAX_LISTED_TRACKS + 5 }, (_, i) => seed(i)) } });
    expect((await list(mock)).tracks.length).toBe(MAX_LISTED_TRACKS);
  });

  test("is free and independent of the key and the quota log: no key, a damaged log, a rejected key", async () => {
    const mock = makeMock({ musicKey: { stored: true, last4: "7c1e", rejected: true }, music: { quotaLog: "corrupt", tracks: [seed(1)] } });
    expect((await list(mock)).tracks.length).toBe(1);
    mock.engine.setMusicQuotaLog("missing");
    expect((await list(mock)).tracks.length).toBe(1);
  });

  test("the status counts the tracks the list holds", async () => {
    const mock = makeMock({ music: { tracks: [seed(1), seed(2)] } });
    const status = await unwrap(mock.client.request("music.status", {}));
    expect(status.trackCount).toBe(2);
    expect(status.listFetchedAt === null).toBe(false);
  });

  test("seedMusicTracks replaces what the mock holds and announces nothing", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    const before = mock.events.length;
    mock.engine.seedMusicTracks([seed(2), seed(3)]);
    expect((await list(mock)).tracks.map((t) => t.title)).toEqual(["Track 2", "Track 3"]);
    expect(mock.events.length).toBe(before);
  });

  test("after a refresh the list holds as many tracks as the status counts", async () => {
    const mock = makeMock({ musicKey: { stored: true, last4: "7c1e", rejected: false } });
    await unwrap(mock.client.request("music.refresh", { confirm: true }));
    mock.scheduler.runAll();
    const status = await unwrap(mock.client.request("music.status", {}));
    const { tracks } = await list(mock);
    expect(tracks.length).toBe(status.trackCount);
    expect(tracks.length).toBeGreaterThan(0);
  });

  test("the demo preset lists the 30 tracks its status counts, each a valid summary", async () => {
    const demo = makeMock({ preset: "demo" });
    const status = await unwrap(demo.client.request("music.status", {}));
    const { tracks } = await list(demo);
    expect(tracks.length).toBe(status.trackCount);
  });
});

describe("music.peaks", () => {
  test("answers one integer from 0 to 1000 per bar", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    const answer = MusicPeaksResult.parse(await unwrap(peaks(mock, seed(1).trackId, 0, 8000, 72)));
    expect(answer.peaks.length).toBe(72);
  });

  test("reads the largest envelope step each bar covers", async () => {
    const envelope = Array.from({ length: 160 }, () => 100);
    envelope[3] = 900;
    envelope[20] = 400;
    const mock = makeMock({ music: { tracks: [seed(1, { peaks: envelope })] } });
    // 16 bars of 50 ms = 800 ms: one step per bar; bar 3 is step 3.
    const answer = await unwrap(peaks(mock, seed(1).trackId, 0, 800, 16));
    expect(answer.peaks[3]).toBe(900);
    expect(answer.peaks[0]).toBe(100);
    expect(answer.peaks[4]).toBe(100);
  });

  test("a window starting later reads later steps", async () => {
    const envelope = Array.from({ length: 160 }, () => 0);
    envelope[20] = 700;
    const mock = makeMock({ music: { tracks: [seed(1, { peaks: envelope })] } });
    const answer = await unwrap(peaks(mock, seed(1).trackId, 1000, 800, 16));
    expect(answer.peaks[0]).toBe(700);
  });

  test("time past the end of the envelope is silence", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { peaks: [500, 500] })] } });
    const answer = await unwrap(peaks(mock, seed(1).trackId, 5000, 800, 16));
    expect(answer.peaks).toEqual(Array(16).fill(0));
  });

  test("a track that is not stored is NOT_FOUND, and says which", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    const error = await refused(peaks(mock, "4199287736976999"));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.detail).toBe("track 4199287736976999 is not stored");
  });

  test("an own track is NOT_FOUND until 3f", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    const answer = await mock.client.request("music.peaks", { track: { source: "own", mediaId: "media-0000001" }, startMs: 0, durationMs: 1000, bars: 16 });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.code).toBe("NOT_FOUND");
      expect(answer.error.detail).toBe("own music is not available yet");
    }
  });

  test("fewer than 16 bars, more than 256 and an empty window break the contract", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    expect((await refused(peaks(mock, seed(1).trackId, 0, 8000, 15))).code).toBe("VALIDATION");
    expect((await refused(peaks(mock, seed(1).trackId, 0, 8000, 257))).code).toBe("VALIDATION");
    expect((await refused(peaks(mock, seed(1).trackId, 0, 0, 16))).code).toBe("VALIDATION");
  });

  test("a track that fell out of the store is gone for peaks too", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    mock.engine.seedMusicTracks([]);
    expect((await refused(peaks(mock, seed(1).trackId))).code).toBe("NOT_FOUND");
  });
});

describe("a montage's trending track", () => {
  const spec = async (mock: Mock, trackId: string, startMs: number) => {
    const created = (await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [PHOTO_IDS[0] ?? ""] }))).montage;
    await unwrap(mock.client.request("montages.save", { montageId: created.montageId, spec: { ...created.spec, music: { source: "trending", trackId, startMs } }, name: null }));
    return unwrap(mock.client.request("montages.get", { montageId: created.montageId }));
  };

  test("a stored track that is long enough is no issue", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { durationMs: 60_000 })] } });
    expect((await spec(mock, seed(1).trackId, 0)).issues).toEqual([]);
  });

  test("a stored track too short for its start plus the montage is track-too-short", async () => {
    const mock = makeMock({ music: { tracks: [seed(1, { durationMs: 2_000 })] } });
    expect((await spec(mock, seed(1).trackId, 1_500)).issues).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("a track the store does not hold is track-unavailable", async () => {
    const mock = makeMock({ music: { tracks: [seed(1)] } });
    expect((await spec(mock, "4199287736976999", 0)).issues).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });
});

// 3d.3b verify: the decode may prove a length up to max(2 s, 5 %) away from the list's claim. The store, the list and every
// judgement go by the PROVEN one, so the editor never offers a start the render then refuses.
describe("a track whose decode proved another length than the list claimed", () => {
  const apart = seed(1, { declaredMs: 30_000, durationMs: 29_100, highlightsMs: [12_000, 29_500, 1_500], peaks: Array.from({ length: 582 }, (_, i) => (i * 7) % 1000) });

  test("music.list gives the proven length, and no highlight past it", async () => {
    const [track] = (await list(makeMock({ music: { tracks: [apart] } }))).tracks;
    expect(track?.durationMs).toBe(29_100);
    expect(track?.highlights).toEqual([
      { ms: 12_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ]);
  });

  test("montages.get judges a start by the proven length: the last start that fits it is fine, one more is track-too-short", async () => {
    const mock = makeMock({ music: { tracks: [apart] } });
    const created = (await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [PHOTO_IDS[0] ?? ""] }))).montage;
    const total = created.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
    const judged = async (startMs: number) => {
      await unwrap(mock.client.request("montages.save", { montageId: created.montageId, spec: { ...created.spec, music: { source: "trending", trackId: apart.trackId, startMs } }, name: null }));
      return (await unwrap(mock.client.request("montages.get", { montageId: created.montageId }))).issues;
    };
    expect(await judged(29_100 - total)).toEqual([]);
    expect(await judged(29_100 - total + 1)).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });

  test("a claim the decode proved too long the other way is listed by the proven length too", async () => {
    expect((await list(makeMock({ music: { tracks: [seed(2, { declaredMs: 30_000, durationMs: 31_400 })] } }))).tracks[0]?.durationMs).toBe(31_400);
  });
});
