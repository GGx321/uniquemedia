import { describe, expect, test } from "bun:test";
import { LaunchView, type LaunchDraftInput } from "../../shared/engine";
import { errorOf, resumeRun, runUntil, runWorld, SOFIA, startRun, toDone, unwrap, viewOf } from "./mockLaunchRun.testkit";

// Stage 4, S4.6r (plan §4.6, §32): the mock mirrors the engine's three mid-launch behaviours: a render that fails gets ONE free retry and then the video is dropped; an export folder that
// vanishes while a render runs is a hold on the folder, not a failed render; a paid job that ends in a way the table has no row for holds the launch as `internal { job-failed }` and
// «Продолжить» runs it again.

/** Two slides videos from the library of Sofia (12 free photos): no paid work at all. */
const LIBRARY: Partial<LaunchDraftInput> = { avatarIds: [SOFIA.avatarId], library: true, generate: false, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 };
const ONE_VIDEO: Partial<LaunchDraftInput> = { ...LIBRARY, videosPerAvatar: 1 };

async function logKinds(mock: ReturnType<typeof runWorld>, launchId: string): Promise<string[]> {
  return (await unwrap(mock.client.request("autopilot.get", { launchId }))).log.map((l) => l.kind);
}

describe("a render that fails gets one free retry", () => {
  test("one failure is retried: one retry line, no drop, and every video finishes", async () => {
    const mock = runWorld();
    mock.engine.failLaunchRender(1);
    const started = await startRun(mock, LIBRARY);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 }, dropped: null });
    const kinds = await logKinds(mock, started.launchId);
    expect(kinds.filter((k) => k === "render-retry")).toHaveLength(1);
    expect(kinds).not.toContain("render-dropped");
  });

  test("a second failure of the same video drops it as render-failed: one retry line, one drop line, the launch still ends", async () => {
    const mock = runWorld();
    mock.engine.failLaunchRender(2);
    const started = await startRun(mock, ONE_VIDEO);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ videos: { done: 0, total: 0 }, dropped: { count: 1, reason: "render-failed" } });
    const listed = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(listed.videos.map((v) => [v.state, v.dropReason])).toEqual([["dropped", "render-failed"]]);
    expect(listed.log.filter((l) => l.kind === "render-retry")).toHaveLength(1);
    expect(listed.log.filter((l) => l.kind === "render-dropped")).toHaveLength(1);
    expect(LaunchView.safeParse(done).success).toBe(true);
  });

  test("the failures are counted per video: two videos that fail once each both finish", async () => {
    const mock = runWorld();
    mock.engine.failLaunchRender(2);
    const started = await startRun(mock, LIBRARY);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 }, dropped: null });
    expect((await logKinds(mock, started.launchId)).filter((k) => k === "render-retry")).toHaveLength(2);
  });
});

describe("an export folder that vanishes mid-render", () => {
  test("holds on the folder without a retry or a drop, and the video renders again when the folder is back", async () => {
    const mock = runWorld();
    const started = await startRun(mock, LIBRARY);
    const rendering = await runUntil(mock, started.launchId, "a render under way", (v) => v.avatars[0]?.montage.done !== undefined && (v.avatars[0]?.montage.done ?? 0) > 0);
    expect(rendering.freeHold).toBeNull();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    const held = await runUntil(mock, started.launchId, "the export hold", (v) => v.freeHold !== null);
    expect(held).toMatchObject({ status: "running", freeHold: { reason: "export", detail: { exportReason: "missing" } } });
    expect(held.avatars[0]?.dropped).toBeNull();
    const kinds = await logKinds(mock, started.launchId);
    expect(kinds).not.toContain("render-retry");
    expect(kinds).not.toContain("render-dropped");
    mock.engine.setExportDisk({ status: "ok" });
    const done = await toDone(mock, started.launchId);
    expect(done.freeHold).toBeNull();
    expect(done.avatars[0]).toMatchObject({ videos: { done: 2, total: 2 }, dropped: null });
  });

  test("a loss of the folder does not use the retry a failed render has: the failure afterwards is still retried once", async () => {
    const mock = runWorld();
    const started = await startRun(mock, ONE_VIDEO);
    await runUntil(mock, started.launchId, "a render under way", (v) => (v.avatars[0]?.montage.done ?? 0) > 0);
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await runUntil(mock, started.launchId, "the export hold", (v) => v.freeHold !== null);
    mock.engine.setExportDisk({ status: "ok" });
    mock.engine.failLaunchRender(1);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ videos: { done: 1, total: 1 }, dropped: null });
    expect((await logKinds(mock, started.launchId)).filter((k) => k === "render-retry")).toHaveLength(1);
  });
});

describe("a paid job that ends in a way the table has no row for (internal, job-failed)", () => {
  test("holds as «internal» with the job's words, «Продолжить» is open, and it runs the job again to the end", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("job-failed");
    const started = await startRun(mock);
    const held = await runUntil(mock, started.launchId, "the internal hold", (v) => v.paidHold?.reason === "internal");
    expect(held).toMatchObject({ status: "running", resumeBlockedBy: null, paidHold: { reason: "internal", detail: { kind: "job-failed" } } });
    const words = held.paidHold?.reason === "internal" ? (held.paidHold.detail.message ?? "") : "";
    expect(words).toContain("INTERNAL: the master photo could not be prepared as the face reference");
    expect(held.logTail.at(-1)).toMatchObject({ kind: "hold-internal", holdKind: "job-failed", detail: words });
    expect(held.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    const resumed = await resumeRun(mock, started.launchId);
    expect(resumed).toMatchObject({ status: "running", paidHold: null });
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]).toMatchObject({ phase: "done" });
    expect(done.spentMicros).toBeLessThanOrEqual(done.plannedWorstMicros);
  });

  test("the allocation check's internal hold still has no exit but «Стоп»", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("internal");
    const started = await startRun(mock);
    const held = await runUntil(mock, started.launchId, "the internal hold", (v) => v.paidHold?.reason === "internal");
    expect(held.resumeBlockedBy).toBe("internal");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("VALIDATION");
    expect((await viewOf(mock, started.launchId)).paidHold).toMatchObject({ reason: "internal", detail: { kind: "allocation-exceeded" } });
  });
});

describe("the job-failed fault waits for a draw step without blocking or leaking (S4.6r fix round 1)", () => {
  test("a fault armed behind it is met by the compose that cannot meet it, and the job-failed fault is met by the draw that follows", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("job-failed");
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "the credits hold at the compose", (v) => v.paidHold?.reason === "credits");
    await resumeRun(mock, started.launchId);
    const held = await runUntil(mock, started.launchId, "the failed job's hold at the draw", (v) => v.paidHold?.reason === "internal");
    expect(held.paidHold).toMatchObject({ detail: { kind: "job-failed" } });
  });

  test("a launch with no draw step does not leave the fault behind for the next launch", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("job-failed");
    const library = await startRun(mock, LIBRARY);
    await toDone(mock, library.launchId);
    const next = await startRun(mock);
    const done = await toDone(mock, next.launchId);
    expect(done.status).toBe("done");
    expect((await unwrap(mock.client.request("autopilot.get", { launchId: next.launchId }))).log.map((l) => l.kind)).not.toContain("hold-internal");
  });
});
