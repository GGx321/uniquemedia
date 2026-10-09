import { describe, expect, test } from "bun:test";
import { errorOf, resumeRun, runUntil, runWorld, SOFIA, startRun, tick, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";

const SOFIA_ID = SOFIA.avatarId;

// Stage 4, S4.8: a launch the mock runs, across the end of its process (plan §3.8). An automatic restart (`restart()`, the engine's after a crash) and the owner's quit
// (`quitLaunch()`) both read a running launch as PAUSED, with the cause; the requests that were in flight died with the process and their reserves stay open, so the next process asks
// for a reconcile before «Продолжить» (`reconcile-required`), and the figure keeps counting them at their worst case until it has run. H1: the window is told of the reconcile without asking.

/** A launch with its first batch of photos in flight. */
async function mid(mock: Mock) {
  const started = await startRun(mock);
  const flying = await runUntil(mock, started.launchId, "requests in flight", (v) => v.avatars[0]?.phase === "drawing" && v.inFlight.requests > 0);
  return { started, flying };
}

describe("an automatic restart", () => {
  test("reads the running launch as paused by the restart; its requests in flight are now unsettled reserves, inside what was spent; «Продолжить» asks for a reconcile first", async () => {
    const mock = runWorld();
    const { started, flying } = await mid(mock);
    mock.engine.restart();
    const paused = await viewOf(mock, started.launchId);
    expect(paused).toMatchObject({ status: "paused", paused: { cause: "engine-restart" }, inFlight: { requests: 0, openMicros: 0 }, resumeBlockedBy: "reconcile-required" });
    expect(paused.unsettled).toEqual({ requests: flying.inFlight.requests, openMicros: flying.inFlight.openMicros });
    expect(paused.spentMicros).toBe(flying.spentMicros);
    expect(paused.logTail.at(-1)).toMatchObject({ kind: "app-restarted", cause: "engine-restart", requests: flying.inFlight.requests });
    expect(mock.scheduler.pending).toBe(0);
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: paused.remainingMicros }))).code).toBe("RECONCILE_REQUIRED");
  });

  test("the reconcile closes the reserves at their worst case, tells the window without a read (H1), opens «Продолжить», and the launch then runs to done", async () => {
    const mock = runWorld();
    const { started } = await mid(mock);
    mock.engine.restart();
    const paused = await viewOf(mock, started.launchId);
    const before = mock.events.filter((e) => e.type === "autopilot.changed").length;
    await unwrap(mock.client.request("money.reconcile", {}));
    const told = mock.events.filter((e) => e.type === "autopilot.changed").slice(before);
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)?.payload).toMatchObject({ launch: { status: "paused", resumeBlockedBy: null, unsettled: { requests: 0, openMicros: 0 } } });
    const reconciled = await viewOf(mock, started.launchId);
    expect(reconciled.spentMicros).toBe(paused.spentMicros);
    expect(reconciled.remainingMicros).toBe(paused.remainingMicros);
    // R is a bound: one micro-dollar less is refused and the launch stays paused.
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: reconciled.remainingMicros - 1 }))).code).toBe("PRICE_CHANGED");
    expect((await viewOf(mock, started.launchId)).status).toBe("paused");
    await resumeRun(mock, started.launchId);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ phase: "done", photos: { done: 10, total: 10 }, videos: { done: 4, total: 4 } });
    expect(done.spentMicros).toBeLessThanOrEqual(done.plannedWorstMicros);
  });

  test("nothing is bought, rendered or drawn between the restart and «Продолжить»", async () => {
    const mock = runWorld();
    const { started } = await mid(mock);
    mock.engine.restart();
    const paused = await viewOf(mock, started.launchId);
    tick(mock, 30);
    const later = await viewOf(mock, started.launchId);
    expect(later.spentMicros).toBe(paused.spentMicros);
    expect(later.avatars).toEqual(paused.avatars);
  });

  test("a restart with nothing in flight (the launch waits for its review) leaves no reserve to settle: «Продолжить» is open at once, and the review is still the owner's", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: true });
    await runUntil(mock, started.launchId, "awaiting-review", (v) => v.avatars.some((a) => a.phase === "awaiting-review"));
    mock.engine.restart();
    const paused = await viewOf(mock, started.launchId);
    expect(paused).toMatchObject({ status: "paused", paused: { cause: "engine-restart" }, resumeBlockedBy: null, unsettled: { requests: 0, openMicros: 0 } });
    const resumed = await resumeRun(mock, started.launchId);
    tick(mock, 20);
    expect(resumed.avatars[0]?.phase).toBe("awaiting-review");
    expect((await viewOf(mock, started.launchId)).avatars[0]?.phase).toBe("awaiting-review");
  });

  test("a render in progress dies with the process: the video goes back to waiting for its render and is made again after «Продолжить»", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { avatarIds: [SOFIA_ID], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 });
    await runUntil(mock, started.launchId, "a video rendering", (v) => v.avatars[0]?.montage.done === 2 && v.avatars[0].videos.done === 0);
    mock.engine.restart();
    const paused = await viewOf(mock, started.launchId);
    expect(paused.avatars[0]).toMatchObject({ videos: { done: 0, total: 2 }, montage: { done: 0, total: 2 } });
    await resumeRun(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).avatars[0]?.videos).toEqual({ done: 2, total: 2 });
    expect((await unwrap(mock.client.request("videos.list", { avatarId: SOFIA_ID }))).videos).toHaveLength(2);
  });

  test("a stop that was under way when the process ended is finished by the restart: the launch is stopped, not paused", async () => {
    const mock = runWorld();
    const { started } = await mid(mock);
    const stopping = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopping.status).toBe("stopping");
    mock.engine.restart();
    expect((await viewOf(mock, started.launchId)).status).toBe("stopped");
  });

  test("a pause that was under way becomes the restart's pause", async () => {
    const mock = runWorld();
    const { started } = await mid(mock);
    expect((await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch.status).toBe("pausing");
    mock.engine.restart();
    expect(await viewOf(mock, started.launchId)).toMatchObject({ status: "paused", paused: { cause: "engine-restart" } });
  });

  test("a launch that has ended is not touched by a restart", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const done = await toDone(mock, started.launchId);
    mock.engine.restart();
    expect(await viewOf(mock, started.launchId)).toEqual(done);
  });
});

