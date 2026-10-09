import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetHoldDetail, MonthRoom } from "../../shared/autopilot/money";
import type { Estimate } from "../../shared/engine";
import type { LaunchView } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { Budget } from "../money/budget";
import { Ledger } from "../money/ledger";
import type { RunJobEnd } from "../runs/runJob";
import type { DrawSliceResult, SliceStatus } from "../sceneSets/launchDraw";
import { LaunchRegistry } from "../sceneSets/launchRegistry";
import { LaunchGroups } from "./groups";
import type { LaunchFile } from "./launchFile";
import { AUTOPILOT_DIR } from "./launchStore";
import { LaunchStores } from "./lookup";
import { Orchestrator } from "./orchestrator";
import { NOT_PAYABLE_DETAIL, type LaunchComposePayload, type LaunchSliceStart, type PaidPort } from "./paidPort";
import { createPaidSteps } from "./paidSteps";
import type { LaunchStepsContext } from "./steps";
import { A, B, startInput } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (plan §3.6, §4.3, §4.4, §18): the paid steps against a double of the engine, for the orders and races the real engine makes hard to hit: a soft stop that arrives
// while the step's own start has not returned, the slice sized only after the compose returned, the launch's own «Дописать» cap, and the holds of the paid path. The real engine,
// ledger and Budget group are in engine.autopilotPaid.test.ts.

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PHOTO = 210_000;
const WRITER = 37_500;
const BIG: MonthRoom = { budgetMicros: 1_000_000_000, committedMicros: 0, freeMicros: 1_000_000_000 };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** The engine, as far as the paid steps see it. Every method records its call; a method with no behaviour planted refuses, so a stray call fails the test. */
class FakePort implements PaidPort {
  readonly calls: string[] = [];
  readonly sets = new Map<string, StoredSceneSet>();
  unreadable = 0;
  budget: Budget | null;
  room: MonthRoom | null = BIG;
  photoWorst = PHOTO;
  /** Held open by a test to keep a draw between its price and its room. */
  photoGate: Promise<void> | null = null;
  /** Held open by a test to keep the set read of the pass pending. */
  readGate: Promise<void> | null = null;
  reads = 0;
  holdArgs: unknown[][] = [];
  // Planted behaviours.
  compose: ((payload: LaunchComposePayload, ids: { sceneSetId: string; runId: string }, launchId: string) => Promise<{ sceneSetId: string; jobId: string | null }>) | null = null;
  write: ((input: { sceneSetId: string; acceptedWorstMicros: number }) => Promise<{ jobId: string }>) | null = null;
  writeCost: ((sceneSetId: string) => number) | null = null;
  approve: ((sceneSetId: string) => Promise<StoredSceneSet>) | null = null;
  draw: ((input: { sceneSetId: string; size: number; drawMicros: number }) => Promise<DrawSliceResult>) | null = null;
  start: ((runId: string) => Promise<LaunchSliceStart>) | null = null;
  statuses = new Map<string, SliceStatus>();
  softScenes: (sceneSetId: string) => boolean = () => false;
  softRun: (runId: string) => boolean = () => false;
  idleSet: (sceneSetId: string) => Promise<void> = () => Promise.resolve();
  unlinked: string[] = [];
  unlinkError: Error | null = null;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  get library(): PaidPort["library"] {
    return {
      sceneSets: {
        get: async (_avatarId, sceneSetId) => {
          this.reads += 1;
          if (this.readGate !== null) await this.readGate;
          return this.sets.get(sceneSetId) ?? null;
        },
        list: async (avatarId) => ({ sets: [...this.sets.values()].filter((s) => s.avatarId === avatarId), unreadable: this.unreadable }),
      },
    };
  }

