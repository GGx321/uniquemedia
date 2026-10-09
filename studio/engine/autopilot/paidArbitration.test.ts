import { afterEach, describe, expect, test } from "bun:test";
import type { PaidHold } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import type { RunJobEnd } from "../runs/runJob";
import { A, ALL, B, cleanupRigs, deferred, FakeTimers, idle, LAUNCH, PHOTO, RUN1, RUN2, rig, SET1, SET2, until, type Rig } from "./testing/paidRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b2 fix round 1: the paid steps share ONE hold and ONE retry timer per launch, so who writes the hold and whose timer fires must be decided atomically and by rank. These are the
// reviewer's reproductions as tests, on a clock that moves (a frozen clock hid every one of them). A «for a human» hold (credits, key, halt, budget, price, a network hold with no retry) displaces
// a waiting one (a retry still to come) and takes its timer; a waiting one never displaces a human one; every drop is counted in its own job whatever hold stands.

afterEach(cleanupRigs);
const MIN = 60_000;

/** Fake timers that count the retry timers (a minute or more) ever armed, so a test can wait for the end of a drop instead of for a quiet period. */
class ArmCounting extends FakeTimers {
  armed = 0;
  override set(run: () => void, ms: number): number {
    if (ms >= MIN) this.armed += 1;
    return super.set(run, ms);
  }
}
const drop: RunJobEnd = { status: "failed", error: { code: "NETWORK", detail: "fetch failed" } };

