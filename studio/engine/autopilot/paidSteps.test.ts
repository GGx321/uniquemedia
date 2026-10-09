import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineFailure } from "../engineFailure";
import type { RunJobEnd } from "../runs/runJob";
import type { DrawSliceResult } from "../sceneSets/launchDraw";
import type { LaunchFile } from "./launchFile";
import { AUTOPILOT_DIR } from "./launchStore";
import { NOT_PAYABLE_DETAIL, type LaunchComposePayload, type LaunchSliceStart } from "./paidPort";
import { A, ALL, B, BIG, cleanupRigs, composes, deferred, FakePort, idle, LAUNCH, PHOTO, RUN1, RUN2, rig, SET1, SET2, T0, until, WRITER, type Rig } from "./testing/paidRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (plan §3.6, §4.3, §4.4, §18): the paid steps against a double of the engine, for the orders and races the real engine makes hard to hit: a soft stop that arrives
// while the step's own start has not returned, the slice sized only after the compose returned, the launch's own «Дописать» cap, and the holds of the paid path. The real engine,
// ledger and Budget group are in engine.autopilotPaid.test.ts. The double and the rig are in testing/paidRig.ts.

afterEach(cleanupRigs);


// ---------- the soft stop meets a start that has not returned ----------

describe("soft stop while the step's own start has not returned (plan §18)", () => {
  test("a compose still starting when «Пауза» is clicked is stopped the moment its start returns", async () => {
    const r = await rig();
    const start = deferred<{ sceneSetId: string; jobId: string | null }>();
    const stopped = deferred();
    let live = false;
    r.port.compose = async () => start.promise;
    r.port.softScenes = () => live;
    r.port.idleSet = async () => (live ? stopped.promise : undefined);
    const launch = await r.start();
    await until(() => r.port.calls.includes("composeLaunchSet"), "the compose call");
    const pausing = r.orchestrator.pause(launch.launchId);
    await until(() => r.port.calls.includes("softStopScenes"), "the first soft stop");
    expect(r.port.calls.filter((c) => c === "softStopScenes")).toHaveLength(1);
    // The start returns: the set is live now, and the very stop that found nothing before must be sent again.
    live = true;
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    start.resolve({ sceneSetId: SET1, jobId: "job-compose-0001" });
    await until(() => r.port.calls.filter((c) => c === "softStopScenes").length >= 2, "the second soft stop");
    stopped.resolve();
    const paused = await pausing;
    expect(["pausing", "paused"]).toContain(paused.status);
    await r.orchestrator.settled();
    expect(r.port.calls).not.toContain("approveLaunchSet");
    expect(r.port.calls).not.toContain("drawLaunchSlice");
  });

  test("a slice run still starting when «Пауза» is clicked is stopped the moment its start returns", async () => {
    const r = await rig();
    const startOfRun = deferred<LaunchSliceStart>();
    const ended = deferred<RunJobEnd>();
    let live = false;
    r.port.compose = composes(r.port, LAUNCH);
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
      r.port.statuses.set(RUN1, { finished: false });
      return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 };
    };
    r.port.start = async () => startOfRun.promise;
    r.port.softRun = () => live;
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("startLaunchSlice"), "the slice start");
    const pausing = r.orchestrator.pause(launch.launchId);
    await until(() => r.port.calls.includes("softStopRun"), "the first soft stop");
    live = true;
    startOfRun.resolve({ kind: "started", jobId: "job-run-0001", ended: ended.promise });
    await until(() => r.port.calls.filter((c) => c === "softStopRun").length >= 2, "the second soft stop");
    ended.resolve({ status: "cancelled" });
    await pausing;
    await r.orchestrator.settled();
    expect(r.port.calls.filter((c) => c === "drawLaunchSlice")).toHaveLength(1);
  });
});

// ---------- the slice is sized after compose() returned ----------

