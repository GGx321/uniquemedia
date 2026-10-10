import { afterEach, describe, expect, test } from "bun:test";
import type { ErrorCode } from "../../shared/engine";
import type { PaidHold } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import { failureWords } from "./paidSteps";
import type { RunJobEnd } from "../runs/runJob";
import type { DrawSliceResult } from "../sceneSets/launchDraw";
import type { LaunchSliceStart } from "./paidPort";
import { A, ALL, B, cleanupRigs, composes, deferred, FakeTimers, idle, LAUNCH, PHOTO, RUN1, RUN2, rig, SET1, SET2, until, type Rig } from "./testing/paidRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b2 (plan §4.6, §3.7, §3.8; invariants A6, A13, A19): the paid steps' failure table, row by row, the bounded automatic continues under a fake clock, the failure-rate guard and
// `host.power`, against the engine's double. The real engine, ledger and Budget group are in engine.autopilotHolds.test.ts. Each row asserts the hold (or the skip), the log line, that
// the steps sent nothing more, and that free work went on (the launch still runs and the free part can still write its file).

afterEach(cleanupRigs);

const MIN = 60_000;
const failure = (code: ErrorCode, detail = "the provider said so"): EngineFailure => new EngineFailure({ code, detail });
const failedEnd = (code: ErrorCode): RunJobEnd => ({ status: "failed", error: { code, detail: "the run stopped" } });
const doneEnd = (): RunJobEnd => ({ status: "done", photoIds: ALL.map((n) => `photo-${n}`), failedSlots: 0 });

/** Compose, approval and draw of a single slice of ten scenes under RUN1, the slice not yet finished. */
function drawnPath(r: Rig): void {
  r.port.compose = composes(r.port, LAUNCH);
  r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
  r.port.draw = async () => {
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
    return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 } satisfies DrawSliceResult;
  };
}