/** Avatar A has a drawn slice (RUN1) whose end the test controls; avatar B's compose stopped on a drop once `idleB` opens. */
async function twoJobs(timers: FakeTimers, steps: Parameters<typeof rig>[0] = {}) {
  const r = await rig({ steps: { timers, clock: timers.clock, ...steps.steps } });
  const endA = deferred<RunJobEnd>();
  const idleB = deferred();
  const seen = { startsA: 0, writesB: 0 };
  r.port.compose = async (_payload, ids) => {
    if (ids.sceneSetId === SET1) r.port.seed({ sceneSetId: SET1, runId: ids.runId, avatarId: A, launchId: LAUNCH });
    else {
      const set = r.port.seed({ sceneSetId: SET2, runId: ids.runId, avatarId: B, launchId: LAUNCH, written: 0 });
      r.port.sets.set(SET2, { ...set, write: { k: 1, kind: "compose", jobId: "job-compose-0002", stoppedBy: "failed", stoppedError: { code: "NETWORK", detail: "fetch failed" } } } as typeof set);
    }
    return { sceneSetId: ids.sceneSetId, jobId: "job-compose" };
  };
  r.port.idleSet = (setId) => (setId === SET2 ? idleB.promise : Promise.resolve());
  r.port.write = async () => {
    seen.writesB += 1;
    return { jobId: "job-write" };
  };
  r.port.approve = async (setId) => r.port.seed({ sceneSetId: setId, runId: RUN1, avatarId: A, launchId: LAUNCH, draw: { sceneIds: ALL } });
  r.port.draw = async () => {
    r.port.seed({ sceneSetId: SET1, runId: RUN1, avatarId: A, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
    r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
    return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 };
  };
  r.port.start = async () => {
    seen.startsA += 1;
    if (seen.startsA === 1) return { kind: "started", jobId: "job-run-1", ended: endA.promise };
    return { kind: "started", jobId: "job-run-2", ended: new Promise<RunJobEnd>(() => undefined) };
  };
  const launch = await r.start({ avatarIds: [A, B], sceneReview: false });
  await until(() => seen.startsA === 1 && r.port.calls.filter((c) => c === "whenSceneSetIdle").length >= 2, "both jobs in flight");
  return { r, launch, endA, idleB, seen };
}

const holdDetail = (r: Rig): { drops?: number; nextAt?: string | null } | undefined => r.ctx().file().paidHold?.detail as { drops?: number; nextAt?: string | null } | undefined;

describe("one hold, one timer: who wins is decided in the file's own write, by rank", () => {
  test("H1: a slice's THIRD drop that lands while another job's retry hold is up is counted, takes the hold for a person and the other job's timer with it", async () => {
    const timers = new FakeTimers();
    const { r, launch, endA, idleB, seen } = await twoJobs(timers);
    // A's slice has already dropped twice and used both automatic continues.
    await r.ctx().update((f) => ({ ...f, autoContinues: { [RUN1]: { drops: 2, continues: 2 } } }));
    idleB.resolve();
    await until(() => r.ctx().file().paidHold?.reason === "network" && timers.pending() === 1, "B's retry hold");
    expect(holdDetail(r)?.nextAt).not.toBeNull();
    endA.resolve(drop);
    await until(() => holdDetail(r)?.nextAt === null, "the hold for a person");
    expect(holdDetail(r)?.drops).toBe(3);
    expect(r.fileOf(launch.launchId).autoContinues?.[RUN1]).toEqual({ drops: 3, continues: 2 });
    await until(() => timers.pending() === 0, "B's timer taken back");
    timers.advance(10 * MIN);
    await idle();
    expect(seen.startsA).toBe(1);
    expect(r.ctx().file().paidHold).not.toBeNull();
  });

  test("a waiting hold never displaces a hold for a person: credits stay up when a later job drops, and the drop is still counted", async () => {
    const timers = new FakeTimers();
    const { r, launch, idleB } = await twoJobs(timers);
    await r.ctx().raisePaidHold({ reason: "credits", at: timers.iso(), detail: {} });
    idleB.resolve();
    await until(() => r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`] !== undefined, "B's drop counted");
    await idle();
    expect(r.ctx().file().paidHold?.reason).toBe("credits");
    expect(timers.pending()).toBe(0);
    // The person has not been asked for a wait it did not get: the drop is a drop, the continue was not spent.
    expect(r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`]).toEqual({ drops: 1, continues: 0 });
  });

  test("a hold for a person from a second task displaces a waiting hold and cancels its timer", async () => {
    const timers = new FakeTimers();
    const { r, idleB, endA, seen } = await twoJobs(timers);
    idleB.resolve();
    await until(() => r.ctx().file().paidHold?.reason === "network" && timers.pending() === 1, "B's retry hold");
    endA.resolve({ status: "failed", error: { code: "AUTH_INVALID", detail: "rejected" } });
    await until(() => r.ctx().file().paidHold?.reason === "key", "the key hold");
    expect(r.ctx().file().paidHold?.reason).toBe("key");
    await until(() => timers.pending() === 0, "the displaced hold's timer taken back");
    timers.advance(10 * MIN);
    await idle();
    expect(seen.writesB).toBe(0);
    expect(r.ctx().file().paidHold?.reason).toBe("key");
  });

  test("H2: B's drop lands while A's retry hold is being written, on a clock that moves: the hold that stands has the timer that fires, and the launch goes on", async () => {
    const hook = { fire: (): void => undefined };
    class Hooked extends ArmCounting {
      override set(run: () => void, ms: number): number {
        const id = super.set(run, ms);
        // B's drop lands the moment the first retry timer is armed, i.e. while that hold is being written.
        if (ms >= MIN && this.armed === 1) hook.fire();
        return id;
      }
    }
    const timers = new Hooked();
    const setup = await twoJobs(timers);
    hook.fire = () => setup.idleB.resolve();
    // B's restart after the hold must not fail again: its write reseeds the set without the stop it was left with (the test is about the timers of the FIRST two drops).
    const countedWrite = setup.r.port.write;
    setup.r.port.write = async (input) => {
      setup.r.port.seed({ sceneSetId: SET2, runId: RUN2, avatarId: B, launchId: LAUNCH });
      return countedWrite === null ? { jobId: "job-write" } : countedWrite(input);
    };
    setup.endA.resolve(drop);
    await until(() => setup.r.ctx().file().paidHold?.reason === "network", "a network hold");
    // Wait for B's drop to END (its observable: both timers were armed, B's drop is counted, and the loser's timer is taken back), not for a quiet period that a loaded machine can outlast.
    await until(
      () => timers.armed === 2 && timers.pending() === 1 && setup.r.ctx().file().autoContinues?.[`${SET2}:scenes`]?.drops === 1,
      "B's drop to end with its timer taken back",
    );
    expect(timers.pending()).toBe(1);
    timers.advance(10 * MIN);
    await until(() => setup.r.ctx().file().paidHold === null, "the hold cleared by the timer that belongs to it");
    await until(() => setup.seen.startsA >= 2 && setup.seen.writesB >= 1, "both jobs started again");
    // Every armed timer belongs to a standing waiting hold: with no hold standing none is armed.
    await until(() => timers.pending() === 0, "no timer left armed", 1_000);
    expect(setup.r.ctx().file().paidHold).toBeNull();
  });

  test("two concurrent drops on a moving clock: exactly one hold, exactly one timer, and it is the hold's own", async () => {
    const timers = new ArmCounting();
    const { r, endA, idleB } = await twoJobs(timers);
    endA.resolve(drop);
    idleB.resolve();
    await until(() => r.ctx().file().paidHold?.reason === "network", "a hold");
    // Wait for both drops to END (both timers were armed, the loser's is taken back, both drops are counted), not for a quiet period that a loaded machine can outlast.
    await until(
      () => timers.armed === 2 && timers.pending() === 1 && r.ctx().file().autoContinues?.[RUN1]?.drops === 1 && r.ctx().file().autoContinues?.[`${SET2}:scenes`]?.drops === 1,
      "both drops to end with one timer left",
    );
    expect(timers.pending()).toBe(1);
    const nextAt = holdDetail(r)?.nextAt;
    expect(nextAt).toBeDefined();
    timers.advance(Date.parse(nextAt ?? "") - timers.now + 1);
    await until(() => r.ctx().file().paidHold === null, "the hold cleared");
  });
});