  #plain(name: string): never {
    this.calls.push(name);
    throw new Error(`unexpected call: ${name}`);
  }

  async composeLaunchSet(payload: LaunchComposePayload, launch: { ids: { sceneSetId: string; runId: string }; launchId: string }) {
    this.calls.push("composeLaunchSet");
    if (this.compose === null) return this.#plain("composeLaunchSet");
    const result = await this.compose(payload, launch.ids, launch.launchId);
    this.calls.push("composeLaunchSet:returned");
    return result;
  }

  async composeEstimate(_request: { avatarId: string; count: number }): Promise<Estimate> {
    this.calls.push("composeEstimate");
    return { expectedMicros: 0, worstMicros: 75_000, prices: "fallback", pricesAsOf: "2026-10-09" };
  }

  async writeEstimate(sceneSetId: string): Promise<Estimate> {
    this.calls.push("writeEstimate");
    const worst = this.writeCost === null ? WRITER * 2 : this.writeCost(sceneSetId);
    return { expectedMicros: 0, worstMicros: worst, prices: "fallback", pricesAsOf: "2026-10-09" };
  }

  async writeLaunchScenes(input: { sceneSetId: string; launchId: string; revision: number; acceptedWorstMicros: number }) {
    this.calls.push("writeLaunchScenes");
    if (this.write === null) return this.#plain("writeLaunchScenes");
    return this.write(input);
  }

  async approveLaunchSet(input: { sceneSetId: string }): Promise<StoredSceneSet> {
    this.calls.push("approveLaunchSet");
    if (this.approve === null) return this.#plain("approveLaunchSet");
    return this.approve(input.sceneSetId);
  }

  async drawLaunchSlice(input: { sceneSetId: string; launchId: string; size: number; drawMicros: number }): Promise<DrawSliceResult> {
    this.calls.push("drawLaunchSlice");
    if (this.draw === null) return this.#plain("drawLaunchSlice");
    return this.draw(input);
  }

  async startLaunchSlice(runId: string): Promise<LaunchSliceStart> {
    this.calls.push("startLaunchSlice");
    if (this.start === null) return this.#plain("startLaunchSlice");
    const result = await this.start(runId);
    this.calls.push("startLaunchSlice:returned");
    return result;
  }

  async sliceStatuses(): Promise<Map<string, SliceStatus>> {
    return new Map(this.statuses);
  }

  async photoWorstMicros(): Promise<number> {
    this.calls.push("photoWorstMicros");
    if (this.photoGate !== null) await this.photoGate;
    return this.photoWorst;
  }

  monthRoom(): MonthRoom | null {
    this.calls.push("monthRoom");
    return this.room;
  }

  async resumeSliceHold(runId: string, extraLive: readonly unknown[] = []): Promise<BudgetHoldDetail> {
    this.calls.push("resumeSliceHold");
    this.holdArgs.push([runId, extraLive]);
    return { kind: "resume-slice", freeMicros: 0, needMicros: 100_000 };
  }

  softStopScenes(sceneSetId: string): boolean {
    this.calls.push("softStopScenes");
    return this.softScenes(sceneSetId);
  }

  softStopRun(runId: string): boolean {
    this.calls.push("softStopRun");
    return this.softRun(runId);
  }

  whenSceneSetIdle(sceneSetId: string): Promise<void> {
    this.calls.push("whenSceneSetIdle");
    return this.idleSet(sceneSetId);
  }

  async unlinkLaunchSet(sceneSetId: string) {
    this.calls.push("unlinkLaunchSet");
    if (this.unlinkError !== null) throw this.unlinkError;
    this.unlinked.push(sceneSetId);
    return { phase: "awaiting" as const };
  }

  /** A set as a finished compose leaves it, linked to the launch. */
  seed(over: { sceneSetId: string; runId: string; avatarId?: string; launchId: string; count?: number; written?: number; draw?: { sceneIds: number[]; slices?: { runId: string; sceneIds: number[]; capMicros: number }[] } }): StoredSceneSet {
    const base = sampleSet({ sceneSetId: over.sceneSetId, runId: over.runId, avatarId: over.avatarId ?? A, count: over.count ?? 10, written: over.written ?? over.count ?? 10 });
    const set = {
      ...base,
      schemaVersion: 1,
      createdAt: "2026-10-09T10:00:00.000Z",
      updatedAt: "2026-10-09T10:00:00.000Z",
      revision: 1,
      launchId: over.launchId,
      ...(over.draw === undefined ? {} : { launchDraw: { launchId: over.launchId, sceneIds: over.draw.sceneIds, slices: over.draw.slices ?? [] } }),
    } as unknown as StoredSceneSet;
    this.sets.set(over.sceneSetId, set);
    return set;
  }
}

