import { describe, expect, test } from "bun:test";
import type { LaunchView, SceneSetView } from "../../shared/engine";
import { draftOf, errorOf, MIA, runUntil, runWorld, startRun, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";

// S4.10 fix D: the mock's launch makes a real scene set, real slice runs and their job events, and refuses the owner's commands on them as the engine does (plan §4.7, A16). The
// parity stories (scenarios.autopilotRun.ts) hold the refusals line for line; these hold the rest of what the window reads.

const LAUNCH_SET = { code: "VALIDATION", sceneReason: "launch-set" } as const;

const REVIEW = { sceneReview: true } as const;

const setOf = async (mock: Mock): Promise<SceneSetView | null> => (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;

const awaiting = (v: LaunchView): boolean => v.avatars.some((a) => a.phase === "awaiting-review");

async function reviewed(mock: Mock): Promise<{ started: LaunchView; view: LaunchView; set: SceneSetView }> {
  const started = await startRun(mock, REVIEW);
  const view = await runUntil(mock, started.launchId, "the review", awaiting);
  const set = await setOf(mock);
  if (set === null) throw new Error("the launch's set is not there");
  return { started, view, set };
}

describe("the scene set of a launch that runs", () => {
  test("exists from the compose's first request, held by the launch, and is the avatar's set to read", async () => {
    const mock = runWorld();
    const started = await startRun(mock, REVIEW);
    await runUntil(mock, started.launchId, "composing", (v) => v.avatars.some((a) => a.phase === "composing"));
    expect(await setOf(mock)).toMatchObject({ launchId: started.launchId, status: "writing", write: { kind: "compose", count: 10 } });
  });

  test("while the launch composes the writer's job is live, as the engine's: the set reads writing, the avatar is claimed, and the owner's commands meet IN_FLIGHT first", async () => {
    const mock = runWorld();
    const started = await startRun(mock, REVIEW);
    await runUntil(mock, started.launchId, "composing", (v) => v.avatars.some((a) => a.phase === "composing"));
    const set = await setOf(mock);
    if (set === null) throw new Error("the launch's set is not there");
    const inFlight = [
      await errorOf(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "remove", sceneIds: [1] } })),
      await errorOf(mock.client.request("scenes.discard", { sceneSetId: set.sceneSetId })),
      await errorOf(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 3, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 })),
      await errorOf(mock.client.request("runs.start", { avatarId: MIA.avatarId, count: 1, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 })),
    ];
    for (const error of inFlight) expect(error.code).toBe("IN_FLIGHT");
  });

  test("the compose is announced as a scenes job: progress when it begins, done when the writer has answered, and the set reads ready again", async () => {
    const mock = runWorld();
    const { set } = await reviewed(mock);
    const kinds = mock.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "scenes" ? ["progress"] : e.type === "job.done" && e.payload.result.kind === "scenes" ? ["done"] : []));
    expect(kinds[0]).toBe("progress");
    expect(kinds.at(-1)).toBe("done");
    expect(set).toMatchObject({ status: "ready", write: null });
  });

  test("once composed it has its ten sentences and the row names it with its revision", async () => {
    const mock = runWorld();
    const { view, set } = await reviewed(mock);
    expect(set.scenes).toHaveLength(10);
    expect(set.scenes.every((s) => s.text !== null)).toBe(true);
    expect(view.avatars[0]).toMatchObject({ sceneSetId: set.sceneSetId, setRevision: set.revision });
  });

  test("refuses the owner's discard, cancel, «Дописать», own scene and «Отрисовать» as launch-set and keeps the set as it was", async () => {
    const mock = runWorld();
    const { set } = await reviewed(mock);
    const write = (target: unknown) => mock.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros: 10_000_000 } as never);
    const errors = [
      await errorOf(mock.client.request("scenes.discard", { sceneSetId: set.sceneSetId })),
      await errorOf(mock.client.request("scenes.cancel", { sceneSetId: set.sceneSetId })),
      await errorOf(write({ kind: "unwritten" })),
      await errorOf(write({ kind: "idea", idea: "coffee on a balcony", count: 1, shot: null })),
      await errorOf(mock.client.request("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: 10_000_000 })),
    ];
    for (const error of errors) expect(error).toMatchObject(LAUNCH_SET);
    expect(await setOf(mock)).toEqual(set);
  });

  test("lets the owner edit the scenes while the launch waits for the review, and the launch's row follows the revision", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    const edited = await unwrap(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "text", sceneId: 1, text: "Reading by the window in the morning light." } }));
    expect(edited).toMatchObject({ sceneSet: { revision: set.revision + 1 } });
    expect((await viewOf(mock, started.launchId)).avatars[0]).toMatchObject({ setRevision: set.revision + 1 });
  });

  test("refuses a «Продолжить запуск» that saw a revision the owner's edit has moved past", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    await unwrap(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "text", sceneId: 1, text: "Reading by the window in the morning light." } }));
    const stale = await errorOf(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: MIA.avatarId, sceneSetId: set.sceneSetId, revision: set.revision }));
    expect(stale.code).toBe("SCENES_CHANGED");
  });

  test("is frozen when the launch starts to draw: the owner's edit and rewrite are refused as launch-set", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: MIA.avatarId, sceneSetId: set.sceneSetId, revision: set.revision }));
    const edit = await errorOf(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "remove", sceneIds: [1] } }));
    const rewrite = await errorOf(mock.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 10_000_000 }));
    expect(edit).toMatchObject(LAUNCH_SET);
    expect(rewrite).toMatchObject(LAUNCH_SET);
  });

  test("is frozen by an approval given in a pause too: the engine writes the draw before it asks whether it may pay", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    await unwrap(mock.client.request("autopilot.continueAfterReview", { launchId: started.launchId, avatarId: MIA.avatarId, sceneSetId: set.sceneSetId, revision: set.revision }));
    const edit = await errorOf(mock.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op: { op: "remove", sceneIds: [1] } }));
    const rewrite = await errorOf(mock.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [1], redraw: false }, acceptedWorstMicros: 10_000_000 }));
    expect(edit).toMatchObject(LAUNCH_SET);
    expect(rewrite).toMatchObject(LAUNCH_SET);
  });

  test("is the owner's again after «Стоп»: no launch on it, and the owner may discard it", async () => {
    const mock = runWorld();
    const { started, set } = await reviewed(mock);
    await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }));
    await runUntil(mock, started.launchId, "stopped", (v) => v.status === "stopped");
    const shown = await setOf(mock);
    expect(shown).toMatchObject({ sceneSetId: set.sceneSetId });
    expect(shown?.launchId).toBeUndefined();
    expect((await mock.client.request("scenes.discard", { sceneSetId: set.sceneSetId })).ok).toBe(true);
  });

  test("tells the windows when the launch lets go of it: a scenes.changed without the launch", async () => {
    const mock = runWorld();
    const { started } = await reviewed(mock);
    mock.events.length = 0;
    await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }));
    await runUntil(mock, started.launchId, "stopped", (v) => v.status === "stopped");
    const last = mock.events.filter((e) => e.type === "scenes.changed").at(-1);
    expect(last).toMatchObject({ payload: { change: "upserted" } });
    expect(last?.type === "scenes.changed" && last.payload.change === "upserted" ? last.payload.sceneSet.launchId : "x").toBeUndefined();
  });

  test("a launch's set seeded by a test names the launch only while the launch is unfinished", async () => {
    const mock = runWorld();
    const { launchId } = mock.engine.seedLaunch({ createdAt: "2026-10-08T14:02:00.000Z", status: "done", draft: { avatarIds: [MIA.avatarId] }, videos: [] });
    mock.engine.seedSceneSet({ avatarId: MIA.avatarId, sceneSetId: "set-seeded-0001", count: 3, written: 3, launchId });
    expect((await setOf(mock))?.launchId).toBeUndefined();
  });
});

