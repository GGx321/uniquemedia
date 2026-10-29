import { describe, expect, test } from "bun:test";
import { errorOf, resumeRun, runUntil, runWorld, startRun, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";


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

});

