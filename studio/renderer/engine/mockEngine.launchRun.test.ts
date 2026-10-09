import { describe, expect, test } from "bun:test";
import { LaunchView } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { draftOf, IMAGE, MIA, resumeRun, runUntil, runWorld, SOFIA, startRun, tick, toDone, unwrap, viewOf } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: the mock RUNS a launch on its scheduler. These tests move its clock one task at a time (`ManualScheduler`) and read what the window reads: the view, the log, the
// results, the library. The holds and the waiting reasons are in mockEngine.launchRun.holds.test.ts, restart and reconcile in mockEngine.launchRun.restart.test.ts.

describe("a launch that runs", () => {
  test("starts as the engine's does: every avatar planned, nothing spent, nothing in flight, the log at its first line", async () => {
    const mock = runWorld();
    const launch = await startRun(mock);
    expect(launch).toMatchObject({ status: "running", paused: null, paidHold: null, freeHold: null, spentMicros: 0, inFlight: { requests: 0, openMicros: 0 }, unsettled: { requests: 0, openMicros: 0 }, waitingMusic: 0, resumeBlockedBy: null });
    expect(launch.avatars.map((a) => a.phase)).toEqual(["planned"]);
    expect(launch.logTail.map((l) => l.kind)).toEqual(["start"]);
    expect(launch.remainingMicros).toBe(launch.plannedWorstMicros);
  });

  test("with the review off it composes, draws, renders and ends done; the videos are real records of the library and the spend is inside the planned worst case", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const phases = new Set<string>();
    let view = started;
    for (let i = 0; i < 600 && view.status !== "done"; i++) {
      tick(mock);
      view = await viewOf(mock, started.launchId);
      for (const a of view.avatars) phases.add(a.phase);
    }
    expect(view.status).toBe("done");
    expect([...phases]).toEqual(expect.arrayContaining(["composing", "drawing", "montage", "done"]));
    expect(view.endedAt).not.toBeNull();
    expect(view.spentMicros).toBeGreaterThan(0);
    expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);
    expect(view.inFlight).toEqual({ requests: 0, openMicros: 0 });
    expect(view.avatars[0]).toMatchObject({ phase: "done", photos: { done: 10, total: 10 }, videos: { done: 4, total: 4 }, waitingMusic: 0 });
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.videos.filter((v) => v.state === "done")).toHaveLength(4);
    expect(got.videos.some((v) => v.removed === true)).toBe(false);
    expect(got.log.at(-1)).toMatchObject({ kind: "done", videosDone: 4, videosPlanned: 4 });
    const listed = (await unwrap(mock.client.request("videos.list", { avatarId: MIA.avatarId }))).videos;
    expect(listed).toHaveLength(4);
    expect(listed.every((v) => v.origin === "autopilot" && v.launchId === started.launchId)).toBe(true);
    expect((await unwrap(mock.client.request("autopilot.list", {}))).launches[0]).toMatchObject({ status: "done", videosDone: 4, videosPlanned: 4 });
  });

  test("the money it books is the mock's ledger: the month's spend moves, and nothing is left open at the end", async () => {
    const mock = runWorld();
    const before = (await unwrap(mock.client.request("engine.snapshot", {}))).money;
    const started = await startRun(mock);
    const done = await toDone(mock, started.launchId);
    const after = (await unwrap(mock.client.request("engine.snapshot", {}))).money;
    if (before.ledger !== "open" || after.ledger !== "open") throw new Error("the ledger is open in this world");
    expect(after.spentMicros - before.spentMicros).toBe(done.spentMicros);
    expect(after.unsettledCount).toBe(0);
  });

  test("a library-only launch spends nothing and needs no key", async () => {
    const mock = runWorld({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    const started = await startRun(mock, { avatarIds: [SOFIA.avatarId], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 });
    expect(started.plannedWorstMicros).toBe(0);
    const done = await toDone(mock, started.launchId);
    expect(done).toMatchObject({ spentMicros: 0, plannedWorstMicros: 0 });
    expect(done.avatars[0]).toMatchObject({ phase: "done", photos: { done: 0, total: 0 }, videos: { done: 2, total: 2 } });
    expect((await unwrap(mock.client.request("videos.list", { avatarId: SOFIA.avatarId }))).videos).toHaveLength(2);
  });

  test("the library photos a library video takes are the free ones of the avatar, and the generated ones are new photos", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { library: true, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 });
    // 6 free photos fill one slides video; the second is generated (5 new photos).
    expect(started.plan).toMatchObject({ videos: 2, fromLibrary: 5, toGenerate: 5 });
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ photos: { done: 5, total: 5 }, videos: { done: 2, total: 2 } });
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos;
    expect(photos).toHaveLength(11);
    expect(photos.filter((p) => p.used)).toHaveLength(10);
  });

  test("ticks stop once nothing can move: a finished launch leaves nothing on the clock", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    expect(mock.scheduler.pending).toBe(0);
  });

  test("a second launch cannot start while one is unfinished, and can once it is done", async () => {
    const mock = runWorld();
    const first = await startRun(mock);
    const draft = draftOf();
    const preview = (await unwrap(mock.client.request("autopilot.estimate", { draft }))).preview;
    const again = await mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros });
    expect(again.ok).toBe(false);
    await toDone(mock, first.launchId);
    expect((await startRun(mock, { avatarIds: [SOFIA.avatarId] })).launchId).not.toBe(first.launchId);
  });

  test("every view along the way meets the contract (the engine's refines)", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { library: true, avatarIds: [MIA.avatarId, SOFIA.avatarId], sceneReview: false });
    let view = started;
    for (let i = 0; i < 800 && view.status !== "done"; i++) {
      tick(mock);
      view = await viewOf(mock, started.launchId);
      expect(LaunchView.safeParse(view).success).toBe(true);
    }
    expect(view.status).toBe("done");
  });
});