/** Two avatars, each with a ten-scene set and a slice entry of its own. */
function bothPath(r: Rig): void {
  const runOf = (setId: string): string => (setId === SET1 ? RUN1 : RUN2);
  const avatarOf = (setId: string): string => (setId === SET1 ? A : B);
  r.port.compose = async (payload, ids) => {
    r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, avatarId: payload.avatarId, launchId: LAUNCH });
    return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
  };
  r.port.approve = async (setId) => r.port.seed({ sceneSetId: setId, runId: runOf(setId), avatarId: avatarOf(setId), launchId: LAUNCH, draw: { sceneIds: ALL } });
  r.port.draw = async (input) => {
    const runId = runOf(input.sceneSetId);
    r.port.seed({ sceneSetId: input.sceneSetId, runId, avatarId: avatarOf(input.sceneSetId), launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(runId, { finished: false, openSlots: 10 });
    return { kind: "drawn", created: true, runId, sceneIds: ALL, capMicros: PHOTO * 10 };
  };
}

type Step = RunJobEnd | Error | "done";

/** The slice start answers the script in order (the last answer repeats). A `"done"` finishes the slice. Returns how many starts were made. */
function scripted(r: Rig, script: readonly Step[], runId = RUN1): { starts: () => number } {
  let n = 0;
  r.port.start = async (id): Promise<LaunchSliceStart> => {
    const step = script[Math.min(n, script.length - 1)];
    n += 1;
    if (step === undefined) throw new Error("an empty script");
    if (step instanceof Error) throw step;
    if (step === "done" || (typeof step === "object" && step.status === "done")) r.port.statuses.set(id === runId ? runId : id, { finished: true, committedMicros: PHOTO });
    return { kind: "started", jobId: "job-run-0001", ended: Promise.resolve(step === "done" ? doneEnd() : step) };
  };
  return { starts: () => n };
}

/**
 * The launch's hold as the steps see it (the orchestrator's copy), and the file's when the launch is over. Not the file alone: the file is written before the copy is replaced, and a test that
 * moves the clock the moment the file shows a hold would fire a timer at a launch that does not know the hold yet.
 */
const holdOf = (r: Rig, launchId: string): PaidHold | null => {
  try {
    return r.ctx().file().paidHold;
  } catch {
    return r.fileOf(launchId).paidHold;
  }
};

async function reachHold(r: Rig, launchId: string, reason: PaidHold["reason"]): Promise<PaidHold> {
  await until(() => holdOf(r, launchId)?.reason === reason, `the ${reason} hold`);
  const hold = holdOf(r, launchId);
  if (hold === null) throw new Error("no hold");
  return hold;
}

async function logOf(r: Rig, launchId: string) {
  return (await r.orchestrator.get(launchId)).log;
}

/** Free work goes on through a paid hold (A13): the launch still runs, and the free part can still write its file. */
async function expectFreeWorkGoesOn(r: Rig, launchId: string): Promise<void> {
  const before = r.fileOf(launchId).revision;
  expect(r.ctx().isRunning()).toBe(true);
  const written = await r.ctx().update((f) => ({
    ...f,
    avatars: f.avatars.map((a, i) => (i === 0 ? { ...a, videos: a.videos.map((v, j) => (j === 0 ? { ...v, state: "waiting-photos" as const } : v)) } : a)),
  }));
  expect(written.status).toBe("running");
  expect(written.revision).toBeGreaterThan(before);
  expect(r.fileOf(launchId).avatars[0]?.videos[0]?.state).toBe("waiting-photos");
}

const onlyOneStart = async (starts: () => number): Promise<void> => {
  await idle();
  expect(starts()).toBe(1);
};

// ---------- the table of plan §4.6, row by row ----------

describe("§4.6: a slice run that ends failed", () => {
  test("INSUFFICIENT_CREDITS holds the launch as «credits», logs it, sends nothing more, and free work goes on", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedEnd("INSUFFICIENT_CREDITS")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "credits");
    expect(hold.detail).toEqual({});
    expect((await logOf(r, launch.launchId)).some((l) => l.kind === "hold-credits")).toBe(true);
    expect(r.fileOf(launch.launchId).avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    await onlyOneStart(run.starts);
    expect(r.budget.ledger.lines).toHaveLength(0);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("AUTH_INVALID holds the launch as «key», logs it, and sends nothing more", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedEnd("AUTH_INVALID")]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "key");
    expect((await logOf(r, launch.launchId)).some((l) => l.kind === "hold-key")).toBe(true);
    await onlyOneStart(run.starts);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test.each(["SETTLE_ABOVE_WORST", "LEDGER_WRITE_FAILED"] as const)("%s holds the launch as «halt» with the code, and sends nothing more", async (code) => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedEnd(code)]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "halt");
    expect(hold.detail).toEqual({ code });
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "hold-halt")).toMatchObject({ code });
    await onlyOneStart(run.starts);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("BUDGET_EXCEEDED mid-slice (the run's slot hit the month) ends the slice with «budget» for a resume, logs how far it got, and the hold names the room the resume needs", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedEnd("BUDGET_EXCEEDED")]);
    const start = r.port.start;
    // Six of the ten photos arrived before the month ran out: four slots stay open.
    r.port.start = async (runId) => {
      r.port.statuses.set(RUN1, { finished: false, openSlots: 4 });
      if (start === null) throw new Error("no start");
      return start(runId);
    };
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "budget");
    expect(hold.detail).toMatchObject({ kind: "resume-slice" });
    expect(r.port.calls).toContain("resumeSliceHold");
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "budget-ended")).toMatchObject({ avatarId: A, done: 6, total: 10 });
    await onlyOneStart(run.starts);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("RUN_CAP_EXCEEDED mid-slice finishes the slice with what its cap bought: no hold, and the avatar goes on to its montage", async () => {
    const r = await rig();
    drawnPath(r);
    let statusAfter = false;
    r.port.start = async () => {
      statusAfter = true;
      return { kind: "started", jobId: "job-run-0001", ended: Promise.resolve(failedEnd("RUN_CAP_EXCEEDED")) };
    };
    // The run's slots stay open for good (its cap is used): the engine reports it finished once nothing can be funded.
    r.port.sliceStatuses = async () => new Map([[RUN1, statusAfter ? { finished: true as const, committedMicros: PHOTO * 10 } : { finished: false as const, openSlots: 10 }]]);
    const launch = await r.start({ sceneReview: false });
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });

  // S4.6r: an end the table has no row for is no longer a silent hang. The launch holds as «internal» with the job's own words, and «Продолжить» runs the job again.
  const failedWith = (code: ErrorCode, detail: string): RunJobEnd => ({ status: "failed", error: { code, detail } });
  const MASTER = "the master photo could not be prepared as the face reference: it took longer than 15000 ms";

  test("an INTERNAL end holds the launch as «internal» with the job's detail, logs it with that detail, sends nothing more, and free work goes on", async () => {
    const warnings: string[] = [];
    const r = await rig({ steps: { warn: (line) => warnings.push(line) } });
    drawnPath(r);
    const run = scripted(r, [failedWith("INTERNAL", MASTER)]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: `INTERNAL: ${MASTER}` });
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "hold-internal")).toMatchObject({ holdKind: "job-failed", detail: `INTERNAL: ${MASTER}` });
    expect(r.fileOf(launch.launchId).avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    expect(warnings.some((w) => w.includes(MASTER))).toBe(true);
    await onlyOneStart(run.starts);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("«Продолжить» is open for it, retries the job, and the hold is gone when the job goes through (R is what the launch has left, nothing more)", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedWith("INTERNAL", MASTER), "done"]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "internal");
    const held = (await r.orchestrator.get(launch.launchId)).launch;
    expect(held.resumeBlockedBy).toBeNull();
    const view = await r.orchestrator.resume(launch.launchId, held.remainingMicros);
    expect(view.status).toBe("running");
    expect(view.remainingMicros).toBe(held.remainingMicros);
    await until(() => run.starts() === 2, "the second start");
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });

  test("a job that fails the same way again holds again: the owner is told, nothing loops", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedWith("INTERNAL", MASTER)]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "internal");
    const held = (await r.orchestrator.get(launch.launchId)).launch;
    await r.orchestrator.resume(launch.launchId, held.remainingMicros);
    await until(() => run.starts() === 2, "the second start");
    await reachHold(r, launch.launchId, "internal");
    await idle();
    expect(run.starts()).toBe(2);
  });

  test.each(["NOT_FOUND", "VALIDATION", "LIBRARY_UNAVAILABLE"] as const)("%s, a code with no row either, holds the same way", async (code) => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedWith(code, "no master")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: `${code}: no master` });
    await onlyOneStart(run.starts);
  });

  test("a detail longer than the contract's line is cut, not refused", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failedWith("INTERNAL", "x".repeat(900))]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.reason === "internal" && (hold.detail.message?.length ?? 0) <= 240).toBe(true);
  });

  test("a slice refused at its start with a code the table has no row for holds as «internal» too", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failure("INTERNAL", "the engine is shutting down")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: "INTERNAL: the engine is shutting down" });
  });

  test.each([
    ["a POSIX path", "ENOENT: no such file or directory, open '/Users/someone/Library/Studio/avatars/a/master.png'"],
    ["a Windows path", "EPERM: operation not permitted, open 'C:\\Users\\someone\\Studio\\master.png'"],
  ])("an absolute path in a job's detail (%s) never reaches the hold, the log or the file", async (_name, detail) => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failedWith("INTERNAL", `the master photo could not be prepared as the face reference: ${detail}`)]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    const written = JSON.stringify([hold, (await logOf(r, launch.launchId)).filter((l) => l.kind === "hold-internal"), r.fileOf(launch.launchId).paidHold]);
    expect(written).not.toContain("someone");
    expect(written).toContain("<path>");
    expect(written).toContain("the master photo could not be prepared as the face reference");
  });

  test("an Error whose name is empty is still held, as «Error»: the contract refuses an empty message, and a refused write would hang the launch again", async () => {
    const nameless = new Error("x");
    nameless.name = "";
    expect(failureWords(nameless, undefined)).toBe("Error");
    expect(failureWords(42, undefined)).toBe("number");
    const r = await rig();
    drawnPath(r);
    scripted(r, [nameless]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: "Error" });
  });

  test("a failure that is not an engine error is held with its name only, never its message", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [new TypeError("secret path /Users/someone/key")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(JSON.stringify(hold)).not.toContain("secret");
    expect(hold.detail).toEqual({ kind: "job-failed", message: "TypeError" });
  });

  test("a halt that stands is not displaced by a failed job's internal hold (rank 1 against rank 3)", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failedWith("SETTLE_ABOVE_WORST", "over")]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "halt");
    await r.ctx().raisePaidHold({ reason: "internal", at: "2026-10-09T10:00:00.000Z", detail: { kind: "job-failed", message: "INTERNAL: x" } });
    expect(holdOf(r, launch.launchId)?.reason).toBe("halt");
  });

  test("the allocation check's own «internal» hold still closes «Продолжить»", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failedWith("INTERNAL", MASTER)]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "internal");
    await r.ctx().update((f) => ({ ...f, paidHold: { reason: "internal", at: "2026-10-09T10:00:00.000Z", detail: { kind: "allocation-exceeded" } } }));
    expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBe("internal");
  });
});