describe("a slice is sized only after compose() has returned (plan §19)", () => {
  test("the month room is read after the compose call returned, never inside its admission window", async () => {
    const r = await rig();
    const composeDone = deferred<{ sceneSetId: string; jobId: string | null }>();
    r.port.compose = async () => composeDone.promise;
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => ({ kind: "none-left" });
    await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("composeLaunchSet"), "the compose call");
    await idle();
    expect(r.port.calls).not.toContain("monthRoom");
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    composeDone.resolve({ sceneSetId: SET1, jobId: "job-compose-0001" });
    await until(() => r.port.calls.includes("monthRoom"), "the first sizing");
    expect(r.port.calls.indexOf("monthRoom")).toBeGreaterThan(r.port.calls.indexOf("composeLaunchSet:returned"));
  });

  test("another avatar's slice waits for a compose that is still starting before it reads the room", async () => {
    const r = await rig();
    const photoOpen = deferred();
    r.port.photoGate = photoOpen.promise;
    // The second avatar's set is already approved: it is ready to draw while the first avatar's compose starts.
    r.port.seed({ sceneSetId: SET2, runId: RUN2, avatarId: B, launchId: LAUNCH, draw: { sceneIds: ALL } });
    const composeDone = deferred<{ sceneSetId: string; jobId: string | null }>();
    r.port.compose = async () => composeDone.promise;
    r.port.approve = async (setId) => r.port.seed({ sceneSetId: setId, runId: setId === SET1 ? RUN1 : RUN2, avatarId: setId === SET1 ? A : B, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => ({ kind: "none-left" });
    await r.start({ avatarIds: [A, B], sceneReview: false });
    await until(() => r.port.calls.includes("composeLaunchSet"), "the compose call");
    // The second avatar has read the price of a photo and is about to read the room; the first avatar's compose is inside its start window.
    photoOpen.resolve();
    await idle();
    expect(r.port.calls).not.toContain("monthRoom");
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    composeDone.resolve({ sceneSetId: SET1, jobId: "job-compose-0001" });
    await until(() => r.port.calls.includes("monthRoom"), "the sizing");
    expect(r.port.calls.indexOf("monthRoom")).toBeGreaterThan(r.port.calls.indexOf("composeLaunchSet:returned"));
  });
});

// ---------- the launch's own «Дописать» ----------

describe("the launch's own «Дописать» (plan §3.6 row 2, §4.3 item 3)", () => {
  /** A set whose compose was stopped before its sentences, with the first attempt answered and settled in the ledger: planted BEFORE the start, so the first begin finds it. */
  async function stoppedSet(r: Rig, spent: number): Promise<void> {
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, written: 0 });
    await r.settle(SET1, "writer-1#1", spent);
  }

  test("its cap is the compose allocation less what the set's earlier writer scopes committed", async () => {
    const r = await rig();
    const sent: number[] = [];
    r.port.write = async (input) => {
      sent.push(input.acceptedWorstMicros);
      return { jobId: "job-write-0001" };
    };
    r.port.writeCost = () => WRITER;
    await stoppedSet(r, 11_200);
    const launch = await r.start({ sceneReview: true });
    await until(() => sent.length === 1, "the write");
    const compose = r.fileOf(launch.launchId).avatars[0]?.allocation.composeMicros ?? 0;
    expect(sent[0]).toBe(compose - 11_200);
  });

  test("an allocation that no longer covers the write holds the launch as «price» with what is needed and what is left, and sends nothing (A3)", async () => {
    const r = await rig();
    r.port.writeCost = () => 60_000;
    await stoppedSet(r, 30_000);
    const launch = await r.start({ sceneReview: true });
    await until(() => r.fileOf(launch.launchId).paidHold !== null, "the hold");
    const compose = r.fileOf(launch.launchId).avatars[0]?.allocation.composeMicros ?? 0;
    expect(r.fileOf(launch.launchId).paidHold).toMatchObject({ reason: "price", detail: { stage: "rewrite", needMicros: 60_000, leftMicros: compose - 30_000 } });
    expect(r.port.calls).not.toContain("writeLaunchScenes");
  });
});

// ---------- holds of the paid path ----------

