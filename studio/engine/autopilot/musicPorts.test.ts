import { describe, expect, test } from "bun:test";
import { emptyUsage, trackKey, withUse } from "../../shared/autopilot/track";
import type { MusicStatus } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { AutoRefreshAnswer, AutoRefreshRequest } from "../music/service";
import type { TrendingCandidate } from "../music/trackStore";
import { createMusicPorts } from "./musicPorts";
useNativeGlobals();

// S4.6c2: the free steps' music port (`chooseMusic`) is `collectAutopilotCandidates` feeding `chooseTrack`; the auto-refresh port is `MusicService.autoRefresh` and its release. The
// chooser's own rules are pinned in shared/autopilot/track.test.ts; here is what the PORT adds: the candidates are read from the real sources, an explicit trend never reaches the
// chooser, the usage ranks, and one read serves a whole pass.

const trend = (trackId: string, over: Partial<TrendingCandidate> = {}): TrendingCandidate => ({
  source: "trending",
  trackId,
  durationMs: 30_000,
  highlights: [{ ms: 4_000, likelyDefault: false }],
  explicit: false,
  inList: true,
  ...over,
});

const STATUS: MusicStatus = { listFetchedAt: null, trackCount: 4, bytesOnDisk: 0, sentLast31d: 2, limit: 30, serverRemaining: 20, nextFreeAt: null, refresh: { state: "idle" }, quotaLog: "ok" };

interface Rig {
  ports: ReturnType<typeof createMusicPorts>;
  trends: TrendingCandidate[];
  own: Array<{ mediaId: string; durationMs: number }>;
  reads: { trends: number; own: number };
  asked: AutoRefreshRequest[];
  released: string[];
  answer: AutoRefreshAnswer;
}

function rig(): Rig {
  const state: Rig = {
    trends: [],
    own: [],
    reads: { trends: 0, own: 0 },
    asked: [],
    released: [],
    answer: { kind: "declined", reason: "list-fresh" },
    ports: undefined as never,
  };
  state.ports = createMusicPorts(
    {
      trends: {
        storedTrends: () => {
          state.reads.trends += 1;
          return state.trends;
        },
      },
      media: {
        autopilotTracks: async () => {
          state.reads.own += 1;
          return state.own;
        },
      },
    },
    {
      autoRefresh: async (request) => {
        state.asked.push(request);
        return state.answer;
      },
      status: async () => STATUS,
      releaseLaunch: (launchId) => void state.released.push(launchId),
    },
  );
  return state;
}

const input = (over: Partial<{ totalMs: number; seed: number; pass: number; usage: ReturnType<typeof emptyUsage> }> = {}) => ({ avatarId: "avatar-aaaaaaaa", totalMs: 8_000, seed: 7, usage: emptyUsage(), pass: 1, ...over });