describe("one scene step is one job for the automatic continues (M4)", () => {
  test("a compose and the «Дописать» that continues it share two continues, not three", async () => {
    const timers = new FakeTimers();
    const r = await rig({ steps: { timers, clock: timers.clock } });
    r.port.compose = async (_p, ids) => {
      const set = r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH, written: 0 });
      r.port.sets.set(SET1, { ...set, write: { k: 1, kind: "compose", jobId: "job", stoppedBy: "failed", stoppedError: { code: "NETWORK", detail: "fetch failed" } } } as typeof set);
      return { sceneSetId: ids.sceneSetId, jobId: "job-compose" };
    };
    r.port.write = async () => ({ jobId: "job-write" });
    const launch = await r.start({ sceneReview: false });
    for (let i = 0; i < 6; i++) {
      await until(() => r.ctx().file().paidHold?.reason === "network" && (holdDetail(r)?.nextAt === null || timers.pending() === 1), "a hold");
      if (holdDetail(r)?.nextAt === null) break;
      timers.advance(10 * MIN);
      await idle();
    }
    const log = (await r.orchestrator.get(launch.launchId)).log;
    expect(log.filter((l) => l.kind === "network-retry")).toHaveLength(2);
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [`${SET1}:scenes`]: { drops: 3, continues: 2 } });
  });
});