describe("the dev build's mock", () => {
  test("the demo preset (its avatars, photos and tracks) runs a launch to done on the manual clock, as the real clock does in the browser", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ preset: "demo", scheduler });
    const client = mockEngineClient(engine);
    const avatars = (await unwrap(client.request("avatars.list", {}))).avatars.filter((a) => a.status === "active");
    expect(avatars.length).toBeGreaterThan(1);
    const draft = draftOf({ avatarIds: avatars.slice(0, 2).map((a) => a.avatarId), videosPerAvatar: 3, library: true, mix: { single: 70, collage: 20, slides: 10 } });
    const preview = (await unwrap(client.request("autopilot.estimate", { draft }))).preview;
    const launch = (await unwrap(client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros }))).launch;
    let view = launch;
    for (let i = 0; i < 1_500 && view.status !== "done"; i++) {
      if (!scheduler.next()) break;
      view = (await unwrap(client.request("autopilot.get", { launchId: launch.launchId }))).launch;
    }
    expect(view).toMatchObject({ status: "done", waitingMusic: 0 });
    expect(view.avatars.map((a) => a.phase)).toEqual(["done", "done"]);
    expect(view.avatars.map((a) => a.videos.done)).toEqual([3, 3]);
  });
});

describe("the scene review", () => {
  test("with the review on, an avatar that generates composes and then WAITS for the owner: nothing is drawn, the set is named with its revision", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    expect(waiting.avatars[0]).toMatchObject({ phase: "awaiting-review", setRevision: 1, scenes: 10, scenesWithoutText: 0, continuePhotos: 10, photos: { done: 0, total: 10 } });
    expect(waiting.avatars[0]?.sceneSetId).not.toBeNull();
    const spent = waiting.spentMicros;
    tick(mock, 20);
    const later = await viewOf(mock, started.launchId);
    expect(later.avatars[0]?.phase).toBe("awaiting-review");
    expect(later.spentMicros).toBe(spent);
    expect(later.inFlight.requests).toBe(0);
  });

  test("«Продолжить запуск» draws, and the launch goes on to done", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    const row = waiting.avatars[0];
    if (row?.sceneSetId == null || row.setRevision == null) throw new Error("expected a set to review");
    const answer = await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
    expect(answer.draw).toBe("started");
    expect(answer.launch.avatars[0]?.phase).toBe("drawing");
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ phase: "done", videos: { done: 4, total: 4 } });
    expect(done.logTail.map((l) => l.kind)).toContain("done");
  });

  test("during a pause the approval is only recorded; «Продолжить» draws", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    const row = waiting.avatars[0];
    if (row?.sceneSetId == null || row.setRevision == null) throw new Error("expected a set to review");
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    expect(paused.status).toBe("paused");
    const answer = await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
    expect(answer.draw).toBe("waits-for-resume");
    expect(answer.launch.avatars[0]?.phase).toBe("approved-waiting");
    tick(mock, 20);
    expect((await viewOf(mock, started.launchId)).avatars[0]?.phase).toBe("approved-waiting");
    // The answer to the click shows the rows as they were, as the engine's does; the first pass after it puts them right.
    const resumed = await resumeRun(mock, started.launchId);
    expect(resumed).toMatchObject({ status: "running", avatars: [{ phase: "approved-waiting" }] });
    tick(mock);
    expect((await viewOf(mock, started.launchId)).avatars[0]?.phase).toBe("drawing");
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("several avatars each wait for their own review, and each draws once its own is continued", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { avatarIds: [MIA.avatarId, SOFIA.avatarId], library: false, videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 }, sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "both awaiting review", (v) => v.avatars.every((a) => a.phase === "awaiting-review"));
    for (const row of waiting.avatars) {
      if (row.sceneSetId === null || row.setRevision === null) throw new Error("expected a set to review");
      await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
    }
    expect((await toDone(mock, started.launchId)).avatars.map((a) => a.phase)).toEqual(["done", "done"]);
  });
});