describe("the owner quits the app", () => {
  test("persists the launch as paused by the quit, with «host-quit» in the log; the requests in flight left their reserves open, so a reconcile comes first, as after a restart", async () => {
    const mock = runWorld();
    const { started, flying } = await mid(mock);
    mock.engine.quitLaunch();
    const paused = await viewOf(mock, started.launchId);
    expect(paused).toMatchObject({ status: "paused", paused: { cause: "quit" }, resumeBlockedBy: "reconcile-required", inFlight: { requests: 0, openMicros: 0 } });
    expect(paused.unsettled?.requests).toBe(flying.inFlight.requests);
    // A graceful quit writes the pause itself, so the next process finds nothing to add (only a crash is announced by «app-restarted»).
    expect(paused.logTail.at(-1)).toMatchObject({ kind: "host-quit", requests: flying.inFlight.requests });
    expect(paused.logTail.map((l) => l.kind)).not.toContain("app-restarted");
    await unwrap(mock.client.request("money.reconcile", {}));
    await resumeRun(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("a quit with nothing in flight needs no reconcile", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    mock.engine.quitLaunch();
    expect(await viewOf(mock, started.launchId)).toMatchObject({ status: "paused", paused: { cause: "quit" }, resumeBlockedBy: null });
    expect((await resumeRun(mock, started.launchId)).status).toBe("running");
  });
});

describe("the ledger asks for a reconcile (requireReconcile)", () => {
  test("a paused launch is closed as «reconcile-required» and holds unsettled reserves only if requests were out", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    mock.engine.requireReconcile(["torn-ledger-line"]);
    expect(await viewOf(mock, started.launchId)).toMatchObject({ resumeBlockedBy: "reconcile-required", unsettled: { requests: 0, openMicros: 0 } });
    await unwrap(mock.client.request("money.reconcile", {}));
    expect((await viewOf(mock, started.launchId)).resumeBlockedBy).toBeNull();
  });

  test("a launch that RUNS and meets the ledger's demand mid-run holds as a network hold with no retry (the plan's exit for «RECONCILE_REQUIRED»), counted as a drop", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    mock.engine.requireReconcile(["open-reserves"]);
    const held = await runUntil(mock, started.launchId, "the hold", (v) => v.paidHold !== null);
    expect(held.paidHold).toMatchObject({ reason: "network", detail: { drops: 1, nextAt: null } });
    await unwrap(mock.client.request("money.reconcile", {}));
    await resumeRun(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });
});