describe("a wake-up re-arms or fires the wait it interrupted (M1)", () => {
  async function waiting(timers: FakeTimers) {
    const r = await rig({ steps: { timers, clock: timers.clock } });
    let starts = 0;
    r.port.compose = async (_p, ids) => {
      r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH });
      return { sceneSetId: ids.sceneSetId, jobId: "j" };
    };
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
      r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
      return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 };
    };
    r.port.start = async () => {
      starts += 1;
      return { kind: "started", jobId: "j", ended: Promise.resolve(drop) };
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => r.ctx().file().paidHold?.reason === "network" && timers.pending() === 1, "hold 1");
    timers.advance(MIN);
    await until(() => holdDetail(r)?.drops === 2 && timers.pending() === 1, "hold 2 (a five-minute wait)");
    return { r, launch, starts: () => starts };
  }

  test("a wake-up one second into a five-minute wait does not clear it: the wait is re-armed for the remainder, and fires when it is up", async () => {
    const timers = new FakeTimers();
    const w = await waiting(timers);
    const before = w.starts();
    await w.r.orchestrator.power("suspend");
    timers.advance(1_000);
    await w.r.orchestrator.power("resume");
    await w.r.orchestrator.settled();
    await idle();
    expect(w.starts()).toBe(before);
    expect(w.r.ctx().file().paidHold).not.toBeNull();
    expect(timers.pending()).toBe(1);
    timers.advance(5 * MIN - 1_000);
    await until(() => w.starts() > before, "the start after the remainder");
  });

  test("a wake-up after the wait was due goes through the same check as the timer: with the ledger closed the wait ends and a person decides", async () => {
    const timers = new FakeTimers();
    const w = await waiting(timers);
    const before = w.starts();
    await w.r.orchestrator.power("suspend");
    timers.advance(10 * MIN);
    w.r.port.admit = false;
    await w.r.orchestrator.power("resume");
    await w.r.orchestrator.settled();
    await until(() => holdDetail(w.r)?.nextAt === null, "the hold for a person");
    expect(w.starts()).toBe(before);
    expect(timers.pending()).toBe(0);
  });

  test("a wake-up after the wait was due, ledger open: the hold is cleared and the slice goes on", async () => {
    const timers = new FakeTimers();
    const w = await waiting(timers);
    const before = w.starts();
    await w.r.orchestrator.power("suspend");
    timers.advance(10 * MIN);
    await w.r.orchestrator.power("resume");
    await w.r.orchestrator.settled();
    await until(() => w.starts() > before, "the start");
  });

  test("a wake-up never clears a waiting hold without asking the admission rule", async () => {
    const timers = new FakeTimers();
    const w = await waiting(timers);
    await w.r.orchestrator.power("suspend");
    timers.advance(10 * MIN);
    w.r.port.admit = false;
    w.r.port.calls.length = 0;
    await w.r.orchestrator.power("resume");
    await w.r.orchestrator.settled();
    expect(w.r.port.calls).toContain("admitted");
    expect(w.r.ctx().file().paidHold).not.toBeNull();
  });
});

describe("the owner's click proves the Mac is awake (M3)", () => {
  test("«Продолжить» on a launch that runs with no hold, after a lost wake-up, is accepted as the wake-up", async () => {
    const r = await rig();
    r.port.compose = async (_p, ids) => {
      r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH });
      return { sceneSetId: ids.sceneSetId, jobId: "j" };
    };
    const gate = deferred();
    r.port.approve = async () => {
      await gate.promise;
      return r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("approveLaunchSet"), "approve");
    await r.orchestrator.power("suspend");
    expect(r.orchestrator.mayPay(launch.launchId)).toBe(false);
    const view = await r.orchestrator.resume(launch.launchId, launch.remainingMicros);
    expect(view.status).toBe("running");
    expect(r.orchestrator.mayPay(launch.launchId)).toBe(true);
    gate.resolve();
    await idle();
  });

  test("«Продолжить» on a launch that runs, was not asleep and has no hold is still refused", async () => {
    const r = await rig();
    r.port.compose = async (_p, ids) => {
      r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH });
      return { sceneSetId: ids.sceneSetId, jobId: "j" };
    };
    const gate = deferred();
    r.port.approve = async () => {
      await gate.promise;
      return r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => r.port.calls.includes("approveLaunchSet"), "approve");
    await expect(r.orchestrator.resume(launch.launchId, launch.remainingMicros)).rejects.toBeInstanceOf(EngineFailure);
    gate.resolve();
    await idle();
  });
});

describe("RECONCILE_REQUIRED does not invent a drop (L4)", () => {
  test("a job that meets it counts one drop of its own, like any request that was not answered", async () => {
    const r = await rig();
    r.port.compose = async (_p, ids) => {
      r.port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId: LAUNCH });
      return { sceneSetId: ids.sceneSetId, jobId: "j" };
    };
    r.port.approve = async () => r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL } });
    r.port.draw = async () => {
      r.port.seed({ sceneSetId: SET1, runId: RUN1, launchId: LAUNCH, draw: { sceneIds: ALL, slices: [{ runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 }] } });
      r.port.statuses.set(RUN1, { finished: false, openSlots: 10 });
      return { kind: "drawn", created: true, runId: RUN1, sceneIds: ALL, capMicros: PHOTO * 10 };
    };
    r.port.start = async () => {
      throw new EngineFailure({ code: "RECONCILE_REQUIRED", detail: "1 open attempt(s)" });
    };
    const launch = await r.start({ sceneReview: false });
    await until(() => r.ctx().file().paidHold?.reason === "network", "the hold");
    expect(r.fileOf(launch.launchId).autoContinues).toEqual({ [RUN1]: { drops: 1, continues: 0 } });
    expect(holdDetail(r)).toMatchObject({ drops: 1, nextAt: null });
  });
});

