import { describe, expect, test } from "bun:test";
import { emptyUsage, trackKey, withUse, type TrackUsage } from "../../shared/autopilot/track";
import type { MusicStatus } from "../../shared/engine";
import { LaunchView } from "../../shared/engine/autopilot";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { AutoRefreshAnswer, AutoRefreshRequest } from "../music/service";
import type { TrendingCandidate } from "../music/trackStore";
import { until } from "../testing/engineHarness";
import { within } from "../testing/within";
import type { FreeStepsDeps } from "./freeSteps";
import { launchViewOf } from "./launchView";
import { createMusicPorts } from "./musicPorts";
import { A } from "./testing/launchFixtures";
import { distinctPhotos } from "./testing/planFixtures";
import { patchVideo, rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6c2 (plan §7, A9, A11): the free path's music. A video with no fitting track WAITS (`waiting-music`, its photos kept), it is never rendered silent, and it goes on by itself when a
// track appears. The track comes from the real port (`createMusicPorts`) over scripted sources; the auto-refresh is asked of a scripted service.

/** A track id the contract accepts (8 to 64 characters of a-z, 0-9 and -). */
const id = (name: string): string => `track-${name}`;
const trend = (name: string, over: Partial<TrendingCandidate> = {}): TrendingCandidate => ({
  source: "trending",
  trackId: id(name),
  durationMs: 60_000,
  highlights: [{ ms: 4_000, likelyDefault: false }],
  explicit: false,
  inList: true,
  ...over,
});

const idle = (over: Partial<MusicStatus> = {}): MusicStatus => ({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 4, limit: 30, serverRemaining: null, nextFreeAt: null, refresh: { state: "idle" }, quotaLog: "ok", ...over });
const running = (): MusicStatus => idle({ refresh: { state: "running", done: 0, total: 1 } });

interface Music {
  trends: TrendingCandidate[];
  own: Array<{ mediaId: string; durationMs: number }>;
  asked: AutoRefreshRequest[];
  released: string[];
  answer: AutoRefreshAnswer;
  /** What the music card reports now: a test moves it from running to idle to end a refresh. */
  status: MusicStatus;
  deps(): Pick<FreeStepsDeps, "chooseMusic" | "autoRefresh">;
}

/** Scripted music sources and a scripted refresh service behind the real ports. */
function music(answer: AutoRefreshAnswer = { kind: "declined", reason: "list-fresh" }): Music {
  const state: Music = {
    trends: [],
    own: [],
    asked: [],
    released: [],
    answer,
    status: idle(),
    deps: () => ({ chooseMusic: ports.chooseMusic, autoRefresh: ports.autoRefresh }),
  };
  const ports = createMusicPorts(
    { trends: { storedTrends: () => state.trends }, media: { autopilotTracks: async () => state.own } },
    {
      autoRefresh: async (request) => {
        state.asked.push(request);
        return state.answer;
      },
      status: async () => state.status,
      releaseLaunch: (launchId) => void state.released.push(launchId),
    },
  );
  return state;
}

const trackIdsOf = (calls: ReadonlyArray<{ spec: { music: unknown } }>): string[] =>
  calls.map((call) => {
    const m = call.spec.music;
    return typeof m === "object" && m !== null && "trackId" in m && typeof m.trackId === "string" ? m.trackId : "(none)";
  });

describe("no fitting track: the video waits and is never rendered silent (A9)", () => {
  test("with no candidate at all the video becomes waiting-music, keeps its photos and has no track", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait for music", 4_000);
    const video = videosOf(r.launch)[0];
    expect(video?.photoIds).toHaveLength(video?.size ?? -1);
    expect(video?.music).toBeUndefined();
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("when every candidate is too short for the video it waits too", async () => {
    const m = music();
    m.trends = [trend("short", { durationMs: 1_000 })];
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait for music", 4_000);
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("an explicit trend is never chosen: a library with only explicit tracks renders nothing", async () => {
    const m = music();
    m.trends = [trend("rude", { explicit: true })];
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("every render that does go out carries a track (never silent)", async () => {
    const m = music();
    m.trends = [trend("one"), trend("two")];
    const r = rig({ draft: { videosPerAvatar: 3 }, deps: m.deps() });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.videos.calls).toHaveLength(3);
    for (const call of r.videos.calls) expect(call.spec.music).not.toBeNull();
  });

  test("the launch stays running while only waiting videos remain", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(60);
    expect(r.launch.finished()).toBe(false);
    expect(r.launch.ctx.isRunning()).toBe(true);
  });
});

describe("the wait is counted and logged", () => {
  test("the view carries the number of waiting videos, over the launch and on the avatar's row", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 3 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "all videos to wait", 4_000);
    const view = LaunchView.parse(
      launchViewOf(r.launch.file(), { status: "running", nowMs: Date.parse("2026-10-09T10:10:00.000Z"), spentMicros: 0, inFlight: { requests: 0, openMicros: 0 }, resumeBlockedBy: null, logTail: [] }),
    );
    expect(view.waitingMusic).toBe(3);
    expect(view.avatars[0]?.waitingMusic).toBe(3);
  });

  test("each waiting video is written to the log once, with its key and the length it needs, however long it waits", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(150);
    const lines = r.launch.logs.filter((l) => l.kind === "waiting-music");
    expect(lines.map((l) => (l.kind === "waiting-music" ? l.key : ""))).toEqual(["0-1", "0-2"]);
    for (const line of lines) expect(line.kind === "waiting-music" ? line.neededMs : 0).toBeGreaterThan(0);
  });

  test("a waiting video that is not yet assigned a track does not touch the write count while it waits", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    await settleFor(40);
    const writes = r.launch.updates;
    await settleFor(150);
    expect(r.launch.updates).toBe(writes);
  });
});