describe("chooseMusic", () => {
  test("with no stored trend and no flagged own track the video waits: no candidate", async () => {
    const r = rig();
    expect(await r.ports.chooseMusic(input())).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("a library with only explicit trends leaves the video waiting, never an explicit track", async () => {
    const r = rig();
    r.trends = [trend("rude", { explicit: true }), trend("old-rude", { explicit: true, inList: false })];
    expect(await r.ports.chooseMusic(input())).toEqual({ kind: "waiting", reason: "no-candidate" });
  });

  test("an explicit trend is passed over for a clean one even when the explicit one is newer and longer", async () => {
    const r = rig();
    r.trends = [trend("rude", { explicit: true, durationMs: 90_000 }), trend("clean")];
    const choice = await r.ports.chooseMusic(input());
    expect(choice).toMatchObject({ kind: "chosen", music: { source: "trending", trackId: "clean" } });
  });

  test("every candidate shorter than the video gives all-too-short", async () => {
    const r = rig();
    r.trends = [trend("short", { durationMs: 7_999 })];
    expect(await r.ports.chooseMusic(input({ totalMs: 8_000 }))).toEqual({ kind: "waiting", reason: "all-too-short" });
  });

  test("a track exactly as long as the video fits, starting at 0", async () => {
    const r = rig();
    r.trends = [trend("exact", { durationMs: 8_000 })];
    expect(await r.ports.chooseMusic(input({ totalMs: 8_000 }))).toEqual({ kind: "chosen", music: { source: "trending", trackId: "exact", startMs: 0 } });
  });

  test("the least used track for the avatar ranks first", async () => {
    const r = rig();
    r.trends = [trend("worn"), trend("fresh")];
    const usage = withUse(withUse(emptyUsage(), trackKey("trending", "worn")), trackKey("trending", "worn"));
    expect(await r.ports.chooseMusic(input({ usage }))).toMatchObject({ kind: "chosen", music: { trackId: "fresh" } });
  });

  test("the usage handed in decides, so the next video of the same avatar gets another track", async () => {
    const r = rig();
    r.trends = [trend("one"), trend("two")];
    const first = await r.ports.chooseMusic(input());
    expect(first.kind).toBe("chosen");
    if (first.kind !== "chosen" || first.music.source !== "trending") throw new Error("expected a trending track");
    const second = await r.ports.chooseMusic(input({ usage: withUse(emptyUsage(), trackKey("trending", first.music.trackId)) }));
    expect(second).toMatchObject({ kind: "chosen" });
    expect(second.kind === "chosen" && second.music.source === "trending" ? second.music.trackId : "").not.toBe(first.music.trackId);
  });

  test("a flagged own track is a candidate", async () => {
    const r = rig();
    r.own = [{ mediaId: "media-aaaaaaaa", durationMs: 20_000 }];
    expect(await r.ports.chooseMusic(input())).toMatchObject({ kind: "chosen", music: { source: "own", mediaId: "media-aaaaaaaa" } });
  });

  test("one pass reads the sources once, however many videos choose in it", async () => {
    const r = rig();
    r.trends = [trend("a")];
    await r.ports.chooseMusic(input({ pass: 5 }));
    await r.ports.chooseMusic(input({ pass: 5 }));
    await r.ports.chooseMusic(input({ pass: 5 }));
    expect(r.reads).toEqual({ trends: 1, own: 1 });
  });

  test("the next pass reads them again, so a track that appeared is seen", async () => {
    const r = rig();
    expect(await r.ports.chooseMusic(input({ pass: 1 }))).toMatchObject({ kind: "waiting" });
    r.trends = [trend("late")];
    expect(await r.ports.chooseMusic(input({ pass: 2 }))).toMatchObject({ kind: "chosen", music: { trackId: "late" } });
  });

  test("a read that fails is not remembered for the pass", async () => {
    const r = rig();
    let fail = true;
    const ports = createMusicPorts(
      {
        trends: { storedTrends: () => [trend("a")] },
        media: {
          autopilotTracks: async () => {
            if (fail) throw new Error("the media index is not ready");
            return [];
          },
        },
      },
      { autoRefresh: async () => r.answer, status: async () => STATUS, releaseLaunch: () => undefined },
    );
    await expect(ports.chooseMusic(input({ pass: 1 }))).rejects.toThrow();
    fail = false;
    expect(await ports.chooseMusic(input({ pass: 1 }))).toMatchObject({ kind: "chosen" });
  });
});

describe("the auto-refresh port", () => {
  test("candidateCount is the number of tracks the autopilot could choose from now", async () => {
    const r = rig();
    r.trends = [trend("a"), trend("b"), trend("rude", { explicit: true })];
    r.own = [{ mediaId: "media-aaaaaaaa", durationMs: 20_000 }];
    expect(await r.ports.autoRefresh.candidateCount()).toBe(3);
  });

  test("candidateKeys names the tracks, trends and own, by the key the usage counts under; explicit ones are left out", async () => {
    const r = rig();
    r.trends = [trend("a"), trend("rude", { explicit: true })];
    r.own = [{ mediaId: "media-aaaaaaaa", durationMs: 20_000 }];
    expect([...(await r.ports.autoRefresh.candidateKeys())].sort()).toEqual([trackKey("own", "media-aaaaaaaa"), trackKey("trending", "a")].sort());
  });

  test("request goes to the service with the launch and the count, and returns its answer unchanged", async () => {
    const r = rig();
    r.answer = { kind: "declined", reason: "recent-auto" };
    expect(await r.ports.autoRefresh.request({ launchId: "launch-0001", candidateCount: 4 })).toEqual({ kind: "declined", reason: "recent-auto" });
    expect(r.asked).toEqual([{ launchId: "launch-0001", candidateCount: 4 }]);
  });

  test("status is the music card's status, unchanged", async () => {
    expect(await rig().ports.autoRefresh.status()).toEqual(STATUS);
  });

  test("release forgets the launch in the service", () => {
    const r = rig();
    r.ports.autoRefresh.release("launch-0001");
    expect(r.released).toEqual(["launch-0001"]);
  });
});

// S4.10 fix B: the plan card counts from the SAME collection the free steps choose from.
describe("candidates (the plan card's look)", () => {
  test("counts the saved trends that are not explicit and the flagged own tracks, and the explicit ones left out", async () => {
    const r = rig();
    r.trends = [trend("a"), trend("b", { inList: false }), trend("rude", { explicit: true })];
    r.own = [{ mediaId: "media-1", durationMs: 20_000 }];
    const found = await r.ports.candidates();
    expect([found.candidates.length, found.flaggedOwn.size, found.explicitSkipped]).toEqual([3, 1, 1]);
  });

  test("is the list chooseMusic picks from: the same keys", async () => {
    const r = rig();
    r.trends = [trend("a"), trend("rude", { explicit: true })];
    r.own = [{ mediaId: "media-1", durationMs: 20_000 }];
    const keys = (await r.ports.candidates()).candidates.map((c) => (c.source === "trending" ? trackKey("trending", c.trackId) : trackKey("own", c.mediaId)));
    expect(keys).toEqual([...(await r.ports.autoRefresh.candidateKeys())]);
  });

  test("asks for no refresh and releases no launch", async () => {
    const r = rig();
    await r.ports.candidates();
    expect([r.asked, r.released]).toEqual([[], []]);
  });

  test("reads the sources again at every call: a track that appeared meanwhile is counted", async () => {
    const r = rig();
    expect((await r.ports.candidates()).candidates).toHaveLength(0);
    r.trends = [trend("a")];
    expect((await r.ports.candidates()).candidates).toHaveLength(1);
  });
});