describe("a job's third drop still demands «Сверка» under another task's hold for a person (A19, M-R1)", () => {
  test.each(["credits", "key", "price", "budget", "price-unavailable"] as const)(
    "%s stands first: B's third drop raises the network hold with no retry over it, «Продолжить» is refused until a reconcile, and B's paid «Дописать» is not sent",
    async (first) => {
      const timers = new FakeTimers();
      const { r, launch, idleB, seen } = await twoJobs(timers);
      r.port.writeCost = () => 1_000;
      // B's scene step has already dropped twice and used both continues; its drops left a writer reserve open in the launch's group.
      await r.ctx().update((f) => ({ ...f, autoContinues: { [`${SET2}:scenes`]: { drops: 2, continues: 2 } } }));
      const reserved = await r.budget.tryReserve({ attemptId: `${SET2}:writer-1#1`, jobId: "job-compose-0002", scope: { avatarJobId: "job-compose-0002" }, model: "x-ai/grok-4.3", worstMicros: 37_500 });
      if (!reserved.ok) throw new Error(`reserve refused: ${reserved.reason}`);
      const standing: PaidHold =
        first === "price"
          ? ({ reason: "price", at: timers.iso(), detail: { stage: "slice", fromPhotos: 10, toPhotos: 0 } } as const)
          : first === "budget"
            ? ({ reason: "budget", at: timers.iso(), detail: { freeMicros: 0, needMicros: 210_000, kind: "new-slice" } } as const)
            : first === "price-unavailable"
              ? ({ reason: "price-unavailable", at: timers.iso(), detail: { attempt: 3, nextAt: null } } as const)
              : ({ reason: first, at: timers.iso(), detail: {} } as const);
      await r.ctx().raisePaidHold(standing);
      idleB.resolve();
      await until(() => r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`]?.drops === 3, "B's third drop counted");
      await until(() => r.ctx().file().paidHold?.reason === "network", "the network hold with no retry");
      expect(holdDetail(r)).toMatchObject({ drops: 3, nextAt: null });
      expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBe("network");
      await expect(r.orchestrator.resume(launch.launchId, 10_000_000_000)).rejects.toBeInstanceOf(EngineFailure);
      await idle();
      expect(seen.writesB).toBe(0);
    },
  );

  test("halt stands above everything: B's third drop does not displace it, and the click stays refused by the halt", async () => {
    const timers = new FakeTimers();
    const { r, launch, idleB } = await twoJobs(timers);
    await r.ctx().update((f) => ({ ...f, autoContinues: { [`${SET2}:scenes`]: { drops: 2, continues: 2 } } }));
    await r.ctx().raisePaidHold({ reason: "halt", at: timers.iso(), detail: { code: "SETTLE_ABOVE_WORST" } });
    idleB.resolve();
    await until(() => r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`]?.drops === 3, "B's third drop counted");
    await idle();
    expect(r.ctx().file().paidHold?.reason).toBe("halt");
  });

  test("the network hold with no retry displaces nothing above it: internal stays", async () => {
    const timers = new FakeTimers();
    const { r } = await twoJobs(timers);
    await r.ctx().raisePaidHold({ reason: "internal", at: timers.iso(), detail: { kind: "allocation-exceeded" } });
    const won = await r.ctx().raisePaidHold({ reason: "network", at: timers.iso(), detail: { drops: 3, attempt: 2, nextAt: null } });
    expect(won.won).toBe(false);
  });
});