describe("a track appears", () => {
  test("the waiting videos render, each with a track, once a trend is stored (found by the next look)", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 3 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "all videos to wait", 4_000);
    m.trends = [trend("late")];
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(videosOf(r.launch).every((v) => v.state === "done")).toBe(true);
    expect(new Set(trackIdsOf(r.videos.calls))).toEqual(new Set([id("late")]));
  });

  test("a poke makes it look at once, even with a long idle interval", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { ...m.deps(), idlePollMs: 60_000, recheckMs: 60_000 } });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    m.trends = [trend("late")];
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
  });

  test("an own track flagged «для автопилота» ends the wait", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    m.own = [{ mediaId: "media-aaaaaaaa", durationMs: 60_000 }];
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.videos.calls[0]?.spec.music).toMatchObject({ source: "own", mediaId: "media-aaaaaaaa" });
  });

  test("a video the file already shows as waiting-music (after a restart and «Продолжить») goes on when a track is there", async () => {
    const m = music();
    m.trends = [trend("ready")];
    const photoId = distinctPhotos(8, { avatarId: A }, 3)[0]?.id ?? "";
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps(), file: (file) => patchVideo(file, "0-1", { state: "waiting-music", photoIds: [photoId] }) });
    r.start();
    await until(() => r.launch.finished() || r.videos.calls.length > 0, "a render", 4_000);
    expect(trackIdsOf(r.videos.calls)).toEqual([id("ready")]);
  });
});

describe("which track: the least used for the avatar", () => {
  test("the avatar's usage ranks the candidates: the track used least goes first", async () => {
    const m = music();
    m.trends = [trend("worn"), trend("fresh")];
    const usage: TrackUsage = withUse(withUse(emptyUsage(), trackKey("trending", id("worn"))), trackKey("trending", id("worn")));
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { ...m.deps(), trackUsage: async () => usage } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(trackIdsOf(r.videos.calls)).toEqual([id("fresh")]);
  });

  test("videos of one launch spread over the tracks: each choice counts the ones before it", async () => {
    const m = music();
    m.trends = [trend("one"), trend("two"), trend("three")];
    const r = rig({ draft: { videosPerAvatar: 3 }, deps: m.deps() });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(new Set(trackIdsOf(r.videos.calls)).size).toBe(3);
  });

  test("the usage is read once per avatar per launch, however many looks the wait takes", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(100);
    m.trends = [trend("late")];
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.usageCalls).toEqual([A]);
  });
});