describe("§4.6: a slice run that is refused at its start", () => {
  test("AUTH_INVALID holds as «key» and RECONCILE_REQUIRED waits for the reconcile as a network hold with no retry", async () => {
    const key = await rig();
    drawnPath(key);
    scripted(key, [failure("AUTH_INVALID")]);
    const first = await key.start({ sceneReview: false });
    await reachHold(key, first.launchId, "key");

    const reconcile = await rig();
    drawnPath(reconcile);
    const run = scripted(reconcile, [failure("RECONCILE_REQUIRED", "1 open attempt(s)")]);
    const second = await reconcile.start({ sceneReview: false });
    const hold = await reachHold(reconcile, second.launchId, "network");
    expect(hold.detail).toMatchObject({ nextAt: null });
    await onlyOneStart(run.starts);
  });

  test("PRICE_CHANGED holds as «price» for the slice, naming how far it shrank (to nothing), and starts nothing more", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
    const run = scripted(r, [failure("PRICE_CHANGED", "the remaining worst case is above the cap")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "price");
    expect(hold.detail).toEqual({ stage: "slice", fromPhotos: 10, toPhotos: 0 });
    expect((await logOf(r, launch.launchId)).some((l) => l.kind === "hold-price")).toBe(true);
    await onlyOneStart(run.starts);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("BUDGET_EXCEEDED holds as «budget» for a resume, with the room the resume needs", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failure("BUDGET_EXCEEDED")]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "budget");
    expect(hold.detail).toEqual({ kind: "resume-slice", freeMicros: 0, needMicros: 100_000 });
    await onlyOneStart(run.starts);
  });
});

describe("§4.6: the avatar's own refusals skip it and the others go on", () => {
  test.each([
    ["MASTER_FACE_UNUSABLE", "master-unusable"],
    ["FACE_GATE_UNAVAILABLE", "face-gate-unavailable"],
    ["DESCRIPTOR_INVALID", "descriptor-invalid"],
  ] as const)("a run that ends %s skips its avatar as %s; the other avatar's slice is still started", async (code, reason) => {
    const r = await rig();
    bothPath(r);
    const started: string[] = [];
    r.port.start = async (runId) => {
      started.push(runId);
      if (runId === RUN1) return { kind: "started", jobId: "job-run-0001", ended: Promise.resolve(failedEnd(code)) };
      r.port.statuses.set(RUN2, { finished: true, committedMicros: PHOTO });
      return { kind: "started", jobId: "job-run-0002", ended: Promise.resolve(doneEnd()) };
    };
    const launch = await r.start({ avatarIds: [A, B], sceneReview: false });
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "skipped", "the skip");
    expect(r.fileOf(launch.launchId).avatars[0]?.skipped).toEqual({ reason });
    expect(holdOf(r, launch.launchId)).toBeNull();
    await until(() => started.includes(RUN2), "the other avatar's slice");
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "skipped")).toMatchObject({ avatarId: A, reason });
  });
});