// S4.6r fix round 1 (A19): a failed job's `internal` hold is cleared by the click, so it ranks with the holds a click clears (1) and never hides a network hold that needs a reconcile.
describe("a failed job's internal hold never hides a network hold that needs a reconcile (A19, S4.6r)", () => {
  const internalEnd: RunJobEnd = { status: "failed", error: { code: "INTERNAL", detail: "the master photo could not be prepared" } };

  async function withOpenReserve() {
    const timers = new FakeTimers();
    const two = await twoJobs(timers);
    two.r.port.writeCost = () => 1_000;
    // B's scene step has already dropped twice and used both continues; its drops left a writer reserve open in the launch's group.
    await two.r.ctx().update((f) => ({ ...f, autoContinues: { [`${SET2}:scenes`]: { drops: 2, continues: 2 } } }));
    const reserved = await two.r.budget.tryReserve({ attemptId: `${SET2}:writer-1#1`, jobId: "job-compose-0002", scope: { avatarJobId: "job-compose-0002" }, model: "x-ai/grok-4.3", worstMicros: 37_500 });
    if (!reserved.ok) throw new Error(`reserve refused: ${reserved.reason}`);
    return two;
  }

  test("the network hold with no retry stands first; A's job then fails INTERNAL: the network hold stays, «Продолжить» is refused until a reconcile", async () => {
    const { r, launch, endA, idleB } = await withOpenReserve();
    idleB.resolve();
    await until(() => r.ctx().file().paidHold?.reason === "network" && holdDetail(r)?.nextAt === null, "the network hold with no retry");
    endA.resolve(internalEnd);
    await idle();
    expect(r.ctx().file().paidHold?.reason).toBe("network");
    expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBe("network");
    await expect(r.orchestrator.resume(launch.launchId, 10_000_000_000)).rejects.toBeInstanceOf(EngineFailure);
  });

  test("the failed job's hold stands first; B's third drop then takes the hold over: «Продолжить» is refused until a reconcile", async () => {
    const { r, launch, endA, idleB } = await withOpenReserve();
    endA.resolve(internalEnd);
    await until(() => r.ctx().file().paidHold?.reason === "internal", "the failed job's hold");
    expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBeNull();
    idleB.resolve();
    await until(() => r.ctx().file().paidHold?.reason === "network", "the network hold over it");
    expect(holdDetail(r)).toMatchObject({ drops: 3, nextAt: null });
    expect((await r.orchestrator.get(launch.launchId)).launch.resumeBlockedBy).toBe("network");
    await expect(r.orchestrator.resume(launch.launchId, 10_000_000_000)).rejects.toBeInstanceOf(EngineFailure);
  });

});

describe("the third drop is the third drop, whoever held the launch when the first one landed (M-R2)", () => {
  test("drop 1 under credits, then «Продолжить»: drop 2 waits one minute, drop 3 is the hold with no retry — not drop 4", async () => {
    const timers = new FakeTimers();
    const { r, launch, idleB, seen } = await twoJobs(timers);
    await r.ctx().raisePaidHold({ reason: "credits", at: timers.iso(), detail: {} });
    idleB.resolve();
    await until(() => r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`]?.drops === 1, "drop 1 under credits");
    // Under a hold for a person no wait could serve the drop: it is counted, no continue is spent.
    expect(r.fileOf(launch.launchId).autoContinues?.[`${SET2}:scenes`]).toEqual({ drops: 1, continues: 0 });
    await idle();
    await r.orchestrator.resume(launch.launchId, 10_000_000_000);
    await until(() => holdDetail(r)?.drops === 2 && timers.pending() === 1, "drop 2 and its wait");
    expect(holdDetail(r)?.nextAt).not.toBeNull();
    timers.advance(10 * MIN);
    await until(() => holdDetail(r)?.drops === 3 && r.ctx().file().paidHold?.reason === "network", "drop 3");
    expect(holdDetail(r)?.nextAt).toBeNull();
    expect(timers.pending()).toBe(0);
    const writes = seen.writesB;
    timers.advance(60 * MIN);
    await idle();
    expect(seen.writesB).toBe(writes);
  });
});