describe("the paid path's own holds (plan §4.3 item 4, §4.4)", () => {
  /** Plants a compose that answers at once and an approval that freezes the ten scenes. */
  function approvedPath(r: Rig): void {
    r.port.compose = composes(r.port, LAUNCH);
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
  }

  const drawsEntry =
    (r: Rig, sceneIds = ALL, capMicros = PHOTO * 10) =>
    async (): Promise<DrawSliceResult> => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds, capMicros }] } });
      r.port.statuses.set(RUN1, { finished: false });
      return { kind: "drawn", created: true, runId: RUN1, sceneIds, capMicros };
    };

  test("a month with room for no photo holds the launch as «budget» for a new slice and draws nothing", async () => {
    const r = await rig();
    r.port.room = { budgetMicros: 1_000_000, committedMicros: 900_000, freeMicros: PHOTO - 1 };
    approvedPath(r);
    const launch = await r.start({ sceneReview: false });
    await until(() => r.fileOf(launch.launchId).paidHold !== null, "the hold");
    expect(r.fileOf(launch.launchId).paidHold).toMatchObject({ reason: "budget", detail: { kind: "new-slice", freeMicros: PHOTO - 1, needMicros: PHOTO } });
    expect(r.port.calls).not.toContain("drawLaunchSlice");
  });

  test("a slice sized to the room is asked for with that many photos, never more than 25", async () => {
    const r = await rig();
    r.port.room = { budgetMicros: 1_000_000_000, committedMicros: 0, freeMicros: PHOTO * 4 + 1 };
    const sizes: number[] = [];
    approvedPath(r);
    r.port.draw = async (input) => {
      sizes.push(input.size);
      return { kind: "none-left" };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => sizes.length === 1, "the draw");
    expect(sizes).toEqual([4]);
    expect(r.fileOf(launch.launchId).paidHold).toBeNull();
  });

  test("an allocation left below one photo holds the launch as «price» with the slice that shrank to nothing, and starts no run (A3)", async () => {
    const r = await rig();
    approvedPath(r);
    r.port.draw = async () => ({ kind: "no-room", leftMicros: PHOTO - 1 });
    const launch = await r.start({ sceneReview: false });
    await until(() => r.fileOf(launch.launchId).paidHold !== null, "the hold");
    expect(r.fileOf(launch.launchId).paidHold).toMatchObject({ reason: "price", detail: { stage: "slice", toPhotos: 0 } });
    expect(r.port.calls).not.toContain("startLaunchSlice");
  });

  test("a slice that shrank to its cap logs the price rise and draws what fits", async () => {
    const r = await rig();
    approvedPath(r);
    r.port.draw = drawsEntry(r, [1, 2, 3], PHOTO * 3);
    r.port.start = async () => ({ kind: "started", jobId: "job-run-0001", ended: Promise.resolve({ status: "cancelled" } as RunJobEnd) });
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("startLaunchSlice"), "the slice start");
    await r.orchestrator.settled();
    const get = await r.orchestrator.get(launch.launchId);
    expect(get.log.find((l) => l.kind === "price-shrink")).toMatchObject({ fromPhotos: 10, toPhotos: 3 });
    expect(get.log.find((l) => l.kind === "slice-start")).toMatchObject({ index: 1, photos: 3, capMicros: PHOTO * 3 });
  });

  test("an avatar another job holds waits as «avatar-busy» and is retried, never failed", async () => {
    const r = await rig();
    approvedPath(r);
    r.port.draw = drawsEntry(r);
    let attempts = 0;
    r.port.start = async () => {
      attempts += 1;
      if (attempts === 1) throw new EngineFailure({ code: "IN_FLIGHT", detail: "a photo run or another job is already changing this avatar; wait for it to finish" });
      return { kind: "started", jobId: "job-run-0001", ended: Promise.resolve({ status: "cancelled" } as RunJobEnd) };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => attempts === 1, "the first refusal");
    await until(() => r.fileOf(launch.launchId).avatars[0]?.waiting?.reason === "avatar-busy", "the busy phase");
    await until(() => attempts === 2, "the retry");
  });

  test("a set whose file is unreadable skips its avatar as set-unreadable and sends nothing", async () => {
    const r = await rig();
    r.port.unreadable = 1;
    const launch = await r.start();
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "skipped", "the skip");
    expect(r.fileOf(launch.launchId).avatars[0]?.skipped).toEqual({ reason: "set-unreadable" });
    expect(r.port.calls).not.toContain("composeLaunchSet");
    // N3: nothing is released. The skipped avatar keeps its allocation, so the allocations still add up to W′ exactly.
    const file = r.fileOf(launch.launchId);
    expect(file.avatars.reduce((sum, a) => sum + a.allocation.composeMicros + a.allocation.drawMicros, 0)).toBe(file.plannedWorstMicros);
  });
});

// ---------- release ----------

describe("«Стоп»: the sets are released, and a set that is gone does not hold the stop", () => {
  test("every set of the launch is unlinked", async () => {
    const r = await rig();
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    r.port.seed({ sceneSetId: SET2, runId: RUN2, avatarId: B, launchId: LAUNCH });
    const launch = await r.start({ avatarIds: [A, B], sceneReview: true });
    await r.orchestrator.settled();
    const stopped = await r.orchestrator.stop(launch.launchId);
    expect(stopped.status).toBe("stopped");
    expect(r.port.unlinked.sort()).toEqual([SET1, SET2].sort());
  });

  test("a failing unlink does not stop the stop", async () => {
    const r = await rig();
    r.port.unlinkError = new EngineFailure({ code: "NOT_FOUND", detail: "no scene set" });
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    const launch = await r.start({ sceneReview: true });
    await r.orchestrator.settled();
    const stopped = await r.orchestrator.stop(launch.launchId);
    expect(stopped.status).toBe("stopped");
  });
});