describe("§4.6: PRICE_UNAVAILABLE retries after 5, 15 and 60 minutes, then holds", () => {
  test("each failure arms the next retry, a retry that succeeds carries on, and the fourth failure holds with no retry left", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    drawnPath(r);
    // The sizing of the first slice needs the price list; the entry exists, so the price is read only when the slice is drawn: plant a set that still needs a slice.
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    let reads = 0;
    r.port.photoWorstMicros = async () => {
      reads += 1;
      throw failure("PRICE_UNAVAILABLE", "the price list could not be loaded");
    };
    const launch = await r.start({ sceneReview: false });
    const first = await reachHold(r, launch.launchId, "price-unavailable");
    expect(first.detail).toEqual({ attempt: 1, nextAt: timers.iso(5 * MIN) });
    expect(r.fileOf(launch.launchId).priceRetries).toBe(1);

    timers.advance(5 * MIN - 1);
    await idle();
    expect(reads).toBe(1);
    timers.advance(1);
    await until(() => holdOf(r, launch.launchId)?.reason === "price-unavailable" && reads === 2, "the second try");
    await until(() => (holdOf(r, launch.launchId)?.detail as { attempt?: number } | undefined)?.attempt === 2, "the second hold");
    expect(holdOf(r, launch.launchId)?.detail).toEqual({ attempt: 2, nextAt: timers.iso(15 * MIN) });

    timers.advance(15 * MIN);
    await until(() => reads === 3 && (holdOf(r, launch.launchId)?.detail as { attempt?: number } | undefined)?.attempt === 3, "the third hold");
    expect(holdOf(r, launch.launchId)?.detail).toEqual({ attempt: 3, nextAt: timers.iso(60 * MIN) });

    timers.advance(60 * MIN);
    await until(() => reads === 4 && (holdOf(r, launch.launchId)?.detail as { nextAt?: string | null } | undefined)?.nextAt === null, "the retries used up");
    expect(holdOf(r, launch.launchId)?.detail).toEqual({ attempt: 3, nextAt: null });
    expect(timers.pending()).toBe(0);
    timers.advance(24 * 60 * MIN);
    await idle();
    expect(reads).toBe(4);
  });

  test("a retry that finds the prices again carries on with the draw", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    drawnPath(r);
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    let reads = 0;
    r.port.photoWorstMicros = async () => {
      reads += 1;
      if (reads === 1) throw failure("PRICE_UNAVAILABLE");
      return PHOTO;
    };
    scripted(r, ["done"]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "price-unavailable");
    timers.advance(5 * MIN);
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });
});

describe("§4.6: a scene step that fails (compose and the launch's own «Дописать»)", () => {
  /** A compose whose job stopped on `error`: the set is there with no sentences, and says why its write stopped. */
  function composeStopped(r: Rig, error: { code: ErrorCode; detail: string }): void {
    r.port.compose = async (_payload, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", ...realStop(error) } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
  }

  /** How the real store records a stop (`stoppedByOf`, `withWriteStopped`): the drops and the provider's refusals are named by `stoppedBy` alone; only `failed` carries the error. */
  function realStop(error: { code: ErrorCode; detail: string }): { stoppedBy: "network" | "timeout" | "rate-limited" | "failed"; stoppedError?: { code: ErrorCode; detail: string } } {
    if (error.code === "NETWORK") return { stoppedBy: "network" };
    if (error.code === "TIMEOUT") return { stoppedBy: "timeout" };
    if (error.code === "RATE_LIMITED") return { stoppedBy: "rate-limited" };
    return { stoppedBy: "failed", stoppedError: error };
  }

  test("a compose that stopped on INSUFFICIENT_CREDITS holds as «credits» and does not write again", async () => {
    const r = await rig();
    composeStopped(r, { code: "INSUFFICIENT_CREDITS", detail: "out of credits" });
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "credits");
    await idle();
    expect(r.port.calls).not.toContain("writeLaunchScenes");
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("a compose that stopped on AUTH_INVALID holds as «key»", async () => {
    const r = await rig();
    composeStopped(r, { code: "AUTH_INVALID", detail: "rejected" });
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "key");
  });

  test("a compose that stopped on a drop is a drop of the set's scene step: «network» with its own counter, keyed by the set", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    composeStopped(r, { code: "NETWORK", detail: "fetch failed" });
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 1, nextAt: timers.iso(MIN) });
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [`${SET1}:scenes`]: { drops: 1, continues: 1 } });
  });

  test.each([
    ["provider-error", "NETWORK"],
    ["timeout", "TIMEOUT"],
    ["rate-limited", "RATE_LIMITED"],
  ] as const)("S4.10 M-2: a write the real store recorded as stopped by «%s» (no error kept) is a drop (%s): the first continue, not an internal hold", async (stoppedBy) => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    r.port.compose = async (_payload, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", stoppedBy } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 1, nextAt: timers.iso(MIN) });
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [`${SET1}:scenes`]: { drops: 1, continues: 1 } });
  });

  test("S4.10 M-2: the third drop of a scene step holds for a person as «network» with no retry (A19)", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    r.port.compose = async (_payload, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", stoppedBy: "network" } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
    r.port.write = async () => ({ jobId: "job-write-0001" });
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "network");
    timers.advance(MIN);
    await until(() => r.port.calls.filter((c) => c === "writeLaunchScenes").length === 1 && timers.pending() === 1, "the second drop and its wait");
    timers.advance(5 * MIN);
    await until(() => r.port.calls.filter((c) => c === "writeLaunchScenes").length === 2, "the third write");
    await until(() => holdOf(r, launch.launchId)?.reason === "network" && (holdOf(r, launch.launchId)?.detail as { nextAt: string | null }).nextAt === null, "the hold for a person");
  });

  test("a compose that stopped on INTERNAL holds as «internal» with the job's detail, and «Продолжить» writes the scenes again", async () => {
    const r = await rig();
    let broken = true;
    r.port.compose = async (_payload, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      if (broken) r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", stoppedBy: "failed", stoppedError: { code: "INTERNAL", detail: "the writer broke" } } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: "INTERNAL: the writer broke" });
    expect(r.fileOf(launch.launchId).autoContinues).toBeUndefined();
    broken = false;
    // The writer is whole again: the set stands as the compose left it, with no stop recorded.
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, written: 0 });
    r.port.write = async () => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
      return { jobId: "job-write-0001" };
    };
    // The pass goes on past the write (S4.10: an approval the double cannot answer is a stuck pass, which now holds the launch): the set is approved and has nothing to draw.
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => ({ kind: "none-left" });
    const held = (await r.orchestrator.get(launch.launchId)).launch;
    expect(held.resumeBlockedBy).toBeNull();
    await r.orchestrator.resume(launch.launchId, held.remainingMicros);
    await until(() => r.port.calls.includes("writeLaunchScenes"), "the scenes written again");
    await until(() => r.port.calls.includes("drawLaunchSlice"), "the pass to go on to the draw");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });

  test("a compose stopped by BUDGET_EXCEEDED holds as «budget» for a new step with the writer's worst case as the need, not as a failed job", async () => {
    const r = await rig();
    composeStopped(r, { code: "BUDGET_EXCEEDED", detail: "the month is spent" });
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "budget");
    expect(hold.detail).toMatchObject({ kind: "new-slice", needMicros: 75_000 });
  });

  test("a compose stopped by PRICE_CHANGED that no longer fits its allocation holds as «price» (rewrite), not as a failed job", async () => {
    const r = await rig();
    r.port.writeCost = () => 1_000_000_000;
    composeStopped(r, { code: "PRICE_CHANGED", detail: "the price rose" });
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "price");
    expect(hold.detail).toMatchObject({ stage: "rewrite", needMicros: 1_000_000_000 });
  });

  test.each(["RUN_CAP_EXCEEDED", "IN_FLIGHT"] as const)("a compose stopped by %s, which no scene row serves, says so in the failed job's hold", async (code) => {
    const r = await rig();
    composeStopped(r, { code, detail: "stopped" });
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toEqual({ kind: "job-failed", message: `${code}: stopped` });
  });

  test("the launch's own «Дописать» that is refused with a key error holds as «key»", async () => {
    const r = await rig();
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, written: 0 });
    r.port.write = async () => {
      throw failure("AUTH_INVALID");
    };
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "key");
  });
});