describe("the one automatic refresh of a launch (A11)", () => {
  test("a launch whose videos wait asks for a refresh with its id and the number of candidates it has", async () => {
    const m = music({ kind: "declined", reason: "list-fresh" });
    m.trends = [trend("short", { durationMs: 1_000 })];
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length >= 1, "the refresh to be asked", 4_000);
    expect(m.asked[0]).toEqual({ launchId: r.launch.file().launchId, candidateCount: 1 });
  });

  test("a refresh that started is the launch's only one: nothing more is asked while its videos go on waiting", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(150);
    expect(m.asked).toHaveLength(1);
  });

  test("a refresh that failed is not retried", async () => {
    const m = music({ kind: "failed", error: { code: "MUSIC_UNAVAILABLE", detail: "the refresh did not leave" } });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    await settleFor(150);
    expect(m.asked).toHaveLength(1);
  });

  test("when the rule declines, nothing is sent and the launch is asked at most twice (at its start, and when its videos wait)", async () => {
    const m = music({ kind: "declined", reason: "auto-quota" });
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(200);
    expect(m.asked.length).toBeLessThanOrEqual(2);
    expect(videosOf(r.launch).every((v) => v.state === "waiting-music")).toBe(true);
  });

  test("a launch with enough music asks once at its start (the rule decides) and never again", async () => {
    const m = music({ kind: "declined", reason: "list-fresh" });
    m.trends = [trend("one"), trend("two"), trend("three")];
    const r = rig({ draft: { videosPerAvatar: 3 }, deps: m.deps() });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(m.asked).toHaveLength(1);
  });

  test("the refresh that started brings a track: the waiting videos then render", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the refresh to be asked", 4_000);
    m.trends = [trend("refreshed")];
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(new Set(trackIdsOf(r.videos.calls))).toEqual(new Set([id("refreshed")]));
    expect(m.asked).toHaveLength(1);
  });

  test("a refresh that started is told in the log once it ends: the tracks it added and the quota left", async () => {
    const m = music({ kind: "started", status: running() });
    m.status = running();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the refresh to be asked", 4_000);
    await settleFor(60);
    expect(r.launch.logs.some((l) => l.kind === "music-refresh")).toBe(false);
    m.trends = [trend("one"), trend("two"), trend("three")];
    m.status = idle({ trackCount: 3, sentLast31d: 5 });
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    const lines = r.launch.logs.filter((l) => l.kind === "music-refresh");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "music-refresh", added: 3, remaining: 25 });
  });

  test("the quota left is the smaller of the local count and the server's own", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    m.status = idle({ trackCount: 0, sentLast31d: 5, serverRemaining: 11 });
    r.start();
    await until(() => r.launch.logs.some((l) => l.kind === "music-refresh"), "the refresh line", 4_000);
    expect(r.launch.logs.find((l) => l.kind === "music-refresh")).toMatchObject({ added: 0, remaining: 11 });
  });

  test("a refresh that was declined writes no refresh line", async () => {
    const m = music({ kind: "declined", reason: "list-fresh" });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    await settleFor(100);
    expect(r.launch.logs.some((l) => l.kind === "music-refresh")).toBe(false);
  });

  test("nothing is asked while the launch is paused, and the resume does not ask again after the one it had", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the refresh to be asked", 4_000);
    r.launch.pause();
    await within(r.steps.drain(), 4_000, "the drain");
    r.launch.settlePause();
    await settleFor(100);
    expect(m.asked).toHaveLength(1);
    r.launch.resume();
    r.start();
    await settleFor(100);
    expect(m.asked).toHaveLength(1);
  });

  test("a launch that was loaded but not begun (a restart, before «Продолжить») asks for nothing and reads no music", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    await settleFor(120);
    expect(m.asked).toHaveLength(0);
    expect(r.usageCalls).toHaveLength(0);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("without the dependency the videos wait and nothing breaks", async () => {
    const m = music();
    const { autoRefresh: _unused, ...withoutRefresh } = m.deps();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: withoutRefresh });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    expect(m.asked).toHaveLength(0);
  });

  test("a refresh that throws is warned and the videos keep waiting", async () => {
    const warnings: string[] = [];
    const m = music();
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: { ...m.deps(), autoRefresh: { candidateCount: async () => 0, candidateKeys: async () => [], request: async () => Promise.reject(new Error("boom")), status: async () => idle(), release: () => undefined }, warn: (line) => void warnings.push(line) },
    });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("fix round 1: the attempt is in the launch file (M2)", () => {
  test("the attempt is written to the file before the request leaves", async () => {
    const m = music({ kind: "started", status: running() });
    let atRequest: string | undefined = "not asked";
    const base = m.deps();
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: {
        chooseMusic: base.chooseMusic,
        autoRefresh: {
          ...(base.autoRefresh as NonNullable<FreeStepsDeps["autoRefresh"]>),
          request: async (request) => {
            atRequest = r.launch.file().autoRefreshAskedAt;
            return base.autoRefresh?.request(request) ?? { kind: "declined", reason: "no-key" };
          },
        },
      },
    });
    r.start();
    await until(() => m.asked.length === 1, "the refresh to be asked", 4_000);
    expect(atRequest).toBeDefined();
    expect(r.launch.file().autoRefreshAskedAt).toBe(atRequest);
  });

  test("a launch whose file says it asked (a restart, a pause of any length) asks nothing on «Продолжить»", async () => {
    const m = music({ kind: "started", status: running() });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps(), file: (file) => ({ ...file, autoRefreshAskedAt: "2026-10-09T08:00:00.000Z" }) });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    await settleFor(100);
    expect(m.asked).toHaveLength(0);
  });

  test("a fresh FreeRun of the same launch (the steps rebuilt after a restart) reads the attempt from the file", async () => {
    const m = music({ kind: "started", status: running() });
    const first = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    first.start();
    await until(() => m.asked.length === 1, "the first ask", 4_000);
    const kept = first.launch.file();
    const second = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps(), file: () => kept });
    second.start();
    await settleFor(120);
    expect(m.asked).toHaveLength(1);
  });

  test("a decline sent nothing, so it leaves no attempt in the file", async () => {
    const m = music({ kind: "declined", reason: "list-fresh" });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the ask", 4_000);
    await settleFor(40);
    expect(r.launch.file().autoRefreshAskedAt).toBeUndefined();
  });

  test.each(["shutting-down", "not-available", "no-music-folder", "clock", "config", "log-held", "log-missing", "log-unwritable"] as const)(
    "L1: a failed answer that sent nothing (%s) is a decline: no attempt is kept",
    async (musicReason) => {
      const m = music({ kind: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason, detail: "nothing was sent" } });
      const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
      r.start();
      await until(() => m.asked.length === 1, "the ask", 4_000);
      await settleFor(40);
      expect(r.launch.file().autoRefreshAskedAt).toBeUndefined();
    },
  );

  test("a failed answer of a request that left keeps the attempt", async () => {
    const m = music({ kind: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason: "network", detail: "the request failed" } });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the ask", 4_000);
    await settleFor(40);
    expect(r.launch.file().autoRefreshAskedAt).toBeDefined();
  });

  test("L2: a pause that lands while the question is prepared stops it: no request", async () => {
    const m = music({ kind: "started", status: running() });
    const base = m.deps();
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: {
        chooseMusic: base.chooseMusic,
        autoRefresh: {
          ...(base.autoRefresh as NonNullable<FreeStepsDeps["autoRefresh"]>),
          candidateKeys: async () => {
            r.launch.pause();
            return [];
          },
        },
      },
    });
    r.start();
    await settleFor(120);
    expect(m.asked).toHaveLength(0);
    expect(r.launch.file().autoRefreshAskedAt).toBeUndefined();
  });
});