describe("pause, resume and stop on a running launch", () => {
  test("a pause with nothing in flight is paused at once; «Продолжить · до $R» takes the sum the view stated and the launch runs to done", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    expect(paused).toMatchObject({ status: "paused", paused: { cause: "owner" } });
    tick(mock, 10);
    expect((await viewOf(mock, started.launchId)).avatars[0]?.phase).toBe("planned");
    const short = await mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: paused.remainingMicros - 1 });
    expect(short.ok).toBe(false);
    expect((await resumeRun(mock, started.launchId)).status).toBe("running");
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("a pause with requests in flight is «pausing» (they are counted), and paused once they have settled; nothing new starts meanwhile", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const flying = await runUntil(mock, started.launchId, "requests in flight", (v) => v.inFlight.requests > 0);
    const spentBefore = flying.spentMicros;
    const pausing = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    expect(pausing.status).toBe("pausing");
    expect(pausing.logTail.at(-1)).toMatchObject({ kind: "pausing", requests: flying.inFlight.requests });
    tick(mock);
    const paused = await viewOf(mock, started.launchId);
    expect(paused).toMatchObject({ status: "paused", inFlight: { requests: 0, openMicros: 0 } });
    expect(paused.spentMicros).toBeLessThanOrEqual(spentBefore);
    expect(paused.logTail.at(-1)).toMatchObject({ kind: "paused" });
    expect(mock.scheduler.pending).toBe(0);
  });

  test("a stop with nothing in flight ends the launch at once: the unfinished videos are dropped «launch-stopped», the figure is what was spent", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const stopped = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopped).toMatchObject({ status: "stopped", spentMicros: 0, inFlight: { requests: 0, openMicros: 0 } });
    expect(stopped.endedAt).not.toBeNull();
    expect(mock.scheduler.pending).toBe(0);
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.log.at(-1)).toMatchObject({ kind: "stopped", spentMicros: 0 });
  });

  test("a stop in the middle is «stopping» while requests are in flight, then stopped with them settled; the videos that were done stay", async () => {
    const mock = runWorld();
    // Sofia's library slides are finished early while Mia (and Sofia's other slides) are still drawing their photos.
    const started = await startRun(mock, { library: true, avatarIds: [SOFIA.avatarId, MIA.avatarId], mix: { single: 0, collage: 0, slides: 100 } });
    await runUntil(mock, started.launchId, "a finished video and requests in flight", (v) => v.avatars.some((a) => a.videos.done > 0) && v.inFlight.requests > 0);
    const stopping = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopping.status).toBe("stopping");
    tick(mock);
    const stopped = await viewOf(mock, started.launchId);
    expect(stopped).toMatchObject({ status: "stopped", inFlight: { requests: 0, openMicros: 0 } });
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    const states = new Set(got.videos.map((v) => v.state));
    expect(states.has("done")).toBe(true);
    expect(got.videos.filter((v) => v.state === "dropped").every((v) => v.dropReason === "launch-stopped")).toBe(true);
    expect(got.videos.some((v) => v.state === "rendering")).toBe(false);
    expect(stopped.spentMicros).toBe((await unwrap(mock.client.request("autopilot.list", {}))).launches[0]?.spentMicros ?? -1);
  });

  test("a stop while the launch waits for its review ends it with nothing spent on photos", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    const waiting = await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    const stopped = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopped.status).toBe("stopped");
    expect(stopped.spentMicros).toBe(waiting.spentMicros);
    expect(stopped.avatars[0]).toMatchObject({ dropped: { count: 4, reason: "launch-stopped" } });
    expect(mock.scheduler.pending).toBe(0);
  });

  test("a stop from a pause ends it; a stopped launch cannot be paused, resumed or stopped again", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    expect((await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch.status).toBe("stopped");
    for (const type of ["autopilot.pause", "autopilot.stop"] as const) {
      expect((await mock.client.request(type, { launchId: started.launchId })).ok).toBe(false);
    }
    expect((await mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: 10_000_000 })).ok).toBe(false);
  });

  test("pausing twice is refused; so is resuming a launch that runs with no hold", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    expect((await mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: 10_000_000 })).ok).toBe(false);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    expect((await mock.client.request("autopilot.pause", { launchId: started.launchId })).ok).toBe(false);
  });

  test("an avatar archived while the launch is paused leaves it when «Продолжить» is pressed: its unfinished videos are dropped «avatar-skipped»", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { avatarIds: [SOFIA.avatarId, MIA.avatarId], library: true });
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    await unwrap(mock.client.request("avatars.archive", { avatarId: MIA.avatarId }));
    await resumeRun(mock, started.launchId);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars.find((a) => a.avatarId === MIA.avatarId)).toMatchObject({ phase: "skipped", skipped: { reason: "archived" } });
    expect(done.avatars.find((a) => a.avatarId === SOFIA.avatarId)?.phase).toBe("done");
  });
});

describe("the image price is the mock's own", () => {
  test("the money booked per photo is the expected price, so a finished launch is below its worst case by the retries it did not need", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { videosPerAvatar: 1, mix: { single: 100, collage: 0, slides: 0 } });
    const done = await toDone(mock, started.launchId);
    expect(done.spentMicros).toBeLessThan(done.plannedWorstMicros);
    expect(done.spentMicros).toBeGreaterThanOrEqual(IMAGE - 1);
  });
});