// ---------- the bounded automatic continues ----------

describe("§4.6: a request that gets no answer continues by itself, twice, then waits for a person (Q2 = A)", () => {
  async function dropping(script: readonly Step[]) {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    drawnPath(r);
    const run = scripted(r, script);
    const launch = await r.start({ sceneReview: false });
    return { r, timers, run, launch };
  }

  test("the first drop holds as «network» with the next try at one minute, logs the retry, and the slice is started again when the minute is up", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    const hold = await reachHold(r, launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 1, nextAt: timers.iso(MIN) });
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "network-retry")).toMatchObject({ attempt: 1, attempts: 2, afterMs: MIN });
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [RUN1]: { drops: 1, continues: 1 } });
    await expectFreeWorkGoesOn(r, launch.launchId);
    timers.advance(MIN - 1);
    await idle();
    expect(run.starts()).toBe(1);
    timers.advance(1);
    await until(() => run.starts() === 2, "the second start");
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
    expect(timers.pending()).toBe(0);
  });

  test("Q2 = Б, the alternative the owner's answer may pick: with no automatic continue the FIRST drop holds for a person at once, and no timer is armed", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now, networkWaitsMs: [] } });
    drawnPath(r);
    const run = scripted(r, [failedEnd("NETWORK"), "done"]);
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "network");
    expect(hold.detail).toEqual({ drops: 1, attempt: 0, nextAt: null });
    expect(timers.pending()).toBe(0);
    timers.advance(24 * 60 * MIN);
    await idle();
    expect(run.starts()).toBe(1);
    expect((await logOf(r, launch.launchId)).some((l) => l.kind === "network-retry")).toBe(false);
  });

  test("a final 429 is the same bounded continue: nothing was burnt, the slice goes on after the minute", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("RATE_LIMITED"), "done"]);
    const hold = await reachHold(r, launch.launchId, "network");
    expect(hold.detail).toMatchObject({ drops: 1, attempt: 1 });
    timers.advance(MIN);
    await until(() => run.starts() === 2, "the second start");
  });

  test("the second drop of the same job continues after five minutes", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    timers.advance(MIN);
    await until(() => run.starts() === 2 && (holdOf(r, launch.launchId)?.detail as { drops?: number } | undefined)?.drops === 2 && timers.pending() === 1, "the second hold and its wait");
    expect(holdOf(r, launch.launchId)?.detail).toEqual({ drops: 2, attempt: 2, nextAt: timers.iso(5 * MIN) });
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [RUN1]: { drops: 2, continues: 2 } });
    timers.advance(5 * MIN - 1);
    await idle();
    expect(run.starts()).toBe(2);
    timers.advance(1);
    await until(() => run.starts() === 3, "the third start");
  });

  test("the third drop holds as «network» for a person: no retry is armed, nothing more is sent, whatever the clock does", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK")]);
    await reachHold(r, launch.launchId, "network");
    timers.advance(MIN);
    await until(() => run.starts() === 2, "the second start");
    await until(() => (holdOf(r, launch.launchId)?.detail as { drops?: number } | undefined)?.drops === 2 && timers.pending() === 1, "the second hold and its wait");
    timers.advance(5 * MIN);
    await until(() => run.starts() === 3, "the third start");
    await until(() => (holdOf(r, launch.launchId)?.detail as { drops?: number } | undefined)?.drops === 3, "the third hold");
    expect(holdOf(r, launch.launchId)?.detail).toEqual({ drops: 3, attempt: 2, nextAt: null });
    expect(timers.pending()).toBe(0);
    timers.advance(24 * 60 * MIN);
    await idle();
    expect(run.starts()).toBe(3);
    expect((await logOf(r, launch.launchId)).filter((l) => l.kind === "network-retry")).toHaveLength(2);
    await expectFreeWorkGoesOn(r, launch.launchId);
  });

  test("a different job has its own count: after a slice dropped twice, a drop of another job still gets its first continue", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    drawnPath(r);
    // The compose stopped on a drop first (its own key), then the slice drops: each has used one continue.
    let composed = false;
    r.port.compose = async (_payload, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: composed ? 10 : 0 });
      if (!composed) r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", stoppedBy: "network" } } as typeof set);
      composed = true;
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
    scripted(r, [failedEnd("NETWORK"), "done"]);
    const launch = await r.start({ sceneReview: false });
    await until(() => holdOf(r, launch.launchId)?.reason === "network" && timers.pending() === 1, "the compose drop and its wait");
    r.port.sets.delete(SET1);
    timers.advance(MIN);
    await until(() => r.fileOf(launch.launchId).autoContinues?.[RUN1] !== undefined, "the slice drop");
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [`${SET1}:scenes`]: { drops: 1, continues: 1 }, [RUN1]: { drops: 1, continues: 1 } });
  });

  test("«Пауза» during the wait cancels the timer: nothing fires after it", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    expect(timers.pending()).toBe(1);
    await r.orchestrator.pause(launch.launchId);
    expect(timers.pending()).toBe(0);
    timers.advance(10 * MIN);
    await idle();
    expect(run.starts()).toBe(1);
    expect(r.fileOf(launch.launchId).status).toBe("paused");
  });

  test("«Стоп» during the wait cancels the timer: nothing fires after it", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    await r.orchestrator.stop(launch.launchId);
    expect(timers.pending()).toBe(0);
    timers.advance(10 * MIN);
    await idle();
    expect(run.starts()).toBe(1);
    expect(r.fileOf(launch.launchId).status).toBe("stopped");
  });

  test("a quit during the wait cancels the timer: nothing fires after it (a restart then reads the launch as paused)", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    await r.orchestrator.shutdown();
    expect(timers.pending()).toBe(0);
    timers.advance(10 * MIN);
    await idle();
    expect(run.starts()).toBe(1);
  });

  test("the owner's «Продолжить» during the wait takes over: the slice starts once now, and the old timer never fires a second start", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    const view = await r.orchestrator.resume(launch.launchId, launch.remainingMicros);
    expect(view.status).toBe("running");
    await until(() => run.starts() === 2, "the second start");
    expect(timers.pending()).toBe(0);
    timers.advance(10 * MIN);
    await idle();
    expect(run.starts()).toBe(2);
  });

  test("the timer checks the admission rule when it fires: with the ledger closed (a reconcile is due) the hold waits for the person and nothing is sent", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    r.port.admit = false;
    timers.advance(MIN);
    await until(() => (holdOf(r, launch.launchId)?.detail as { nextAt?: string | null } | undefined)?.nextAt === null, "the hold with no retry");
    expect(run.starts()).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test("a hold that another reason replaced is not cleared by the old timer", async () => {
    const { r, timers, run, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    await r.ctx().raisePaidHold({ reason: "credits", at: timers.iso(), detail: {} });
    timers.advance(MIN);
    await idle();
    expect(holdOf(r, launch.launchId)?.reason).toBe("credits");
    expect(run.starts()).toBe(1);
  });

  test("a network hold with a retry still to come is admitted by «Продолжить» without a reconcile; the third drop's hold is not (A19)", async () => {
    const { r, launch } = await dropping([failedEnd("NETWORK"), "done"]);
    await reachHold(r, launch.launchId, "network");
    expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBeNull();
  });
});

