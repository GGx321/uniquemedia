import { describe, expect, test } from "bun:test";
import { LaunchView, WaitingReason, type LaunchDraftInput } from "../../shared/engine";
import { errorOf, MIA, resumeRun, runUntil, runWorld, SOFIA, startRun, tick, toDone, track, unwrap, viewOf } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: what the WORLD does to a launch the mock runs, and the free half of the plan's §4.6 table: the export folder (a missing folder, a full disk), the tracks (a video that
// waits for one), the avatar that another job holds, an open scene set, a library that cannot say which photos are free. The paid holds are in mockEngine.launchRun.holds.test.ts.

/** Two slides videos from the library of Sofia (12 free photos): no paid work at all. */
const LIBRARY: Partial<LaunchDraftInput> = { avatarIds: [SOFIA.avatarId], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 };

describe("the export folder (free hold: export)", () => {
  test("a folder that goes missing holds the renders, not the launch: the hold names the reason and is logged once; a folder that is back ends it", async () => {
    const mock = runWorld();
    const started = await startRun(mock, LIBRARY);
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const held = await runUntil(mock, started.launchId, "the export hold", (v) => v.freeHold !== null);
    expect(held).toMatchObject({ status: "running", paidHold: null, freeHold: { reason: "export", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } } });
    expect(held.avatars[0]).toMatchObject({ videos: { done: 0, total: 2 } });
    tick(mock, 12);
    const still = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(still.log.filter((l) => l.kind === "hold-export")).toHaveLength(1);
    expect(still.launch.freeHold?.reason).toBe("export");
    mock.engine.setExportDisk({ status: "ok" });
    const done = await toDone(mock, started.launchId);
    expect(done.freeHold).toBeNull();
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 } });
  });

  test("a full disk is the same hold with the figures: what the next video needs and what the folder has", async () => {
    const mock = runWorld();
    const started = await startRun(mock, LIBRARY);
    mock.engine.setExportFreeBytes(1_000_000);
    const held = await runUntil(mock, started.launchId, "the disk hold", (v) => v.freeHold !== null);
    expect(held.freeHold).toMatchObject({ reason: "export", detail: { exportReason: "not-enough-space", neededBytes: 9_000_000, freeBytes: 1_000_000 } });
    expect(held.logTail.at(-1)).toMatchObject({ kind: "hold-export", exportReason: "not-enough-space" });
    mock.engine.setExportFreeBytes(null);
    expect((await toDone(mock, started.launchId)).freeHold).toBeNull();
  });

  test("a change of reason is a new hold and a new log line; paid work goes on under the hold", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { library: true, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 });
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const held = await runUntil(mock, started.launchId, "the export hold", (v) => v.freeHold !== null);
    // Mia's second video is generated: the draw is bought while the folder is away.
    const drawn = await runUntil(mock, started.launchId, "the photos drawn", (v) => v.avatars[0]?.photos.done === 5);
    expect(drawn.freeHold?.reason).toBe("export");
    expect(held.paidHold).toBeNull();
    mock.engine.setExportDisk({ status: "unavailable", reason: "not-a-directory" });
    const changed = await runUntil(mock, started.launchId, "the new reason", (v) => v.freeHold?.detail.exportReason === "not-a-directory");
    expect(changed.freeHold?.detail.exportReason).toBe("not-a-directory");
    const lines = (await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }))).log.filter((l) => l.kind === "hold-export");
    expect(lines.map((l) => (l.kind === "hold-export" ? l.exportReason : ""))).toEqual(["missing", "not-a-directory"]);
    mock.engine.setExportDisk({ status: "ok" });
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });
});

