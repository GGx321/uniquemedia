import { describe, expect, test } from "bun:test";
import { MIA, ON_THE_WRITER, runWorld, startRun, tick, toDone, unwrap, viewOf } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: the mock RUNS a launch on its scheduler. These tests move its clock one task at a time (`ManualScheduler`) and read what the window reads: the view, the log, the
// results, the library. The holds and the waiting reasons are in mockEngine.launchRun.holds.test.ts, restart and reconcile in mockEngine.launchRun.restart.test.ts.

describe("a launch that runs", () => {

  // 5a.2 (S5.6e, m11): a launch on «Дом» is composed by the code template at once, with no request, so the writer's «composing» phase is the fixture's (`cat-llm-only-fixture`); the template's launch
  // goes from «planned» to «drawing» in one step (the next test).
  test("with the review off it composes, draws, renders and ends done; the videos are real records of the library and the spend is inside the planned worst case", async () => {
    const mock = runWorld();
    const started = await startRun(mock, ON_THE_WRITER);
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

});