interface Rig {
  root: string;
  port: FakePort;
  steps: ReturnType<typeof createPaidSteps>;
  ctx(): LaunchStepsContext;
  orchestrator: Orchestrator;
  budget: Budget;
  groups: LaunchGroups;
  fileOf(launchId: string): LaunchFile;
  start(draft?: Parameters<typeof startInput>[0]): Promise<LaunchView>;
  settle(setId: string, attempt: string, cost: number, worst?: number): Promise<void>;
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "studio-paid-steps-"));
  roots.push(root);
  const libraryRoot = join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  const groups = new LaunchGroups();
  const ledger = await Ledger.open(join(root, "ledger.jsonl"));
  const budget = new Budget(ledger, { runCapMicros: () => 1_000_000_000, groupOf: (req) => groups.groupOf(req), monthlyBudgetMicros: 1_000_000_000, clock: () => T0, monotonic: () => 0 });
  const stores = new LaunchStores();
  const port = new FakePort(budget);
  const steps = createPaidSteps({ port: () => port, retryMs: 5, warn: () => undefined });
  let captured: LaunchStepsContext | null = null;
  const begin = steps.begin.bind(steps);
  steps.begin = (ctx) => {
    captured = ctx;
    begin(ctx);
  };
  let n = 0;
  const orchestrator = new Orchestrator({
    stores,
    groups,
    registry: new LaunchRegistry(stores),
    steps,
    clock: () => T0,
    newId: () => `orch-${String(++n).padStart(4, "0")}`,
    budget: () => budget,
    admission: () => null,
    keyState: () => "ok",
    roomFreeMicros: () => 1_000_000_000,
    emit: () => undefined,
    degrade: () => undefined,
    coalesce: { intervalMs: 0 },
    warn: () => undefined,
  });
  const library = { root: libraryRoot, sceneSets: { list: async () => ({ sets: [], unreadable: 0 }) } };
  orchestrator.adopt(library, await orchestrator.prepare(library));
  return {
    root,
    port,
    orchestrator,
    steps,
    ctx: () => {
      if (captured === null) throw new Error("begin was not called");
      return captured;
    },
    budget,
    groups,
    fileOf: (launchId) => JSON.parse(readFileSync(join(libraryRoot, AUTOPILOT_DIR, `${launchId}.json`), "utf8")) as LaunchFile,
    start: (draft) => orchestrator.start(startInput(draft), library),
    settle: async (setId, attempt, cost, worst = WRITER) => {
      const reserved = await budget.tryReserve({ attemptId: `${setId}:${attempt}`, jobId: "job-fixture-0001", scope: { avatarJobId: "job-fixture-0001" }, model: "x-ai/grok-4.3", worstMicros: worst });
      if (!reserved.ok) throw new Error(`the reserve was refused: ${reserved.reason}`);
      await budget.settle(reserved.handle, { costMicros: cost, estimated: false });
    },
  };
}


/** The ids `autopilot.start` issues in this rig (the orchestrator's newId runs launch, then each generating avatar's set and run). */
const LAUNCH = "launch-orch-0001";
const SET1 = "orch-0002";
const RUN1 = "orch-0003";
const SET2 = "orch-0004";
const RUN2 = "orch-0005";
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** A compose that writes the set and answers at once. */
const composes = (port: FakePort, launchId: string, count = 10) => async (_payload: LaunchComposePayload, ids: { sceneSetId: string; runId: string }) => {
  port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId, count });
  return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
};

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