describe("music (a video that waits for a track)", () => {
  test("with no track stored the videos wait: the launch keeps running, the count is on the card, each wait is logged once, and nothing is rendered", async () => {
    const mock = runWorld({}, null);
    const started = await startRun(mock, LIBRARY);
    const waiting = await runUntil(mock, started.launchId, "videos waiting for music", (v) => v.waitingMusic === 2);
    expect(waiting).toMatchObject({ status: "running", waitingMusic: 2 });
    expect(waiting.avatars[0]).toMatchObject({ waitingMusic: 2, videos: { done: 0, total: 2 } });
    tick(mock, 10);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.videos.map((v) => [v.state, v.track, v.videoId])).toEqual([
      ["waiting-music", null, null],
      ["waiting-music", null, null],
    ]);
    expect(got.log.filter((l) => l.kind === "waiting-music")).toHaveLength(2);
    expect((await unwrap(mock.client.request("videos.list", { avatarId: SOFIA.avatarId }))).videos).toEqual([]);
  });

  test("a track that appears ends the wait with no further event: the launch goes on to done", async () => {
    const mock = runWorld({}, null);
    const started = await startRun(mock, LIBRARY);
    await runUntil(mock, started.launchId, "waiting", (v) => v.waitingMusic === 2);
    mock.engine.seedMusicTracks([track(1)]);
    const done = await toDone(mock, started.launchId);
    expect(done).toMatchObject({ waitingMusic: 0, avatars: [{ videos: { done: 2, total: 2 } }] });
  });

  test("only a track that is long enough, and not explicit, qualifies", async () => {
    const mock = runWorld({}, [track(1, { durationMs: 3_000 }), track(2, { explicit: true })]);
    const started = await startRun(mock, LIBRARY);
    await runUntil(mock, started.launchId, "waiting", (v) => v.waitingMusic === 2);
    mock.engine.seedMusicTracks([track(1, { durationMs: 3_000 }), track(2, { explicit: true }), track(3)]);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("the testkit's switch holds the tracks back though some are stored, and lets them go", async () => {
    const mock = runWorld();
    mock.engine.holdLaunchMusic(true);
    const started = await startRun(mock, LIBRARY);
    await runUntil(mock, started.launchId, "waiting", (v) => v.waitingMusic === 2);
    mock.engine.holdLaunchMusic(false);
    expect((await toDone(mock, started.launchId)).avatars[0]?.videos).toEqual({ done: 2, total: 2 });
  });

  test("an own track the owner flagged for the autopilot qualifies, titled by its file name without the extension", async () => {
    const mock = runWorld({}, null);
    mock.engine.seedOwnMedia([{ kind: "audio", name: "summer-loop.m4a", bytes: 900_000, facts: { durationMs: 42_000 } }]);
    const started = await startRun(mock, LIBRARY);
    await runUntil(mock, started.launchId, "waiting", (v) => v.waitingMusic === 2);
    const media = (await unwrap(mock.client.request("media.list", {}))).media;
    await unwrap(mock.client.request("media.setForAutopilot", { mediaId: media[0]?.mediaId ?? "", on: true }));
    await toDone(mock, started.launchId);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.videos.map((v) => v.track)).toEqual([
      { source: "own", title: "summer-loop", artist: null },
      { source: "own", title: "summer-loop", artist: null },
    ]);
  });

  test("a stop while videos wait for music drops them «launch-stopped»", async () => {
    const mock = runWorld({}, null);
    const started = await startRun(mock, LIBRARY);
    await runUntil(mock, started.launchId, "waiting", (v) => v.waitingMusic === 2);
    const stopped = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopped).toMatchObject({ status: "stopped", waitingMusic: 0, avatars: [{ dropped: { count: 2, reason: "launch-stopped" } }] });
    // The photos the waiting videos held are free again.
    expect((await unwrap(mock.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === SOFIA.avatarId)?.eligibleUnusedCount).toBe(12);
  });
});