describe("fix round 1: the candidates of one launch are not another's (M1)", () => {
  test("a track unflagged between two launches is not offered to the second one, whichever pass it is on", async () => {
    const m = music();
    m.own = [{ mediaId: "media-aaaaaaaa", durationMs: 60_000 }];
    const first = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    first.start();
    await until(() => first.launch.finished(), "the first launch to finish", 4_000);
    expect(first.videos.calls[0]?.spec.music).toMatchObject({ source: "own" });
    m.own = [];
    const second = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    second.start();
    await until(() => videosOf(second.launch)[0]?.state === "waiting-music", "the second launch to wait", 4_000);
    expect(second.videos.calls).toHaveLength(0);
  });
});

describe("fix round 1: a done video keeps its length and size (M5)", () => {
  test("the file carries the finished video's duration and bytes, with the track it was given", async () => {
    const m = music();
    m.trends = [trend("one")];
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    const video = videosOf(r.launch)[0];
    expect(video).toMatchObject({ state: "done", bytes: 4096, music: { source: "trending", trackId: id("one") } });
    expect(video?.durationMs).toBeGreaterThan(0);
  });
});

describe("fix round 1: what a refresh added (M4)", () => {
  test("a refresh that replaces the list counts the new tracks, not the change in the count", async () => {
    const m = music({ kind: "started", status: running() });
    m.trends = [trend("old1", { durationMs: 1_000 }), trend("old2", { durationMs: 1_000 })];
    m.status = running();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the ask", 4_000);
    m.trends = [trend("new1", { durationMs: 1_000 }), trend("new2", { durationMs: 1_000 }), trend("old2", { durationMs: 1_000 })];
    m.status = idle({ trackCount: 3, sentLast31d: 5 });
    r.steps.poke();
    await until(() => r.launch.logs.some((l) => l.kind === "music-refresh"), "the refresh line", 4_000);
    expect(r.launch.logs.find((l) => l.kind === "music-refresh")).toMatchObject({ added: 2 });
  });

  test("a refresh that brings nothing new says 0", async () => {
    const m = music({ kind: "started", status: running() });
    m.trends = [trend("same1", { durationMs: 1_000 })];
    m.status = running();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => m.asked.length === 1, "the ask", 4_000);
    m.status = idle({ trackCount: 1 });
    r.steps.poke();
    await until(() => r.launch.logs.some((l) => l.kind === "music-refresh"), "the refresh line", 4_000);
    expect(r.launch.logs.find((l) => l.kind === "music-refresh")).toMatchObject({ added: 0 });
  });
});

describe("the service forgets a launch that closes", () => {
  test("«Стоп» (release) lets the service forget the launch", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    await within(r.steps.release(r.launch.ctx), 4_000, "the release");
    expect(m.released).toEqual([r.launch.file().launchId]);
  });

  test("the end of the launch (complete) lets the service forget it", async () => {
    const m = music();
    m.trends = [trend("one")];
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    await within(r.steps.complete?.(r.launch.ctx) ?? Promise.resolve(), 4_000, "complete");
    expect(m.released).toEqual([r.launch.file().launchId]);
  });

  test("a pause is not a close: the service keeps what it knows", async () => {
    const m = music();
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: m.deps() });
    r.start();
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music", "the video to wait", 4_000);
    r.launch.pause();
    await within(r.steps.drain(), 4_000, "the drain");
    expect(m.released).toEqual([]);
  });
});