// ---------- the failure-rate guard ----------

describe("§4.6: the failure-rate guard (a slice of four photos or more, half of them failing the gates or moderation)", () => {
  const MANY = Array.from({ length: 30 }, (_, i) => i + 1);
  const FIRST = MANY.slice(0, 25);

  /**
   * Two avatars, each with thirty approved scenes: the first draw of a set is a slice of 25 photos, a later draw finds the five left (the double answers «none left» to it, so an avatar that
   * is not skipped rests at its montage). Every run ends done at once; `draws` counts the draws by set.
   */
  async function twoSlices(outcomeOfA: { slots: number; checkFailures: number }) {
    const r = await rig();
    bothPath(r);
    const draws: Record<string, number> = { [SET1]: 0, [SET2]: 0 };
    const started: string[] = [];
    r.port.approve = async (setId) => r.port.seed({ sceneSetId: setId, runId: setId === SET1 ? RUN1 : RUN2, avatarId: setId === SET1 ? A : B, launchId: LAUNCH, count: 30, draw: { sceneIds: MANY } });
    r.port.draw = async (input) => {
      draws[input.sceneSetId] = (draws[input.sceneSetId] ?? 0) + 1;
      if ((draws[input.sceneSetId] ?? 0) > 1) return { kind: "none-left" };
      const runId = input.sceneSetId === SET1 ? RUN1 : RUN2;
      r.port.seed({ sceneSetId: input.sceneSetId, runId, avatarId: runId === RUN1 ? A : B, launchId: LAUNCH, count: 30, draw: { sceneIds: MANY, slices: [{ runId, sceneIds: FIRST, capMicros: PHOTO * 25 }] } });
      r.port.statuses.set(runId, { finished: false, openSlots: 25 });
      return { kind: "drawn", created: true, runId, sceneIds: FIRST, capMicros: PHOTO * 25 };
    };
    r.port.outcomes.set(RUN1, outcomeOfA);
    r.port.start = async (runId) => {
      started.push(runId);
      r.port.statuses.set(runId, { finished: true, committedMicros: PHOTO });
      return { kind: "started", jobId: `job-${runId}`, ended: Promise.resolve(doneEnd()) };
    };
    const launch = await r.start({ avatarIds: [A, B], sceneReview: false });
    await until(() => r.fileOf(launch.launchId).avatars.every((a) => a.phase === "montage" || a.phase === "skipped"), "both avatars at rest");
    return { r, launch, draws, started };
  }

  test("half of the slots failing the checks skips the avatar as failure-rate with the counts, logs them, and the other avatar goes on", async () => {
    const { r, launch, draws, started } = await twoSlices({ slots: 25, checkFailures: 13 });
    expect(r.fileOf(launch.launchId).avatars[0]).toMatchObject({ phase: "skipped", skipped: { reason: "failure-rate", failed: 13, total: 25 } });
    expect(r.fileOf(launch.launchId).avatars[1]?.phase).toBe("montage");
    expect((await logOf(r, launch.launchId)).find((l) => l.kind === "skipped")).toMatchObject({ avatarId: A, reason: "failure-rate", failed: 13, total: 25 });
    expect(holdOf(r, launch.launchId)).toBeNull();
    expect(started).toContain(RUN2);
    // The avatar that failed the checks is not asked for another slice; the one that did not is (and finds nothing left).
    expect(draws[SET1]).toBe(1);
    expect(draws[SET2]).toBe(2);
  });

  test.each([
    ["13 of 25, just over half", 25, 13, true],
    ["12 of 25, just under half", 25, 12, false],
    ["no failure at all", 25, 0, false],
  ])("%s: %i slots, %i failed the checks", async (_name, slots, failed, skipped) => {
    const { r, launch } = await twoSlices({ slots, checkFailures: failed });
    expect(r.fileOf(launch.launchId).avatars[0]?.phase === "skipped").toBe(skipped);
  });

  test("a slice whose photos all failed but which was the avatar's last has nothing left to protect: the photos that came are kept", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.outcomes.set(RUN1, { slots: 10, checkFailures: 9 });
    scripted(r, ["done"]);
    const launch = await r.start({ sceneReview: false });
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(r.fileOf(launch.launchId).avatars[0]?.skipped).toBeNull();
  });

  test("a pause that lands while the slice ends does not lose the verdict: «Продолжить» skips the avatar before it buys another slice", async () => {
    const r = await rig();
    bothPath(r);
    const draws: string[] = [];
    r.port.approve = async (setId) => r.port.seed({ sceneSetId: setId, runId: RUN1, avatarId: A, launchId: LAUNCH, count: 30, draw: { sceneIds: MANY } });
    r.port.draw = async (input) => {
      draws.push(input.sceneSetId);
      r.port.seed({ sceneSetId: SET1, runId: RUN1, avatarId: A, launchId: LAUNCH, count: 30, draw: { sceneIds: MANY, slices: [{ runId: RUN1, sceneIds: FIRST, capMicros: PHOTO * 25 }] } });
      r.port.statuses.set(RUN1, { finished: false, openSlots: 25 });
      return { kind: "drawn", created: true, runId: RUN1, sceneIds: FIRST, capMicros: PHOTO * 25 };
    };
    r.port.outcomes.set(RUN1, { slots: 25, checkFailures: 20 });
    const gate = deferred();
    r.port.start = async () => {
      // The pause lands while the run is being started; by the time it ends, its slots are all closed.
      await gate.promise;
      r.port.statuses.set(RUN1, { finished: true, committedMicros: PHOTO });
      return { kind: "started", jobId: "job-run-0001", ended: Promise.resolve(doneEnd()) };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("startLaunchSlice"), "the start");
    const pausing = r.orchestrator.pause(launch.launchId);
    gate.resolve();
    await pausing;
    await r.orchestrator.settled();
    expect(draws).toHaveLength(1);
    await r.orchestrator.resume(launch.launchId, launch.remainingMicros);
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "skipped", "the skip");
    expect(draws).toHaveLength(1);
  });
});

