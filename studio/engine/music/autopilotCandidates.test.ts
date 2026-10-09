import { describe, expect, test } from "bun:test";
import { chooseTrack, emptyUsage, trackKey, withUse, type TrackCandidate } from "../../shared/autopilot/track";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { buildAutopilotCandidates, collectAutopilotCandidates } from "./autopilotCandidates";
import type { TrendingCandidate } from "./trackStore";
useNativeGlobals();

// The candidate list for the track chooser (Stage 4, S4.5d; plan §7): every saved trending track that is not explicit (of the current list or kept from an earlier one), plus
// the own tracks the owner flagged. An explicit track and an unflagged own track are NOT in it.

const trend = (trackId: string, over: Partial<TrendingCandidate> = {}): TrendingCandidate => ({
  source: "trending",
  trackId,
  durationMs: 30_000,
  highlights: [{ ms: 4_000, likelyDefault: false }],
  explicit: false,
  inList: true,
  ...over,
});
const ids = (candidates: readonly TrackCandidate[]): string[] => candidates.map((c) => (c.source === "trending" ? `t:${c.trackId}` : `o:${c.mediaId}`));

describe("buildAutopilotCandidates", () => {
  test("a track of the current list and a track kept from an earlier list are both candidates", () => {
    const built = buildAutopilotCandidates({ trends: [trend("a"), trend("b", { inList: false })], ownFlagged: [] });
    expect(ids(built.candidates)).toEqual(["t:a", "t:b"]);
    expect(built.candidates[1]).toMatchObject({ source: "trending", inList: false });
  });

  test("an explicit track is not a candidate, and is counted as skipped", () => {
    const built = buildAutopilotCandidates({ trends: [trend("a"), trend("rude", { explicit: true }), trend("old-rude", { explicit: true, inList: false })], ownFlagged: [] });
    expect(ids(built.candidates)).toEqual(["t:a"]);
    expect(built.explicitSkipped).toBe(2);
  });

  test("a flagged own track is a candidate with its decoded length, after the trends", () => {
    const built = buildAutopilotCandidates({ trends: [trend("a")], ownFlagged: [{ mediaId: "media-aaaaaaaa", durationMs: 12_000 }] });
    expect(built.candidates).toEqual([trend("a"), { source: "own", mediaId: "media-aaaaaaaa", durationMs: 12_000 }]);
    expect([...built.flaggedOwn]).toEqual(["media-aaaaaaaa"]);
  });

  test("no flagged own track means the own tracks are not in the list and flaggedOwn is empty", () => {
    const built = buildAutopilotCandidates({ trends: [trend("a")], ownFlagged: [] });
    expect(ids(built.candidates)).toEqual(["t:a"]);
    expect(built.flaggedOwn.size).toBe(0);
  });

  test("nothing at all gives an empty list", () => {
    const built = buildAutopilotCandidates({ trends: [], ownFlagged: [] });
    expect(built).toEqual({ candidates: [], flaggedOwn: new Set<string>(), explicitSkipped: 0 });
  });

  test("the same own track twice is one candidate", () => {
    const built = buildAutopilotCandidates({ trends: [], ownFlagged: [{ mediaId: "media-aaaaaaaa", durationMs: 12_000 }, { mediaId: "media-aaaaaaaa", durationMs: 12_000 }] });
    expect(ids(built.candidates)).toEqual(["o:media-aaaaaaaa"]);
  });

  test("does not change its input", () => {
    const trends = [trend("a"), trend("rude", { explicit: true })];
    const own = [{ mediaId: "media-aaaaaaaa", durationMs: 12_000 }];
    const before = JSON.stringify({ trends, own });
    buildAutopilotCandidates({ trends, ownFlagged: own });
    expect(JSON.stringify({ trends, own })).toBe(before);
  });
});

describe("collectAutopilotCandidates", () => {
  test("reads the saved trends and the flagged own tracks and builds the list", async () => {
    const built = await collectAutopilotCandidates({
      trends: { storedTrends: () => [trend("a"), trend("rude", { explicit: true })] },
      media: { autopilotTracks: async () => [{ mediaId: "media-aaaaaaaa", durationMs: 12_000 }] },
    });
    expect(ids(built.candidates)).toEqual(["t:a", "o:media-aaaaaaaa"]);
    expect(built.explicitSkipped).toBe(1);
  });
});

describe("the list as the chooser takes it", () => {
  test("a library with only explicit trends and no flagged own track leaves the video waiting: no candidate", async () => {
    const built = await collectAutopilotCandidates({ trends: { storedTrends: () => [trend("rude", { explicit: true })] }, media: { autopilotTracks: async () => [] } });
    const choice = chooseTrack({ candidates: built.candidates, flaggedOwn: built.flaggedOwn, usage: emptyUsage(), totalMs: 8_000, seed: 1 });
    expect(choice).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("a flagged own track and a trend kept from an earlier list can both be chosen: the own one first, the other once the own one has been used", async () => {
    const built = await collectAutopilotCandidates({
      trends: { storedTrends: () => [trend("old", { inList: false })] },
      media: { autopilotTracks: async () => [{ mediaId: "media-aaaaaaaa", durationMs: 12_000 }] },
    });
    const choose = (usage: ReturnType<typeof emptyUsage>) => chooseTrack({ candidates: built.candidates, flaggedOwn: built.flaggedOwn, usage, totalMs: 8_000, seed: 1 });
    expect(choose(emptyUsage())).toMatchObject({ kind: "chosen", music: { source: "own", mediaId: "media-aaaaaaaa" } });
    expect(choose(withUse(emptyUsage(), trackKey("own", "media-aaaaaaaa")))).toMatchObject({ kind: "chosen", music: { source: "trending", trackId: "old" } });
  });
});