describe("the slice runs of a launch that runs", () => {
  test("a run carries the launch's id and runs while its photos are drawn; the owner's resume and cancel of it are refused as launch-set", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0));
    const runs = (await unwrap(mock.client.request("runs.list", {}))).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ launchId: started.launchId, avatarId: MIA.avatarId, total: 10, running: true });
    const runId = runs[0]?.runId ?? "";
    expect(await errorOf(mock.client.request("runs.resume", { runId, acceptedWorstMicros: 10_000_000 }))).toMatchObject(LAUNCH_SET);
    expect(await errorOf(mock.client.request("runs.cancel", { runId }))).toMatchObject(LAUNCH_SET);
  });

  test("its job is announced as a run job: progress for every photo, then done with the photos", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs[0];
    const mine = mock.events.filter((e) => (e.type === "job.progress" && e.payload.kind === "run") || e.type === "job.done");
    const progress = mine.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "run" ? [e.payload.done] : []));
    expect(progress.at(-1)).toBe(10);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const done = mine.find((e) => e.type === "job.done" && e.payload.result.kind === "run");
    expect(done).toMatchObject({ payload: { result: { kind: "run", runId: run?.runId, avatarId: MIA.avatarId } } });
    expect(done?.type === "job.done" && done.payload.result.kind === "run" ? done.payload.result.photoIds : []).toHaveLength(10);
  });

  test("when the launch is done the run is the owner's: no launch on it, nothing left to resume, and the set is used", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await toDone(mock, started.launchId);
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs[0];
    expect(run).toMatchObject({ running: false, done: 10, open: 0 });
    expect(run?.launchId).toBeUndefined();
    const again = await errorOf(mock.client.request("runs.resume", { runId: run?.runId ?? "", acceptedWorstMicros: 10_000_000 }));
    expect(again.code).toBe("VALIDATION");
    expect(again.sceneReason).toBeUndefined();
    expect(await setOf(mock)).toMatchObject({ status: "used" });
  });

  test("the draw holds the avatar: the owner's photo run is IN_FLIGHT while a slice is drawn, and the launch does not wait for itself", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    const drawing = await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0));
    expect(drawing.avatars[0]?.waiting).toBeNull();
    const refused = await errorOf(mock.client.request("runs.start", { avatarId: MIA.avatarId, count: 1, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 }));
    expect(refused.code).toBe("IN_FLIGHT");
  });

  test("a slice taken up again names a run the mock holds: one it does not hold is a defect of the launch, never a second run under the set's id", async () => {
    const mock = runWorld();
    const { set } = await reviewed(mock);
    const start = Reflect.get(mock.engine, "startLaunchSlice") as (slice: unknown) => string;
    const slice = { launchId: "launch-00000001", avatarId: MIA.avatarId, sceneSetId: set.sceneSetId, index: 1, photos: 10, capMicros: 1, category: "home", resume: "run-nobody-0404" };
    expect(() => start.call(mock.engine, slice)).toThrow(/run-nobody-0404/);
    expect((await unwrap(mock.client.request("runs.list", {}))).runs).toHaveLength(0);
  });

  test("a pause ends the slice's job cancelled while the launch keeps the run, and «Продолжить» takes the same run up again under a new job", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { videosPerAvatar: 8, mix: { single: 0, collage: 0, slides: 100 } });
    await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0));
    const before = (await unwrap(mock.client.request("runs.list", {}))).runs;
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    await runUntil(mock, started.launchId, "paused", (v) => v.status === "paused");
    const paused = (await unwrap(mock.client.request("runs.list", {}))).runs;
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ runId: before[0]?.runId, running: false, launchId: started.launchId });
    expect(mock.events.some((e) => e.type === "job.cancelled" && e.payload.kind === "run")).toBe(true);
    await unwrap(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: (await viewOf(mock, started.launchId)).remainingMicros }));
    await runUntil(mock, started.launchId, "the draw again", (v) => v.avatars.some((a) => a.photos.done > (paused[0]?.done ?? 0)));
    const again = (await unwrap(mock.client.request("runs.list", {}))).runs;
    expect(again.map((r) => r.runId)).toEqual([before[0]?.runId, ...again.slice(1).map((r) => r.runId)]);
    expect(again.find((r) => r.runId === before[0]?.runId)).toMatchObject({ running: true });
  });

  test("a stop ends the slice and the run is the owner's: it names no launch", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done > 0));
    await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }));
    await runUntil(mock, started.launchId, "stopped", (v) => v.status === "stopped");
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs[0];
    expect(run?.running).toBe(false);
    expect(run?.launchId).toBeUndefined();
  });
});