// ---------- fix round 1 (S4.6b1 review) ----------

describe("a busy avatar is waited for, not given up on (MEDIUM)", () => {
  const all = ALL;
  function approvedWithEntry(r: Rig, setId = SET1, runId = RUN1, avatarId = A): void {
    r.port.seed({ sceneSetId: setId, runId, avatarId, launchId: LAUNCH, draw: { sceneIds: all, slices: [{ runId, sceneIds: all, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(runId, { finished: false });
  }
  const cancelledStart = (): Promise<LaunchSliceStart> => Promise.resolve({ kind: "started", jobId: "job-run-0001", ended: Promise.resolve({ status: "cancelled" } as RunJobEnd) });

  test("more than twelve refusals of a busy avatar still end in a draw, and «avatar-busy» is logged once", async () => {
    const r = await rig();
    approvedWithEntry(r);
    let attempts = 0;
    r.port.start = async () => {
      attempts += 1;
      if (attempts <= 15) throw new EngineFailure({ code: "IN_FLIGHT", detail: "busy" });
      return cancelledStart();
    };
    const launch = await r.start({ sceneReview: true });
    await until(() => attempts === 16, "the sixteenth try", 6_000);
    await r.orchestrator.settled();
    const log = (await r.orchestrator.get(launch.launchId)).log;
    expect(log.filter((l) => l.kind === "avatar-busy")).toHaveLength(1);
    expect(r.port.calls).toContain("startLaunchSlice:returned");
  });

  test("a busy avatar does not hold the draw lane: another avatar's slice starts meanwhile", async () => {
    const r = await rig();
    approvedWithEntry(r, SET1, RUN1, A);
    approvedWithEntry(r, SET2, RUN2, B);
    const started: string[] = [];
    let freeA = false;
    r.port.start = async (runId) => {
      started.push(runId);
      if (runId === RUN1 && !freeA) throw new EngineFailure({ code: "IN_FLIGHT", detail: "busy" });
      return cancelledStart();
    };
    await r.start({ avatarIds: [A, B], sceneReview: true });
    await until(() => started.includes(RUN2), "the other avatar's slice", 3_000);
    expect(started.filter((id) => id === RUN1).length).toBeGreaterThanOrEqual(1);
    freeA = true;
    await until(() => started.filter((id) => id === RUN1).length >= 2, "the busy avatar's retry");
  });

  test("the launch's own «Дописать» under IN_FLIGHT waits and retries", async () => {
    const r = await rig();
    const sent: number[] = [];
    let tries = 0;
    r.port.writeCost = () => WRITER;
    r.port.write = async (input) => {
      tries += 1;
      if (tries === 1) throw new EngineFailure({ code: "IN_FLIGHT", detail: "busy" });
      sent.push(input.acceptedWorstMicros);
      return { jobId: "job-write-0001" };
    };
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, written: 0 });
    const launch = await r.start({ sceneReview: true });
    await until(() => sent.length === 1, "the retried write");
    expect(tries).toBe(2);
    expect(r.fileOf(launch.launchId).paidHold).toBeNull();
  });

  test("an approval refused as IN_FLIGHT (a job of the set is still ending) waits like a busy avatar", async () => {
    const r = await rig();
    let tries = 0;
    r.port.compose = composes(r.port, LAUNCH);
    r.port.approve = async () => {
      tries += 1;
      if (tries === 1) throw new EngineFailure({ code: "IN_FLIGHT", detail: "the set is being written" });
      return r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    };
    r.port.draw = async () => ({ kind: "none-left" });
    const launch = await r.start({ sceneReview: false });
    await until(() => tries === 2, "the second approval");
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the draw after it");
  });
});

describe("an unreadable-sets avatar, a skip and the view (fix round 1)", () => {
  test("a skip drops only generated videos that have no photos yet: a rendering or a library video stays", async () => {
    const r = await rig();
    const hold = deferred();
    r.port.readGate = hold.promise;
    r.port.unreadable = 1;
    const launch = await r.start({ sceneReview: true });
    const path = join(r.root, "library", AUTOPILOT_DIR, `${launch.launchId}.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as LaunchFile;
    const [first, second] = file.avatars[0]?.videos ?? [];
    if (first === undefined || second === undefined || file.avatars[0] === undefined) throw new Error("no videos");
    file.avatars[0].videos = [
      { ...first, state: "rendering", videoId: "video-00000001" },
      { ...second, source: "library", state: "assigned" },
      ...file.avatars[0].videos.slice(2),
    ];
    await Bun.write(path, JSON.stringify(file));
    hold.resolve();
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "skipped", "the skip");
    const videos = r.fileOf(launch.launchId).avatars[0]?.videos ?? [];
    expect(videos[0]).toMatchObject({ state: "rendering", dropReason: null });
    expect(videos[1]).toMatchObject({ state: "assigned", source: "library", dropReason: null });
    expect(videos.slice(2).every((v) => v.state === "dropped" && v.dropReason === "avatar-skipped")).toBe(true);
  });


  test("a resumable slice's open slots are on the avatar's row", async () => {
    const r = await rig();
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false, openSlots: 4 });
    const ended = deferred<RunJobEnd>();
    r.port.start = async () => ({ kind: "started", jobId: "job-run-0001", ended: ended.promise });
    const launch = await r.start({ sceneReview: true });
    await until(() => r.port.calls.includes("startLaunchSlice:returned"), "the slice start");
    const row = (await r.orchestrator.get(launch.launchId)).launch.avatars[0];
    expect(row?.resumableSlots).toBe(4);
    ended.resolve({ status: "cancelled" });
  });

  test("a wake-up that comes while the pass is running is not lost: the pass runs once more", async () => {
    const r = await rig();
    const hold = deferred();
    r.port.readGate = hold.promise;
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    await r.start({ sceneReview: true });
    await until(() => r.port.reads === 1, "the first read");
    r.steps.begin(r.ctx());
    hold.resolve();
    await until(() => r.port.reads >= 2, "the second pass");
  });
});

describe("the month hold of a resumed slice names the launch's live slices (L3)", () => {
  test("resumeSliceHold gets the other avatars' resumable slices as live scopes", async () => {
    const r = await rig();
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.seed({ sceneSetId: SET2, runId: RUN2, avatarId: B, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN2, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false });
    r.port.statuses.set(RUN2, { finished: false });
    r.port.start = async (runId) => {
      if (runId === RUN1) throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail: "the month is full" });
      return { kind: "started", jobId: "job-run-0002", ended: new Promise<RunJobEnd>(() => undefined) };
    };
    await r.start({ avatarIds: [A, B], sceneReview: true });
    await until(() => r.port.holdArgs.length >= 1, "the hold");
    const live = (r.port.holdArgs[0]?.[1] ?? []) as { scope: { runId: string } }[];
    expect(live.map((l) => l.scope.runId).sort()).toEqual([RUN1, RUN2].sort());
  });
});

describe("an avatar none of whose videos waits for photos draws nothing (6e)", () => {
  test("every generated video already dropped: no slice is drawn and the avatar rests at montage", async () => {
    const r = await rig();
    const hold = deferred();
    r.port.readGate = hold.promise;
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    const launch = await r.start({ sceneReview: true });
    const path = join(r.root, "library", AUTOPILOT_DIR, `${launch.launchId}.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as LaunchFile;
    if (file.avatars[0] === undefined) throw new Error("no avatar");
    file.avatars[0].videos = file.avatars[0].videos.map((v) => ({ ...v, state: "dropped" as const, dropReason: "not-enough-photos" as const }));
    await Bun.write(path, JSON.stringify(file));
    hold.resolve();
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "montage");
    expect(r.port.calls).not.toContain("drawLaunchSlice");
    expect(r.port.calls).not.toContain("startLaunchSlice");
  });
});

describe("a launch that is not payable now is left quietly (LOW)", () => {
  test("the engine's «not payable» refusal is neither «avatar busy» nor a failure: no waiting phase, no retry, no hold", async () => {
    const r = await rig();
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false });
    let attempts = 0;
    r.port.start = async () => {
      attempts += 1;
      throw new EngineFailure({ code: "VALIDATION", detail: `${NOT_PAYABLE_DETAIL}: launch ${LAUNCH} is paused` });
    };
    const launch = await r.start({ sceneReview: true });
    await until(() => attempts === 1, "the refused start");
    await idle();
    await idle();
    expect(attempts).toBe(1);
    expect(r.fileOf(launch.launchId).avatars[0]?.waiting).toBeNull();
    expect(r.fileOf(launch.launchId).paidHold).toBeNull();
  });
});