describe("the waiting reasons of an avatar", () => {
  test("avatar-busy: another job of the owner's holds the avatar; the row waits, the wait is logged once, nothing is bought, and the launch goes on when the job ends", async () => {
    const mock = runWorld();
    mock.engine.setAvatarBusy(MIA.avatarId, true);
    const started = await startRun(mock);
    const waiting = await runUntil(mock, started.launchId, "avatar-busy", (v) => v.avatars[0]?.waiting?.reason === "avatar-busy");
    expect(waiting.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "avatar-busy" } });
    tick(mock, 10);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.log.filter((l) => l.kind === "avatar-busy")).toHaveLength(1);
    expect(got.launch).toMatchObject({ spentMicros: 0, paidHold: null, status: "running" });
    mock.engine.setAvatarBusy(MIA.avatarId, false);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("open-set: the owner opened a scene set of their own for the avatar after the plan; the compose waits for it to be finished or discarded", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    mock.engine.seedSceneSet({ avatarId: MIA.avatarId, sceneSetId: "set-owner-0001", count: 3 });
    const waiting = await runUntil(mock, started.launchId, "open-set", (v) => v.avatars[0]?.waiting?.reason === "open-set");
    expect(waiting.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "open-set" } });
    expect(waiting.spentMicros).toBe(0);
    mock.engine.markSceneSetUsed("set-owner-0001");
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("library-unknown: the library cannot say which photos are free; a free-path avatar's row waits and nothing is picked or dropped; the paid avatar keeps its phase and only the log says it", async () => {
    const mock = runWorld();
    mock.engine.loseLaunchLibrary(true);
    const started = await startRun(mock, { avatarIds: [SOFIA.avatarId, MIA.avatarId], library: true, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 });
    const waiting = await runUntil(mock, started.launchId, "library-unknown", (v) => v.avatars[0]?.waiting?.reason === "library-unknown");
    expect(waiting.avatars[0]).toMatchObject({ avatarId: SOFIA.avatarId, phase: "waiting", waiting: { reason: "library-unknown" }, videos: { done: 0, total: 2 } });
    // Mia generates: her row is the paid path's, it keeps its phase.
    const mia = waiting.avatars[1];
    expect(mia?.waiting).toBeNull();
    expect(mia?.phase).not.toBe("waiting");
    tick(mock, 10);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.log.filter((l) => l.kind === "library-unknown")).toHaveLength(2);
    expect(got.videos.filter((v) => v.state === "dropped")).toEqual([]);
    mock.engine.loseLaunchLibrary(false);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars.map((a) => [a.phase, a.videos.done])).toEqual([
      ["done", 2],
      ["done", 2],
    ]);
  });

  test("paid-hold: an avatar whose paid work is held waits as «paid-hold» (and WaitingReason has no other reasons than the four the mock reaches)", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock);
    const held = await runUntil(mock, started.launchId, "paid-hold", (v) => v.avatars[0]?.waiting?.reason === "paid-hold");
    expect(held.avatars[0]?.phase).toBe("waiting");
    expect(WaitingReason.options).toEqual(["avatar-busy", "open-set", "paid-hold", "library-unknown"]);
  });
});

describe("the ledger and the key at «Продолжить»", () => {
  test("a ledger that cannot be read closes «Продолжить» as «ledger»", async () => {
    const mock = runWorld({ money: { unavailable: { cause: "LEDGER_UNREADABLE", detail: "the ledger cannot be read" } } });
    mock.engine.seedLaunch({
      createdAt: "2026-10-08T14:00:00.000Z",
      status: "paused",
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 2 },
      acceptedMicros: 1_000_000,
      plannedWorstMicros: 1_000_000,
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "waiting-music" }],
    });
    const active = (await unwrap(mock.client.request("engine.snapshot", {}))).autopilot;
    expect(active?.resumeBlockedBy).toBe("ledger");
    expect(LaunchView.safeParse(active).success).toBe(true);
  });

  test("a launch with no paid work (W′ = 0) needs neither the ledger nor the key to continue", async () => {
    const mock = runWorld({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    const started = await startRun(mock, LIBRARY);
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    mock.engine.requireReconcile(["open-reserves"]);
    expect((await viewOf(mock, started.launchId)).resumeBlockedBy).toBeNull();
    expect((await resumeRun(mock, started.launchId)).status).toBe("running");
    expect(paused.plannedWorstMicros).toBe(0);
  });

  test("a reserve of THIS session left open does not close «Продолжить» (only a previous process's does): the launch's admission is Budget.blocked(), not the settings screen's flag", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("network");
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "the first drop", (v) => v.paidHold?.reason === "network");
    // The settings screen asks for a reconcile (an open reserve of this session) ...
    const money = (await unwrap(mock.client.request("engine.snapshot", {}))).money;
    expect(money.ledger === "open" && money.reconcileNeeded).toBe(true);
    // ... and the launch is admitted all the same: a paused launch is not blocked by it.
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    expect(paused.resumeBlockedBy).toBeNull();
    expect(await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: paused.remainingMicros - 1 }))).toMatchObject({ code: "PRICE_CHANGED" });
  });
});