// ---------- host.power ----------

describe("host.power (plan §3.8): sleep stops new attempts, waking puts right what the sleep interrupted", () => {
  async function inFlight() {
    const r = await rig();
    drawnPath(r);
    const ended = deferred<RunJobEnd>();
    let starts = 0;
    let live = false;
    r.port.softRun = () => live;
    r.port.start = async (): Promise<LaunchSliceStart> => {
      starts += 1;
      live = true;
      if (starts === 1) return { kind: "started", jobId: "job-run-0001", ended: ended.promise };
      r.port.statuses.set(RUN1, { finished: true, committedMicros: PHOTO });
      return { kind: "started", jobId: "job-run-0002", ended: Promise.resolve(doneEnd()) };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => starts === 1, "the slice in flight");
    return { r, launch, ended, starts: () => starts };
  }

  test("suspend soft-stops the slice in flight, closes the engine's paid entry points, and sends no new attempt", async () => {
    const { r, launch, ended, starts } = await inFlight();
    await r.orchestrator.power("suspend");
    expect(r.port.calls).toContain("softStopRun");
    expect(r.orchestrator.mayPay(launch.launchId)).toBe(false);
    ended.resolve({ status: "cancelled" });
    await idle();
    expect(starts()).toBe(1);
    expect(holdOf(r, launch.launchId)).toBeNull();
    expect(r.fileOf(launch.launchId).status).toBe("running");
  });

  test("resume starts the slice again, and claims no network check it cannot make", async () => {
    const { r, launch, ended, starts } = await inFlight();
    await r.orchestrator.power("suspend");
    ended.resolve({ status: "cancelled" });
    await idle();
    await r.orchestrator.power("resume");
    await until(() => starts() === 2, "the second start");
    expect(r.orchestrator.mayPay(launch.launchId)).toBe(true);
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
  });

  test("S4.10 M-1: the Mac wakes BEFORE the soft-stopped slice ends: its cancelled end is the sleep's, no hold, and the slice is started again", async () => {
    const { r, launch, ended, starts } = await inFlight();
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    // The job ends cancelled only now, after the wake-up: the order the gate-before-resume test misses.
    ended.resolve({ status: "cancelled" });
    await until(() => starts() === 2, "the slice started again");
    expect(holdOf(r, launch.launchId)).toBeNull();
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });

  test("S4.10 M-1: a slice cancelled with nobody asking for a stop is still a defect that holds the launch", async () => {
    const r = await rig();
    drawnPath(r);
    r.port.start = async (): Promise<LaunchSliceStart> => ({ kind: "started", jobId: "job-run-0001", ended: Promise.resolve({ status: "cancelled" } as RunJobEnd) });
    const launch = await r.start({ sceneReview: false });
    const hold = await reachHold(r, launch.launchId, "internal");
    expect(hold.detail).toMatchObject({ kind: "job-failed", message: expect.stringContaining("cancelled") });
  });

  test("S4.10 M-1: the Mac wakes before a soft-stopped compose/«Дописать» ends cancelled: no hold, the scenes are written again", async () => {
    const r = await rig();
    const idleGate = deferred();
    let live = false;
    r.port.softScenes = () => live;
    r.port.compose = async (_payload, ids) => {
      live = true;
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      // The soft stop is how the real store records it: `cancelled`, no error.
      r.port.sets.set(ids.sceneSetId, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0001", stoppedBy: "cancelled" } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
    };
    r.port.idleSet = () => idleGate.promise;
    r.port.write = async () => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
      return { jobId: "job-write-0001" };
    };
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => ({ kind: "none-left" });
    const launch = await r.start({ sceneReview: false });
    await until(() => live, "the compose in flight");
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    idleGate.resolve();
    await until(() => r.port.calls.includes("writeLaunchScenes"), "the scenes written again");
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
    expect(holdOf(r, launch.launchId)).toBeNull();
  });

  test("a network that is still down after the wake-up shows as the next drop of the job, on the bounded continues", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: timers.clock } });
    drawnPath(r);
    const ended = deferred<RunJobEnd>();
    let starts = 0;
    r.port.start = async (): Promise<LaunchSliceStart> => {
      starts += 1;
      return { kind: "started", jobId: "job-run-0001", ended: starts === 1 ? ended.promise : Promise.resolve(failedEnd("NETWORK")) };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => starts === 1, "the slice in flight");
    await r.orchestrator.power("suspend");
    ended.resolve({ status: "cancelled" });
    await idle();
    await r.orchestrator.power("resume");
    const hold = await reachHold(r, launch.launchId, "network");
    expect(starts).toBe(2);
    expect(hold.detail).toMatchObject({ drops: 1, attempt: 1 });
  });

  test("a timer that falls due while the Mac sleeps does nothing; the wake-up goes on with the wait it interrupted", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: () => timers.now } });
    drawnPath(r);
    const run = scripted(r, [failedEnd("NETWORK"), "done"]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "network");
    await r.orchestrator.power("suspend");
    timers.advance(MIN);
    await idle();
    expect(run.starts()).toBe(1);
    await r.orchestrator.power("resume");
    await until(() => run.starts() === 2, "the second start");
    await until(() => holdOf(r, launch.launchId) === null, "the hold cleared");
  });

  test("a compose whose start has not returned when the Mac sleeps is stopped the moment it returns", async () => {
    const r = await rig();
    const start = deferred<{ sceneSetId: string; jobId: string | null }>();
    let live = false;
    r.port.compose = async () => start.promise;
    r.port.softScenes = () => live;
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("composeLaunchSet"), "the compose call");
    await r.orchestrator.power("suspend");
    live = true;
    r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH });
    start.resolve({ sceneSetId: SET1, jobId: "job-compose-0001" });
    await until(() => r.port.calls.filter((c) => c === "softStopScenes").length >= 1, "the soft stop");
    await idle();
    expect(r.port.calls).not.toContain("approveLaunchSet");
    expect(launch.status).toBe("running");
  });

  test("suspend on a paused launch changes nothing, and resume does not start it", async () => {
    const r = await rig();
    drawnPath(r);
    const run = scripted(r, [failedEnd("INSUFFICIENT_CREDITS")]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "credits");
    await r.orchestrator.pause(launch.launchId);
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    await idle();
    expect(run.starts()).toBe(1);
    expect(r.fileOf(launch.launchId).status).toBe("paused");
  });

  test("the owner's «Продолжить» ends a sleep whose wake-up was lost: the launch is not stuck suspended", async () => {
    const r = await rig();
    drawnPath(r);
    scripted(r, [failedEnd("INSUFFICIENT_CREDITS"), "done"]);
    const launch = await r.start({ sceneReview: false });
    await reachHold(r, launch.launchId, "credits");
    await r.orchestrator.power("suspend");
    expect(r.orchestrator.mayPay(launch.launchId)).toBe(false);
    await r.orchestrator.resume(launch.launchId, launch.remainingMicros);
    await until(() => r.fileOf(launch.launchId).avatars[0]?.phase === "montage", "the montage");
  });
});
