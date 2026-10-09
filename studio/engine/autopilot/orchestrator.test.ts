import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineError } from "../../shared/engine";
import { LaunchView, type LaunchDraft } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import { Budget } from "../money/budget";
import { Ledger } from "../money/ledger";
import { LaunchRegistry } from "../sceneSets/launchRegistry";
import { LaunchGroups, launchGroupKey } from "./groups";
import type { LaunchFile } from "./launchFile";
import { AUTOPILOT_DIR } from "./launchStore";
import { LaunchStores, type LaunchStoresDeps } from "./lookup";
import { Orchestrator, type Admission, type ListedSet, type OrchestratorDeps } from "./orchestrator";
import { deferred, FakeSteps } from "./testing/fakeSteps";
import { startInput } from "./testing/launchFixtures";
import { composeSteps } from "./stepsComposer";
import type { LaunchStepsContext } from "./steps";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §3.5–§3.8, §4.1, §4.6, §18, §19; invariants A5, A12, A13, A19): the orchestrator core over a real launch store, real groups and a real ledger, with the
// steps replaced by a double. The state machine's table is in states.test.ts; here the commands, the persisted order of events, restart, the admission rule and the events.

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const AT = "2026-10-09T10:05:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Rig {
  root: string;
  libraryRoot: string;
  orchestrator: Orchestrator;
  steps: FakeSteps;
  stores: LaunchStores;
  groups: LaunchGroups;
  budget: Budget;
  emitted: LaunchView[];
  sets: ListedSet[];
  state: { now: number; admission: Admission | null; key: "ok" | "missing" | "rejected"; room: number | null; degraded: number };
  unreadableSets: Set<string>;
  library: { root: string; sceneSets: { list(avatarId: string): Promise<{ sets: readonly ListedSet[]; unreadable: number }> } };
  adopt(): Promise<void>;
  pathOf(launchId: string): string;
  fileOf(launchId: string): LaunchFile;
  start(draft?: Partial<LaunchDraft>, accepted?: number): Promise<LaunchView>;
}

async function rig(opts: { root?: string; deps?: Partial<OrchestratorDeps>; storeDeps?: LaunchStoresDeps } = {}): Promise<Rig> {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "studio-orchestrator-")));
  if (opts.root === undefined) roots.push(root);
  const libraryRoot = join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  const groups = new LaunchGroups();
  const ledger = await Ledger.open(join(root, "ledger.jsonl"));
  const budget = new Budget(ledger, { runCapMicros: () => 1_000_000_000, groupOf: (req) => groups.groupOf(req), monthlyBudgetMicros: 1_000_000_000, clock: () => T0, monotonic: () => 0 });
  const stores = new LaunchStores(opts.storeDeps);
  const registry = new LaunchRegistry(stores);
  const steps = new FakeSteps();
  const emitted: LaunchView[] = [];
  const state: Rig["state"] = { now: T0, admission: null, key: "ok", room: 1_000_000_000, degraded: 0 };
  let n = 0;
  const orchestrator = new Orchestrator({
    stores,
    groups,
    registry,
    steps,
    clock: () => state.now,
    newId: () => `orch-${String(++n).padStart(4, "0")}`,
    budget: () => budget,
    admission: () => state.admission,
    keyState: () => state.key,
    roomFreeMicros: () => state.room,
    emit: (launch) => emitted.push(launch),
    degrade: () => {
      state.degraded += 1;
    },
    // Every change goes out at once unless a test says otherwise.
    coalesce: { intervalMs: 0 },
    warn: () => undefined,
    ...opts.deps,
  });
  const sets: ListedSet[] = [];
  const unreadableSets = new Set<string>();
  const library = { root: libraryRoot, sceneSets: { list: async (avatarId: string) => ({ sets, unreadable: unreadableSets.has(avatarId) ? 1 : 0 }) } };
  const r: Rig = {
    root,
    libraryRoot,
    orchestrator,
    steps,
    stores,
    groups,
    budget,
    emitted,
    sets,
    unreadableSets,
    state,
    library,
    adopt: async () => orchestrator.adopt(library, await orchestrator.prepare(library)),
    pathOf: (launchId) => join(libraryRoot, AUTOPILOT_DIR, `${launchId}.json`),
    fileOf: (launchId) => JSON.parse(readFileSync(join(libraryRoot, AUTOPILOT_DIR, `${launchId}.json`), "utf8")) as LaunchFile,
    start: (draft, accepted) => orchestrator.start(startInput(draft, accepted), library),
  };
  await r.adopt();
  return r;
}

/** Spends `cost` of the launch's group: a writer attempt of its set, reserved and settled through the real Budget. */
async function spend(r: Rig, launch: LaunchView, cost: number, attempt = "writer-1#1"): Promise<void> {
  const setId = r.fileOf(launch.launchId).avatars[0]?.generation?.sceneSetId ?? "";
  const reserved = await r.budget.tryReserve({ attemptId: `${setId}:${attempt}`, jobId: "job-fixture-0001", scope: { runId: "run-fixture-0001" }, model: "x-ai/grok-4.3", worstMicros: cost });
  if (!reserved.ok) throw new Error(`the reserve was refused: ${reserved.reason}`);
  await r.budget.settle(reserved.handle, { costMicros: cost, estimated: false });
}

async function openReserve(r: Rig, launch: LaunchView, worst: number, attempt = "writer-1#2"): Promise<void> {
  const setId = r.fileOf(launch.launchId).avatars[0]?.generation?.sceneSetId ?? "";
  const reserved = await r.budget.tryReserve({ attemptId: `${setId}:${attempt}`, jobId: "job-fixture-0001", scope: { runId: "run-fixture-0001" }, model: "x-ai/grok-4.3", worstMicros: worst });
  if (!reserved.ok) throw new Error(`the reserve was refused: ${reserved.reason}`);
}

async function failure(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const RECONCILE: Admission = { blockedBy: "reconcile-required", error: { code: "RECONCILE_REQUIRED", detail: "1 open attempt(s); reconcile before any paid call" } };

// ---------- start ----------

describe("autopilot.start", () => {
  test("writes the launch file with the ids and the allocations, and registers the Budget group, BEFORE the steps begin (A4, A13)", async () => {
    const r = await rig();
    const seen: { file: boolean; group: string | null; status: string | null } = { file: false, group: null, status: null };
    r.steps.onBegin = (ctx) => {
      const id = ctx.launchId;
      seen.file = existsSync(r.pathOf(id));
      seen.status = r.fileOf(id).status;
      const setId = ctx.file().avatars[0]?.generation?.sceneSetId ?? "";
      seen.group = r.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.key ?? null;
    };
    const view = await r.start();
    expect(seen).toEqual({ file: true, group: launchGroupKey(view.launchId), status: "running" });
    const file = r.fileOf(view.launchId);
    expect(file.revision).toBe(1);
    expect(file.avatars[0]?.generation).toMatchObject({ sceneSetId: "orch-0002", setRunId: "orch-0003" });
    expect(file.avatars[0]?.allocation.drawMicros).toBeGreaterThan(0);
  });

  test("the group's cap is W′, and a slice run of the launch is added to it by the steps", async () => {
    const r = await rig();
    const view = await r.start();
    const setId = r.fileOf(view.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    expect(r.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })).toEqual({ key: launchGroupKey(view.launchId), capMicros: view.plannedWorstMicros });
  });

  test("answers the running launch, whole and valid, and the snapshot shows it", async () => {
    const r = await rig();
    const view = await r.start();
    expect(LaunchView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ status: "running", paused: null, spentMicros: 0, remainingMicros: view.plannedWorstMicros, acceptedMicros: 20_000_000 });
    expect(r.orchestrator.snapshotView()).toEqual(view);
    expect(r.steps.calls).toEqual(["begin"]);
  });

  test("the launch id is launch- and the engine's own id; the start log line is in the tail", async () => {
    const r = await rig();
    const view = await r.start();
    expect(view.launchId).toBe("launch-orch-0001");
    expect(view.logTail).toEqual([{ at: new Date(T0).toISOString(), kind: "start", acceptedMicros: 20_000_000 }]);
  });

  test("a launch is unfinished until it ends: a second start is IN_FLIGHT and writes nothing (A12)", async () => {
    const r = await rig();
    await r.start();
    expect((await failure(r.start())).code).toBe("IN_FLIGHT");
    await r.orchestrator.pause("launch-orch-0001");
    expect((await failure(r.start())).code).toBe("IN_FLIGHT");
    expect(r.steps.calls.filter((c) => c === "begin")).toHaveLength(1);
  });

  test("an unreadable entry blocks a start: VALIDATION launch-unreadable, nothing written, the steps not begun", async () => {
    const r = await rig();
    await mkdir(join(r.libraryRoot, AUTOPILOT_DIR), { recursive: true });
    await writeFile(join(r.libraryRoot, AUTOPILOT_DIR, "launch-broken-0001.json"), "{not json");
    const error = await failure(r.start());
    expect(error).toMatchObject({ code: "VALIDATION", launchReason: "launch-unreadable" });
    expect(r.steps.calls).toEqual([]);
    expect(existsSync(r.pathOf("launch-orch-0001"))).toBe(false);
  });

  test("after the launch is stopped a new one can start (A12: one at a time, not one ever)", async () => {
    const r = await rig();
    const first = await r.start();
    await r.orchestrator.stop(first.launchId);
    const second = await r.start();
    expect(second.launchId).not.toBe(first.launchId);
  });

  test("a library-only launch has no ids to issue and a worst case of zero", async () => {
    const r = await rig();
    const view = await r.start({ library: true, generate: false });
    expect(view.plannedWorstMicros).toBe(0);
    expect(r.fileOf(view.launchId).avatars[0]?.generation).toBeNull();
  });

  test("startBlockers says what the start would be refused for", async () => {
    const r = await rig();
    expect(await r.orchestrator.startBlockers()).toEqual({ active: false, unreadable: false });
    await r.start();
    expect(await r.orchestrator.startBlockers()).toEqual({ active: true, unreadable: false });
  });
});

// ---------- pause ----------

describe("autopilot.pause", () => {
  test("with nothing in flight the launch is paused at once: persisted, the clock stopped, the soft stop asked for once", async () => {
    const r = await rig();
    const started = await r.start();
    r.state.now = T0 + 90_000;
    const view = await r.orchestrator.pause(started.launchId);
    expect(view).toMatchObject({ status: "paused", paused: { cause: "owner", at: new Date(T0 + 90_000).toISOString() }, activeMs: 90_000 });
    expect(r.fileOf(started.launchId)).toMatchObject({ status: "paused", activeMs: 90_000, activeSince: null, paused: { cause: "owner" } });
    expect(r.steps.calls).toEqual(["begin", "drain"]);
    expect(view.logTail.map((l) => l.kind)).toEqual(["start", "pausing", "paused"]);
  });

  test("with requests in flight it answers «pausing» at once, writes nothing yet, and pauses when the drain ends", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 2, renders: 1 };
    const gate = deferred();
    r.steps.drainGate = gate.promise;
    const view = await r.orchestrator.pause(started.launchId);
    expect(view.status).toBe("pausing");
    expect(r.fileOf(started.launchId).status).toBe("running");
    expect(r.orchestrator.snapshotView()?.status).toBe("pausing");
    r.steps.inflight = { requests: 0, renders: 0 };
    gate.resolve();
    await r.orchestrator.settled();
    expect(r.fileOf(started.launchId)).toMatchObject({ status: "paused", paused: { cause: "owner" } });
    expect(r.orchestrator.snapshotView()?.status).toBe("paused");
  });

  test("«Пауза» logs how many requests and renders it waits for", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 3, renders: 2 };
    r.steps.drainGate = deferred().promise;
    const view = await r.orchestrator.pause(started.launchId);
    expect(view.logTail.at(-1)).toMatchObject({ kind: "pausing", requests: 3, renders: 2 });
  });

  test("pausing a pausing or paused launch is a wrong state", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    r.steps.drainGate = deferred().promise;
    await r.orchestrator.pause(started.launchId);
    expect(await failure(r.orchestrator.pause(started.launchId))).toMatchObject({ code: "VALIDATION" });
    const other = await rig();
    const second = await other.start();
    await other.orchestrator.pause(second.launchId);
    expect(await failure(other.orchestrator.pause(second.launchId))).toMatchObject({ code: "VALIDATION" });
  });

  test("an unknown launch is NOT_FOUND, and an ended one is a wrong state", async () => {
    const r = await rig();
    expect((await failure(r.orchestrator.pause("launch-nobody0404"))).code).toBe("NOT_FOUND");
    const started = await r.start();
    await r.orchestrator.stop(started.launchId);
    expect((await failure(r.orchestrator.pause(started.launchId))).code).toBe("VALIDATION");
  });

  test("nothing continues during «Пауза»: a step cannot write, set a hold or finish the paused launch (A13)", async () => {
    const r = await rig();
    const started = await r.start();
    const ctx = r.steps.ctx;
    await r.orchestrator.pause(started.launchId);
    expect(ctx.isRunning()).toBe(false);
    await expect(ctx.update((f) => ({ ...f, photosDone: 0 }) as LaunchFile)).rejects.toThrow();
    await expect(ctx.raisePaidHold({ reason: "credits", at: AT, detail: {} })).rejects.toThrow();
    await expect(ctx.finish()).rejects.toThrow();
    expect(r.fileOf(started.launchId).status).toBe("paused");
  });
});

// ---------- holds ----------

describe("a paid hold (A13)", () => {
  test("keeps the launch running: free work goes on, the soft stop is not asked for, and the hold is in the view and the log", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold({ reason: "key", at: AT, detail: {} });
    const view = r.orchestrator.snapshotView();
    expect(view).toMatchObject({ status: "running", paidHold: { reason: "key" } });
    expect(view?.logTail.at(-1)?.kind).toBe("hold-key");
    expect(r.steps.ctx.isRunning()).toBe(true);
    expect(r.steps.calls).toEqual(["begin"]);
    expect(r.fileOf(started.launchId).paidHold).toMatchObject({ reason: "key" });
  });

  test("a step can still write through a hold", async () => {
    const r = await rig();
    await r.start();
    await r.steps.ctx.raisePaidHold({ reason: "credits", at: AT, detail: {} });
    const written = await r.steps.ctx.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, photosDone: 3 })) }));
    expect(written.avatars[0]?.photosDone).toBe(3);
  });

  test("clearing the hold removes it", async () => {
    const r = await rig();
    await r.start();
    await r.steps.ctx.raisePaidHold({ reason: "key", at: AT, detail: {} });
    await r.steps.ctx.clearPaidHold({ reason: "key", at: AT, detail: {} });
    expect(r.orchestrator.snapshotView()?.paidHold).toBeNull();
  });
});

// ---------- resume ----------

describe("autopilot.resume", () => {
  async function paused(r: Rig, draft: Partial<LaunchDraft> = {}): Promise<LaunchView> {
    const started = await r.start(draft);
    await spend(r, started, 100_000);
    return r.orchestrator.pause(started.launchId);
  }

  test("a paused launch runs again: persisted, the clock restarted, the steps begun again, the click in the log", async () => {
    const r = await rig();
    const view = await paused(r);
    r.state.now = T0 + 600_000;
    const resumed = await r.orchestrator.resume(view.launchId, view.remainingMicros);
    expect(resumed).toMatchObject({ status: "running", paused: null });
    expect(r.fileOf(view.launchId)).toMatchObject({ status: "running", paused: null, activeSince: new Date(T0 + 600_000).toISOString() });
    expect(r.steps.calls).toEqual(["begin", "drain", "begin"]);
    expect(resumed.logTail.at(-1)).toEqual({ at: new Date(T0 + 600_000).toISOString(), kind: "resumed", acceptedRemainingMicros: view.remainingMicros });
  });

  test("R is W′ less what the ledger says the launch's group committed (settled and open at worst), and the click must cover it exactly", async () => {
    const r = await rig();
    const view = await paused(r);
    await openReserve(r, view, 50_000);
    const spent = r.budget.committedOfGroup(launchGroupKey(view.launchId));
    expect(spent).toBe(150_000);
    const need = view.plannedWorstMicros - spent;
    expect((await failure(r.orchestrator.resume(view.launchId, need - 1))).code).toBe("PRICE_CHANGED");
    expect(r.fileOf(view.launchId).status).toBe("paused");
    expect((await r.orchestrator.resume(view.launchId, need)).status).toBe("running");
  });

  test("spent and R in the view are that same sum", async () => {
    const r = await rig();
    const view = await paused(r);
    expect(view.spentMicros).toBe(r.budget.committedOfGroup(launchGroupKey(view.launchId)));
    expect(view.remainingMicros).toBe(Math.max(0, view.plannedWorstMicros - view.spentMicros));
  });

  test("a review write of the launch's set is outside the group and never counts toward R", async () => {
    const r = await rig();
    const started = await r.start();
    const setId = r.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    const write = await r.budget.tryReserve({ attemptId: `${setId}:write-1#1`, jobId: "job-fixture-0002", scope: { runId: "run-review-0001" }, model: "x-ai/grok-4.3", worstMicros: 77_000 });
    expect(write.ok).toBe(true);
    const view = await r.orchestrator.pause(started.launchId);
    expect(view.spentMicros).toBe(0);
    expect(view.remainingMicros).toBe(view.plannedWorstMicros);
  });

  test("R never goes below zero", async () => {
    const r = await rig();
    const started = await r.start();
    await spend(r, started, started.plannedWorstMicros);
    const view = await r.orchestrator.pause(started.launchId);
    expect(view.remainingMicros).toBe(0);
    expect((await r.orchestrator.resume(view.launchId, 0)).status).toBe("running");
  });

  test.each([
    ["RECONCILE_REQUIRED", RECONCILE],
    ["a halt", { blockedBy: "halt", error: { code: "SETTLE_ABOVE_WORST", detail: "billed above the worst case" } } satisfies Admission],
    ["an unreadable ledger", { blockedBy: "ledger", error: { code: "LEDGER_UNREADABLE", detail: "the ledger could not be read" } } satisfies Admission],
  ])("is refused with the ledger's own error while it is blocked for paid work: %s", async (_name, admission) => {
    const r = await rig();
    const view = await paused(r);
    r.state.admission = admission;
    expect(await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).toEqual(admission.error);
    expect(r.steps.calls).toEqual(["begin", "drain"]);
    expect(r.fileOf(view.launchId).status).toBe("paused");
  });

  test("an open reserve of THIS session alone does not block it, and the admission rule is the Budget's, not the UI's reconcile flag (A19)", async () => {
    const r = await rig();
    const view = await paused(r);
    await openReserve(r, view, 40_000);
    r.state.admission = null;
    expect((await r.orchestrator.resume(view.launchId, view.plannedWorstMicros)).status).toBe("running");
  });

  test("a rejected or missing key is AUTH_INVALID, but a launch with no paid work needs neither the key nor the ledger", async () => {
    const r = await rig();
    const view = await paused(r);
    r.state.key = "rejected";
    expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("AUTH_INVALID");
    r.state.key = "missing";
    expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("AUTH_INVALID");
    const free = await rig();
    const freeStarted = await free.start({ library: true, generate: false });
    const freePaused = await free.orchestrator.pause(freeStarted.launchId);
    free.state.key = "missing";
    free.state.admission = RECONCILE;
    expect((await free.orchestrator.resume(freePaused.launchId, 0)).status).toBe("running");
  });

  test("a launch that runs, with no hold, cannot be resumed; a stopping or ended one cannot either", async () => {
    const r = await rig();
    const started = await r.start();
    expect((await failure(r.orchestrator.resume(started.launchId, 10_000_000))).code).toBe("VALIDATION");
    await r.orchestrator.stop(started.launchId);
    expect((await failure(r.orchestrator.resume(started.launchId, 10_000_000))).code).toBe("VALIDATION");
    expect((await failure(r.orchestrator.resume("launch-nobody0404", 1))).code).toBe("NOT_FOUND");
  });

  describe("the hold's own rule (§18 item 7)", () => {
    const hold = {
      credits: { reason: "credits", at: AT, detail: {} },
      key: { reason: "key", at: AT, detail: {} },
      price: { reason: "price", at: AT, detail: { stage: "slice", fromPhotos: 5, toPhotos: 0 } },
      priceUnavailable: { reason: "price-unavailable", at: AT, detail: { attempt: 1, nextAt: null } },
      budget: { reason: "budget", at: AT, detail: { freeMicros: 1_000, needMicros: 210_000, kind: "new-slice" } },
      network: { reason: "network", at: AT, detail: { drops: 3, attempt: 2, nextAt: null } },
      internal: { reason: "internal", at: AT, detail: { kind: "allocation-exceeded" } },
    } as const;

    async function heldAndPaused(r: Rig, h: (typeof hold)[keyof typeof hold]): Promise<LaunchView> {
      const started = await r.start();
      await r.steps.ctx.raisePaidHold(h);
      return r.orchestrator.pause(started.launchId);
    }

    test.each(["credits", "price", "priceUnavailable", "key"] as const)("a %s hold is admitted and cleared: the answer of the next request decides", async (name) => {
      const r = await rig();
      const view = await heldAndPaused(r, hold[name]);
      r.state.room = null;
      const resumed = await r.orchestrator.resume(view.launchId, view.remainingMicros);
      expect(resumed).toMatchObject({ status: "running", paidHold: null });
      expect(r.fileOf(view.launchId).paidHold).toBeNull();
    });

    test("a budget hold is admitted when the month's free room reaches needMicros, and not before", async () => {
      const r = await rig();
      const view = await heldAndPaused(r, hold.budget);
      r.state.room = 209_999;
      expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("VALIDATION");
      expect(r.fileOf(view.launchId).paidHold).toMatchObject({ reason: "budget" });
      r.state.room = 210_000;
      expect((await r.orchestrator.resume(view.launchId, view.remainingMicros)).paidHold).toBeNull();
    });

    test("a network hold is admitted only after a reconcile settled the launch's open reserves", async () => {
      const r = await rig();
      const started = await r.start();
      await openReserve(r, started, 40_000);
      await r.steps.ctx.raisePaidHold(hold.network);
      const view = await r.orchestrator.pause(started.launchId);
      expect(view.resumeBlockedBy).toBe("network");
      expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("VALIDATION");
    });

    test("a network hold with no open reserve of the launch left is admitted", async () => {
      const r = await rig();
      const view = await heldAndPaused(r, hold.network);
      expect((await r.orchestrator.resume(view.launchId, view.remainingMicros)).status).toBe("running");
    });

    test("an internal hold is never admitted: its only exit is «Стоп»", async () => {
      const r = await rig();
      const view = await heldAndPaused(r, hold.internal);
      expect(view.resumeBlockedBy).toBe("internal");
      expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("VALIDATION");
      expect((await r.orchestrator.stop(view.launchId)).status).toBe("stopped");
    });

    test("«Продолжить» on a RUNNING launch with a hold clears the hold by the same rule and begins the steps again", async () => {
      const r = await rig();
      const started = await r.start();
      await r.steps.ctx.raisePaidHold(hold.credits);
      const resumed = await r.orchestrator.resume(started.launchId, started.remainingMicros);
      expect(resumed).toMatchObject({ status: "running", paidHold: null });
      expect(r.steps.calls).toEqual(["begin", "begin"]);
    });
  });

  test("resumeBlockedBy follows the same rule: the ledger first, then the key, then the hold", async () => {
    const r = await rig();
    const view = await paused(r);
    expect(r.orchestrator.snapshotView()?.resumeBlockedBy).toBeNull();
    r.state.key = "rejected";
    expect(r.orchestrator.snapshotView()?.resumeBlockedBy).toBe("key");
    r.state.admission = RECONCILE;
    expect(r.orchestrator.snapshotView()?.resumeBlockedBy).toBe("reconcile-required");
    r.state.admission = { blockedBy: "halt", error: { code: "LEDGER_WRITE_FAILED", detail: "x" } };
    expect(r.orchestrator.snapshotView()?.resumeBlockedBy).toBe("halt");
    r.state.admission = { blockedBy: "ledger", error: { code: "LEDGER_UNREADABLE", detail: "x" } };
    expect(r.orchestrator.snapshotView()?.resumeBlockedBy).toBe("ledger");
    expect(view.launchId).toBe("launch-orch-0001");
  });
});

// ---------- stop ----------

describe("autopilot.stop", () => {
  test("persists «stopping» BEFORE it drains, then drains, releases, and ends the launch: stopped, its end, its final sum, its group finished", async () => {
    const r = await rig();
    const started = await r.start();
    await spend(r, started, 123_000);
    const during: Record<string, string> = {};
    r.steps.onDrain = () => {
      during.drain = r.fileOf(started.launchId).status;
    };
    r.steps.onRelease = () => {
      during.release = r.fileOf(started.launchId).status;
    };
    r.state.now = T0 + 5_000;
    const view = await r.orchestrator.stop(started.launchId);
    expect(during).toEqual({ drain: "stopping", release: "stopping" });
    expect(view).toMatchObject({ status: "stopped", endedAt: new Date(T0 + 5_000).toISOString(), spentMicros: 123_000, activeMs: 5_000 });
    expect(r.fileOf(started.launchId)).toMatchObject({ status: "stopped", spentMicros: 123_000, activeSince: null });
    expect(r.groups.groupOf({ attemptId: `${r.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId}:writer-1#9`, scope: { runId: "x" } })).toBeNull();
    expect(r.steps.calls).toEqual(["begin", "drain", "release"]);
    expect(r.orchestrator.snapshotView()).toBeNull();
    expect(view.logTail.at(-1)).toMatchObject({ kind: "stopped", spentMicros: 123_000 });
  });

  test("videos that were not finished are dropped «launch-stopped»", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.stop(started.launchId);
    const videos = r.fileOf(started.launchId).avatars[0]?.videos ?? [];
    expect(videos.every((v) => v.state === "dropped" && v.dropReason === "launch-stopped")).toBe(true);
  });

  test("a paused launch can be stopped", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    expect((await r.orchestrator.stop(started.launchId)).status).toBe("stopped");
  });

  test("with requests in flight it answers «stopping» at once and ends when the drain ends", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 2, renders: 0 };
    const gate = deferred();
    r.steps.drainGate = gate.promise;
    const view = await r.orchestrator.stop(started.launchId);
    expect(view.status).toBe("stopping");
    expect(r.fileOf(started.launchId).status).toBe("stopping");
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(true);
    r.steps.inflight = { requests: 0, renders: 0 };
    gate.resolve();
    await r.orchestrator.settled();
    expect(r.fileOf(started.launchId).status).toBe("stopped");
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(false);
  });

  test("stopping a launch that is stopping or ended is a wrong state; an unknown one is NOT_FOUND", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    r.steps.drainGate = deferred().promise;
    await r.orchestrator.stop(started.launchId);
    expect((await failure(r.orchestrator.stop(started.launchId))).code).toBe("VALIDATION");
    expect((await failure(r.orchestrator.stop("launch-nobody0404"))).code).toBe("NOT_FOUND");
    const other = await rig();
    const second = await other.start();
    await other.orchestrator.stop(second.launchId);
    expect((await failure(other.orchestrator.stop(second.launchId))).code).toBe("VALIDATION");
  });
});

// ---------- finish ----------

describe("a launch that finishes", () => {
  test("is done: its end and sum are final, its group is finished, nothing is current", async () => {
    const r = await rig();
    const started = await r.start();
    await spend(r, started, 50_000);
    r.state.now = T0 + 9_000;
    await r.steps.ctx.finish();
    expect(r.fileOf(started.launchId)).toMatchObject({ status: "done", spentMicros: 50_000, endedAt: new Date(T0 + 9_000).toISOString(), activeMs: 9_000, activeSince: null });
    expect(r.orchestrator.snapshotView()).toBeNull();
    expect(r.emitted.at(-1)).toMatchObject({ status: "done", spentMicros: 50_000 });
    const setId = r.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId;
    expect(r.groups.groupOf({ attemptId: `${setId}:writer-1#9`, scope: { runId: "x" } })).toBeNull();
  });

  test("a launch that was done can start no work again: a step's late write is refused", async () => {
    const r = await rig();
    await r.start();
    const ctx = r.steps.ctx;
    await ctx.finish();
    await expect(ctx.update((f) => f)).rejects.toThrow();
    await expect(ctx.finish()).rejects.toThrow();
  });
});

// ---------- library switch, avatar rule ----------

describe("the library-switch check (A12) and the avatar rule", () => {
  test("a running launch blocks a library switch even with no job running; a paused one does not", async () => {
    const r = await rig();
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(false);
    const started = await r.start();
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(true);
    await r.orchestrator.pause(started.launchId);
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(false);
    await r.orchestrator.resume(started.launchId, started.remainingMicros);
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(true);
    await r.orchestrator.stop(started.launchId);
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(false);
  });

  test("a launch holds its avatars while it is unfinished, paused included, and lets them go when it ends", async () => {
    const r = await rig();
    const started = await r.start();
    expect(r.orchestrator.holdsAvatar("avatar-mia-0001")).toBe(true);
    expect(r.orchestrator.holdsAvatar("avatar-sofia-0002")).toBe(false);
    await r.orchestrator.pause(started.launchId);
    expect(r.orchestrator.holdsAvatar("avatar-mia-0001")).toBe(true);
    await r.orchestrator.stop(started.launchId);
    expect(r.orchestrator.holdsAvatar("avatar-mia-0001")).toBe(false);
  });
});

// ---------- restart ----------

describe("a restart (A5)", () => {
  test("reads a running launch as paused «engine-restart»: persisted, logged, and no step begins until «Продолжить»", async () => {
    const first = await rig();
    const started = await first.start();
    await spend(first, started, 100_000);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    const view = second.orchestrator.snapshotView();
    expect(view).toMatchObject({ launchId: started.launchId, status: "paused", paused: { cause: "engine-restart" } });
    expect(second.fileOf(started.launchId)).toMatchObject({ status: "paused", paused: { cause: "engine-restart" }, activeSince: null });
    expect(second.steps.calls).toEqual([]);
    expect(view?.logTail.at(-1)).toMatchObject({ kind: "app-restarted", cause: "engine-restart" });
  });

  test("the restored group still counts the earlier process's money: spent and R are the ledger's, before any paid command", async () => {
    const first = await rig();
    const started = await first.start();
    await spend(first, started, 100_000);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()).toMatchObject({ spentMicros: 100_000, remainingMicros: started.plannedWorstMicros - 100_000 });
  });

  test("«Продолжить · до $R» is the click that begins the steps again, and it must cover R′", async () => {
    const first = await rig();
    const started = await first.start();
    await spend(first, started, 100_000);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    const need = started.plannedWorstMicros - 100_000;
    expect((await failure(second.orchestrator.resume(started.launchId, need - 1))).code).toBe("PRICE_CHANGED");
    expect(second.steps.calls).toEqual([]);
    expect((await second.orchestrator.resume(started.launchId, need)).status).toBe("running");
    expect(second.steps.calls).toEqual(["begin"]);
  });

  test("a restart during «pausing» (the file says running) reads the same way", async () => {
    const first = await rig();
    const started = await first.start();
    first.steps.inflight = { requests: 1, renders: 0 };
    first.steps.drainGate = deferred().promise;
    await first.orchestrator.pause(started.launchId);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()).toMatchObject({ status: "paused", paused: { cause: "engine-restart" } });
  });

  test("a launch the owner paused stays paused by the owner", async () => {
    const first = await rig();
    const started = await first.start();
    await first.orchestrator.pause(started.launchId);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()).toMatchObject({ status: "paused", paused: { cause: "owner" } });
    expect(second.fileOf(started.launchId).revision).toBe(first.fileOf(started.launchId).revision);
  });

  test("«stopping» is persisted: a restart finishes the stop (release, stopped, group finished) and never reads it as a pause", async () => {
    const first = await rig();
    const started = await first.start();
    first.steps.inflight = { requests: 1, renders: 0 };
    first.steps.drainGate = deferred().promise;
    await first.orchestrator.stop(started.launchId);
    expect(first.fileOf(started.launchId).status).toBe("stopping");
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.fileOf(started.launchId).status).toBe("stopped");
    expect(second.steps.calls).toEqual(["release"]);
    expect(second.orchestrator.snapshotView()).toBeNull();
    expect(second.orchestrator.blocksLibrarySwitch()).toBe(false);
  });

  test("a done or stopped launch is not current after a restart", async () => {
    const first = await rig();
    const started = await first.start();
    await first.orchestrator.stop(started.launchId);
    let later = 50;
    const second = await rig({ root: first.root, deps: { newId: () => `orch-${String(++later).padStart(4, "0")}` } });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()).toBeNull();
    expect((await second.start()).status).toBe("running");
  });

  test("a library with no launches has no current one", async () => {
    const r = await rig();
    expect(r.orchestrator.snapshotView()).toBeNull();
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(false);
  });

  test("a quit persists the pause as «quit», and begins nothing; a restart keeps the cause", async () => {
    const first = await rig();
    const started = await first.start();
    await first.orchestrator.shutdown();
    expect(first.fileOf(started.launchId)).toMatchObject({ status: "paused", paused: { cause: "quit" } });
    // The steps are told to start nothing new (the process is about to die; a request in flight dies with it); none begins.
    expect(first.steps.calls).toEqual(["begin", "drain"]);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()).toMatchObject({ status: "paused", paused: { cause: "quit" } });
  });

  test("restores the Budget group from the launch file AND from the sets' recorded slices (§19)", async () => {
    const first = await rig();
    const started = await first.start();
    const setId = first.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    const second = await rig({ root: first.root });
    second.sets.push({ sceneSetId: setId, launchId: started.launchId, launchDraw: { slices: [{ runId: "run-slice-0001" }, { runId: "run-slice-0002" }] } });
    await second.adopt();
    await second.orchestrator.settled();
    const key = launchGroupKey(started.launchId);
    expect(second.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.key).toBe(key);
    expect(second.groups.groupOf({ attemptId: "slot-1#1", scope: { runId: "run-slice-0002" } })?.key).toBe(key);
    expect(second.groups.groupOf({ attemptId: "slot-1#1", scope: { runId: first.fileOf(started.launchId).avatars[0]?.generation?.setRunId ?? "" } })?.key).toBe(key);
    expect(second.groups.groupOf({ attemptId: "slot-1#1", scope: { runId: "run-manual-0001" } })).toBeNull();
  });

  test("a finished launch maps nothing after a restart", async () => {
    const first = await rig();
    const started = await first.start();
    const setId = first.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    await first.orchestrator.stop(started.launchId);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })).toBeNull();
  });

  test("the lookup the scene registry asks is backed by the files: a paused launch is unfinished, a stopped one is not", async () => {
    const first = await rig();
    const started = await first.start();
    await first.orchestrator.pause(started.launchId);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.stores.isUnfinished(started.launchId)).toBe(true);
    await second.orchestrator.stop(started.launchId);
    expect(second.stores.isUnfinished(started.launchId)).toBe(false);
  });
});

// ---------- list, get, removeUnreadable ----------

describe("autopilot.list and autopilot.get", () => {
  test("list answers the launches newest first with the sum from the ledger while unfinished and the final one after, and the unreadable entries by opaque id", async () => {
    const r = await rig();
    const first = await r.start();
    await spend(r, first, 30_000);
    r.state.now = T0 + 1_000;
    await r.orchestrator.stop(first.launchId);
    r.state.now = T0 + 2_000;
    const second = await r.start();
    await spend(r, second, 10_000, "writer-1#5");
    await writeFile(join(r.libraryRoot, AUTOPILOT_DIR, "launch-broken-0001.json"), "{not json");
    const listed = await r.orchestrator.list();
    expect(listed.launches.map((l) => [l.launchId, l.status, l.spentMicros])).toEqual([
      [second.launchId, "running", 10_000],
      [first.launchId, "stopped", 30_000],
    ]);
    expect(listed.launches[0]).toMatchObject({ avatarCount: 1, avatarIds: ["avatar-mia-0001"], videosDone: 0, videosPlanned: 4, acceptedMicros: 20_000_000 });
    expect(listed.unreadable).toEqual([{ entryId: expect.stringMatching(/^[0-9a-f]{16}$/), reason: "invalid" }]);
    expect(Object.keys(listed.unreadable[0] ?? {}).sort()).toEqual(["entryId", "reason"]);
  });

  test("get answers the launch, its log and the videos that were dropped; an unknown or unreadable launch is NOT_FOUND", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.stop(started.launchId);
    const got = await r.orchestrator.get(started.launchId);
    expect(got.launch.status).toBe("stopped");
    expect(got.log.map((l) => l.kind)).toEqual(["start", "stopped"]);
    expect(got.videos).toHaveLength(4);
    expect(got.videos.every((v) => v.state === "dropped" && v.dropReason === "launch-stopped" && v.videoId === null)).toBe(true);
    expect((await failure(r.orchestrator.get("launch-nobody0404"))).code).toBe("NOT_FOUND");
    await writeFile(join(r.libraryRoot, AUTOPILOT_DIR, "launch-broken-0001.json"), "{not json");
    expect((await failure(r.orchestrator.get("launch-broken-0001"))).code).toBe("NOT_FOUND");
  });

  test("get on the pausing launch says pausing", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    r.steps.drainGate = deferred().promise;
    await r.orchestrator.pause(started.launchId);
    expect((await r.orchestrator.get(started.launchId)).launch.status).toBe("pausing");
  });
});

describe("autopilot.removeUnreadable", () => {
  test("moves the matching entry to the quarantine and unblocks a start; an unknown id is NOT_FOUND", async () => {
    const r = await rig();
    await mkdir(join(r.libraryRoot, AUTOPILOT_DIR), { recursive: true });
    await writeFile(join(r.libraryRoot, AUTOPILOT_DIR, "launch-broken-0001.json"), "{not json");
    const { unreadable } = await r.orchestrator.list();
    expect((await failure(r.orchestrator.removeUnreadable("0123456789abcdef"))).code).toBe("NOT_FOUND");
    expect((await failure(r.start())).code).toBe("VALIDATION");
    await r.orchestrator.removeUnreadable(unreadable[0]?.entryId ?? "");
    expect((await r.orchestrator.list()).unreadable).toEqual([]);
    expect((await r.start()).status).toBe("running");
  });

  test("never moves the file of a launch that reads fine, even when its entry id is guessed", async () => {
    const r = await rig();
    const started = await r.start();
    const { createHash } = await import("node:crypto");
    const guess = createHash("sha256").update(`${started.launchId}.json`).digest("hex").slice(0, 16);
    expect((await failure(r.orchestrator.removeUnreadable(guess))).code).toBe("NOT_FOUND");
    expect(existsSync(r.pathOf(started.launchId))).toBe(true);
  });
});

// ---------- events and the safe view ----------

describe("autopilot.changed and the snapshot", () => {
  test("every change is announced as a launch that passes the contract, and the last one is the latest state", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    await r.orchestrator.resume(started.launchId, started.plannedWorstMicros);
    await r.orchestrator.stop(started.launchId);
    r.orchestrator.flushEvents();
    expect(r.emitted.length).toBeGreaterThanOrEqual(4);
    for (const view of r.emitted) expect(LaunchView.safeParse(view).success).toBe(true);
    expect(r.emitted.map((v) => v.status)).toContain("paused");
    expect(r.emitted.at(-1)?.status).toBe("stopped");
  });

  test("changes inside the interval are merged: a burst of step writes is announced once, with the latest state, when it ends", async () => {
    const timer: { run: (() => void) | null } = { run: null };
    let monotonic = 1_000;
    const r = await rig({ deps: { coalesce: { intervalMs: 250, now: () => monotonic, schedule: (run) => ((timer.run = run), () => undefined) } } });
    await r.start();
    const afterStart = r.emitted.length;
    expect(afterStart).toBe(1);
    monotonic += 10;
    for (let n = 1; n <= 5; n++) await r.steps.ctx.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, photosDone: n })) }));
    expect(r.emitted).toHaveLength(afterStart);
    monotonic += 250;
    timer.run?.();
    expect(r.emitted).toHaveLength(afterStart + 1);
    expect(r.emitted.at(-1)?.avatars[0]?.photos.done).toBe(5);
  });

  // S4.6b1, L2 (deliberate change of the S4.6a test that stood here): a view that breaks the contract is still never announced AS IT IS, but it no longer hides a running paid
  // launch. The engine is told, and the owner gets the minimal view (no log, no set mirrors) that fits the contract, so «Стоп» stays reachable. The old test pinned INTERNAL and
  // no snapshot, which cut the owner off from a launch that goes on spending.
  test("a view that breaks the contract is never announced as it is: the owner gets the minimal valid view, the engine is told, and the launch itself is unharmed", async () => {
    const r = await rig({ deps: { viewOf: () => ({ launchId: "not a launch" }) } });
    const view = await r.start();
    expect(LaunchView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ launchId: "launch-orch-0001", status: "running", logTail: [] });
    expect(existsSync(r.pathOf("launch-orch-0001"))).toBe(true);
    expect(r.fileOf("launch-orch-0001").status).toBe("running");
    expect(r.steps.calls).toEqual(["begin"]);
    expect(r.emitted.every((v) => LaunchView.safeParse(v).success)).toBe(true);
    expect(r.orchestrator.snapshotView()).toMatchObject({ launchId: "launch-orch-0001", status: "running" });
    expect(r.state.degraded).toBeGreaterThanOrEqual(1);
  });

  test("L2: «Стоп» stays reachable while the full view is broken: the stop is answered, ends the launch, and its last state is announced", async () => {
    const r = await rig({ deps: { viewOf: () => ({ launchId: "not a launch" }) } });
    const started = await r.start();
    const stopped = await r.orchestrator.stop(started.launchId);
    expect(stopped.status).toBe("stopped");
    await r.orchestrator.settled();
    expect(r.fileOf(started.launchId).status).toBe("stopped");
    expect(r.emitted.at(-1)).toMatchObject({ launchId: started.launchId, status: "stopped" });
    expect((await r.orchestrator.get(started.launchId)).launch.status).toBe("stopped");
  });
});

// ---------- fix round 1 (S4.6a review) ----------

describe("M1: «Продолжить» re-checks the hold on the FRESH file", () => {
  test("a hold a step sets between the click and the write is not erased: the resume is refused, the hold stays, begin is not called again", async () => {
    const r = await rig();
    const started = await r.start();
    const ctx = r.steps.ctx;
    await ctx.raisePaidHold({ reason: "credits", at: AT, detail: {} });
    // The step's write is queued before the click's: the click saw «credits» in memory, the file says «internal» when its write runs.
    const click = r.orchestrator.resume(started.launchId, started.plannedWorstMicros);
    const step = ctx.raisePaidHold({ reason: "internal", at: AT, detail: { kind: "allocation-exceeded" } });
    expect((await failure(click)).code).toBe("VALIDATION");
    await step;
    expect(r.fileOf(started.launchId).paidHold).toMatchObject({ reason: "internal" });
    expect(r.steps.calls).toEqual(["begin"]);
  });

  test("a network hold set meanwhile is not erased before a reconcile either", async () => {
    const r = await rig();
    const started = await r.start();
    const ctx = r.steps.ctx;
    await openReserve(r, started, 40_000);
    await ctx.raisePaidHold({ reason: "credits", at: AT, detail: {} });
    const click = r.orchestrator.resume(started.launchId, started.plannedWorstMicros);
    const step = ctx.raisePaidHold({ reason: "network", at: AT, detail: { drops: 3, attempt: 2, nextAt: null } });
    expect((await failure(click)).code).toBe("VALIDATION");
    await step;
    expect(r.fileOf(started.launchId).paidHold).toMatchObject({ reason: "network" });
    expect(r.steps.calls).toEqual(["begin"]);
  });
});

describe("M2: a command takes its library with it", () => {
  test("a start made against another library than the live one is refused, and writes and begins nothing", async () => {
    const r = await rig();
    const other = await rig();
    expect((await failure(r.orchestrator.start(startInput(), other.library))).code).toBe("IN_FLIGHT");
    expect(existsSync(r.pathOf("launch-orch-0001"))).toBe(false);
    expect(existsSync(other.pathOf("launch-orch-0001"))).toBe(false);
    expect(r.steps.calls).toEqual([]);
  });
});

describe("M3: a scene set that cannot be read at open counts as spent in full", () => {
  const B = "avatar-sofia-0002";

  test("the avatar's whole allocation is committed for the group's cap and for spent and R, until its set reads again", async () => {
    const first = await rig();
    const started = await first.start({ avatarIds: ["avatar-mia-0001", B] });
    const rows = first.fileOf(started.launchId).avatars;
    const allocB = (rows[1]?.allocation.composeMicros ?? 0) + (rows[1]?.allocation.drawMicros ?? 0);
    expect(allocB).toBeGreaterThan(0);
    const second = await rig({ root: first.root });
    second.unreadableSets.add(B);
    await second.adopt();
    await second.orchestrator.settled();
    const setId = rows[0]?.generation?.sceneSetId ?? "";
    expect(second.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.capMicros).toBe(started.plannedWorstMicros - allocB);
    expect(second.orchestrator.snapshotView()).toMatchObject({ spentMicros: allocB, remainingMicros: started.plannedWorstMicros - allocB });
    // The set reads again at the next open: the cap is W′ and nothing is counted extra.
    second.unreadableSets.delete(B);
    await second.adopt();
    await second.orchestrator.settled();
    expect(second.groups.groupOf({ attemptId: `${setId}:writer-1#1`, scope: { runId: "x" } })?.capMicros).toBe(started.plannedWorstMicros);
    expect(second.orchestrator.snapshotView()?.spentMicros).toBe(0);
  });

  test("N1: such an avatar's set and run are not in the group (its allocation already counts as spent, its ledger lines would be counted twice), and its allocation is in the final spent", async () => {
    const first = await rig();
    const started = await first.start({ avatarIds: ["avatar-mia-0001", B] });
    const rows = first.fileOf(started.launchId).avatars;
    const allocB = (rows[1]?.allocation.composeMicros ?? 0) + (rows[1]?.allocation.drawMicros ?? 0);
    const second = await rig({ root: first.root });
    second.unreadableSets.add(B);
    await second.adopt();
    await second.orchestrator.settled();
    const setB = rows[1]?.generation?.sceneSetId ?? "";
    const runB = rows[1]?.generation?.setRunId ?? "";
    expect(second.groups.groupOf({ attemptId: `${setB}:writer-1#1`, scope: { avatarJobId: "job-x" } })).toBeNull();
    expect(second.groups.groupOf({ attemptId: "any#1", scope: { runId: runB } })).toBeNull();
    const setA = rows[0]?.generation?.sceneSetId ?? "";
    expect(second.groups.groupOf({ attemptId: `${setA}:writer-1#1`, scope: { avatarJobId: "job-x" } })?.key).toBe(launchGroupKey(started.launchId));
    // The ledger holds nothing for B here, so what the stop writes as spent is exactly the unseen allocation.
    await second.orchestrator.resume(started.launchId, started.plannedWorstMicros).catch(() => undefined);
    const stopped = await second.orchestrator.stop(started.launchId);
    expect(stopped.status).toBe("stopped");
    expect(second.fileOf(started.launchId).spentMicros).toBe(allocB);
    expect(stopped.spentMicros).toBe(allocB);
  });

  test("a listing that fails outright is the same as an unreadable set", async () => {
    const first = await rig();
    const started = await first.start();
    const second = await rig({ root: first.root });
    const broken = {
      root: second.libraryRoot,
      sceneSets: {
        list: (): Promise<{ sets: readonly ListedSet[]; unreadable: number }> => Promise.reject(new Error("EIO")),
      },
    };
    second.orchestrator.adopt(broken, await second.orchestrator.prepare(broken));
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()?.spentMicros).toBe(started.plannedWorstMicros);
  });
});

describe("L1: a stop that failed at its last write can be repeated", () => {
  test("a repeated «Стоп» finishes a stop that is stuck in «stopping» when no completion is in flight", async () => {
    const cut = { armed: false };
    const r = await rig({
      storeDeps: {
        beforeRename: () => {
          if (cut.armed) {
            cut.armed = false;
            throw new Error("the disk refused the last write");
          }
        },
      },
    });
    const started = await r.start();
    r.steps.onRelease = () => {
      cut.armed = true;
      r.steps.onRelease = null;
    };
    await expect(r.orchestrator.stop(started.launchId)).rejects.toThrow();
    expect(r.fileOf(started.launchId).status).toBe("stopping");
    expect(r.orchestrator.blocksLibrarySwitch()).toBe(true);
    const view = await r.orchestrator.stop(started.launchId);
    expect(view.status).toBe("stopped");
    expect(r.fileOf(started.launchId).status).toBe("stopped");
    expect(r.steps.calls).toEqual(["begin", "drain", "release", "drain", "release"]);
  });
});

describe("L3: a terminal state is never dropped by the coalescer", () => {
  function held() {
    const timer: { run: (() => void) | null } = { run: null };
    return { coalesce: { intervalMs: 250, now: () => 1_000, schedule: (run: () => void) => ((timer.run = run), () => undefined) } };
  }

  test("a pending announcement is sent when another launch is announced", async () => {
    const r = await rig({ deps: held() });
    const first = await r.start();
    await r.orchestrator.stop(first.launchId);
    expect(r.emitted.some((v) => v.launchId === first.launchId && v.status === "stopped")).toBe(false);
    await r.start();
    expect(r.emitted.some((v) => v.launchId === first.launchId && v.status === "stopped")).toBe(true);
  });

  test("a pending announcement is sent before the library is left", async () => {
    const r = await rig({ deps: held() });
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    expect(r.emitted.at(-1)?.status).toBe("running");
    r.orchestrator.adopt(null, null);
    expect(r.emitted.at(-1)?.status).toBe("paused");
  });
});

describe("L6: the file of the launch that is current is not an unreadable entry to remove", () => {
  test("a torn file of the current launch is not moved to the quarantine", async () => {
    const r = await rig();
    const started = await r.start();
    await writeFile(r.pathOf(started.launchId), "{torn");
    const { createHash } = await import("node:crypto");
    const id = createHash("sha256").update(`${started.launchId}.json`).digest("hex").slice(0, 16);
    expect((await failure(r.orchestrator.removeUnreadable(id))).code).toBe("NOT_FOUND");
    expect(existsSync(r.pathOf(started.launchId))).toBe(true);
  });
});

describe("L7/L8: a quit closes the door", () => {
  test("from the moment shutdown is called, steps are no longer running; start and resume are refused and begin nothing", async () => {
    const r = await rig();
    const started = await r.start();
    const ctx = r.steps.ctx;
    const down = r.orchestrator.shutdown();
    expect(ctx.isRunning()).toBe(false);
    await down;
    expect((await failure(r.orchestrator.resume(started.launchId, started.plannedWorstMicros))).code).toBe("IN_FLIGHT");
    await r.orchestrator.stop(started.launchId);
    expect((await failure(r.start())).code).toBe("IN_FLIGHT");
    expect(r.steps.calls.filter((c) => c === "begin")).toHaveLength(1);
  });
});

describe("L10: «app-restarted» counts the launch's own open reserves", () => {
  test("a reserve of another job in the ledger is not a request of the launch", async () => {
    const first = await rig();
    const started = await first.start();
    await openReserve(first, started, 10_000);
    const other = await first.budget.tryReserve({ attemptId: "manual#1", jobId: "job-manual-0001", scope: { runId: "run-manual-0001" }, model: "x-ai/grok-4.3", worstMicros: 5 });
    expect(other.ok).toBe(true);
    const second = await rig({ root: first.root });
    await second.orchestrator.settled();
    expect(second.orchestrator.snapshotView()?.logTail.at(-1)).toMatchObject({ kind: "app-restarted", requests: 1 });
  });
});

// ---------- S4.6b1: the review hand-off (plan §4.7, §18 item 9) ----------

describe("autopilot.continueAfterReview", () => {
  /** A running launch whose first avatar waits for the owner's review of its set. */
  async function awaiting(r: Rig, draft: Partial<LaunchDraft> = { sceneReview: true }) {
    const started = await r.start(draft);
    const generation = r.fileOf(started.launchId).avatars[0]?.generation;
    const sceneSetId = generation?.sceneSetId ?? "";
    await r.steps.ctx.update((f) => ({ ...f, avatars: f.avatars.map((a, i) => (i === 0 ? { ...a, phase: "awaiting-review" as const } : a)) }));
    const input = { launchId: started.launchId, avatarId: "avatar-mia-0001", sceneSetId, revision: 4 };
    return { started, input };
  }

  test("hands the set and the revision to the steps, logs the continue and answers that the draw started", async () => {
    const r = await rig();
    const { input } = await awaiting(r);
    r.steps.continueAnswer = { draw: "started", photos: 10 };
    const answer = await r.orchestrator.continueAfterReview(input);
    expect(answer.draw).toBe("started");
    expect(LaunchView.safeParse(answer.launch).success).toBe(true);
    expect(r.steps.continued).toEqual([{ avatarId: input.avatarId, sceneSetId: input.sceneSetId, revision: 4 }]);
    expect(answer.launch.logTail.at(-1)).toMatchObject({ kind: "review-continued", avatarId: input.avatarId, photos: 10, writtenByOwner: 0 });
  });

  test("while the launch is paused the steps only record the approval: the avatar waits as «approved, waits for Продолжить» and the log says so (§18 item 9)", async () => {
    const r = await rig();
    const { input } = await awaiting(r);
    await r.orchestrator.pause(input.launchId);
    await r.orchestrator.settled();
    r.steps.continueAnswer = { draw: "waits-for-resume", photos: 10 };
    const answer = await r.orchestrator.continueAfterReview(input);
    expect(answer.draw).toBe("waits-for-resume");
    expect(answer.launch.status).toBe("paused");
    expect(answer.launch.avatars[0]?.phase).toBe("approved-waiting");
    expect(r.fileOf(input.launchId).avatars[0]?.phase).toBe("approved-waiting");
    expect(answer.launch.logTail.at(-1)).toMatchObject({ kind: "review-approved-paused", avatarId: input.avatarId, photos: 10 });
  });

  test("is not-awaiting for an avatar that is not in awaiting-review, for another set, for a launch that was stopped, and for steps with no review step; nothing reaches the steps", async () => {
    const r = await rig();
    const started = await r.start({ sceneReview: true });
    const sceneSetId = r.fileOf(started.launchId).avatars[0]?.generation?.sceneSetId ?? "";
    const base = { launchId: started.launchId, avatarId: "avatar-mia-0001", sceneSetId, revision: 1 };
    // Still composing: not waiting for the review yet.
    expect((await failure(r.orchestrator.continueAfterReview(base))).sceneReason).toBe("not-awaiting");
    await r.steps.ctx.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, phase: "awaiting-review" as const })) }));
    expect((await failure(r.orchestrator.continueAfterReview({ ...base, sceneSetId: "set-someone-else-0001" }))).sceneReason).toBe("not-awaiting");
    expect((await failure(r.orchestrator.continueAfterReview({ ...base, avatarId: "avatar-nobody-0404" }))).sceneReason).toBe("not-awaiting");
    r.steps.continueAfterReview = undefined;
    expect((await failure(r.orchestrator.continueAfterReview(base))).sceneReason).toBe("not-awaiting");
    expect(r.steps.continued).toEqual([]);
    await r.orchestrator.stop(started.launchId);
    expect((await failure(r.orchestrator.continueAfterReview(base))).sceneReason).toBe("not-awaiting");
  });

  test("an unknown launch is NOT_FOUND", async () => {
    const r = await rig();
    expect((await failure(r.orchestrator.continueAfterReview({ launchId: "launch-nobody0404", avatarId: "avatar-mia-0001", sceneSetId: "set-x-0001", revision: 1 }))).code).toBe("NOT_FOUND");
  });

  test("a refusal of the approval (SCENES_CHANGED, over-plan) passes through and changes nothing", async () => {
    const r = await rig();
    const { input } = await awaiting(r);
    r.steps.continueAnswer = new EngineFailure({ code: "SCENES_CHANGED", detail: "scene set moved on" });
    expect((await failure(r.orchestrator.continueAfterReview(input))).code).toBe("SCENES_CHANGED");
    r.steps.continueAnswer = new EngineFailure({ code: "VALIDATION", sceneReason: "over-plan", detail: "11 scenes, the launch planned 10" });
    expect(await failure(r.orchestrator.continueAfterReview(input))).toMatchObject({ code: "VALIDATION", sceneReason: "over-plan" });
    expect(r.fileOf(input.launchId).avatars[0]?.phase).toBe("awaiting-review");
    expect(r.orchestrator.snapshotView()?.logTail.some((l) => l.kind === "review-continued" || l.kind === "review-approved-paused")).toBe(false);
  });

  test("the view names the avatar's set mirrors the steps keep, and ignores a mirror of another set", async () => {
    const r = await rig();
    const { started, input } = await awaiting(r);
    r.steps.mirrors.set(input.avatarId, { sceneSetId: input.sceneSetId, setRevision: 4, scenes: 10, scenesWithoutText: 2, continuePhotos: 8, slice: null, undrawnScenes: 0, resumableSlots: 0 });
    const row = (await r.orchestrator.get(started.launchId)).launch.avatars[0];
    expect(row).toMatchObject({ sceneSetId: input.sceneSetId, setRevision: 4, scenes: 10, scenesWithoutText: 2, continuePhotos: 8 });
    r.steps.mirrors.set(input.avatarId, { sceneSetId: "set-someone-else-0001", setRevision: 9, scenes: 1, scenesWithoutText: 0, continuePhotos: 1, slice: null, undrawnScenes: 0, resumableSlots: 0 });
    expect((await r.orchestrator.get(started.launchId)).launch.avatars[0]).toMatchObject({ sceneSetId: null, setRevision: null, scenes: null });
  });
});

// ---------- S4.6b1 fix round 1: the finish ----------

describe("ctx.finish: the group is closed only when nothing of the launch is in flight (MEDIUM)", () => {
  const writerOf = (r: Rig, launchId: string) => ({ attemptId: `${r.fileOf(launchId).avatars[0]?.generation?.sceneSetId ?? ""}:writer-1#1`, scope: { avatarJobId: "job-x" } });

  test("is refused while a request or a render is in flight: the launch stays running and its group stays", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    await expect(r.steps.ctx.finish()).rejects.toThrow("in flight");
    r.steps.inflight = { requests: 0, renders: 2 };
    await expect(r.steps.ctx.finish()).rejects.toThrow("in flight");
    expect(r.fileOf(started.launchId).status).toBe("running");
    expect(r.groups.groupOf(writerOf(r, started.launchId))).not.toBeNull();
  });

  test("with nothing in flight it releases what the launch holds (complete) BEFORE the group is closed, then ends the launch", async () => {
    const r = await rig();
    const started = await r.start();
    let groupAtComplete: unknown = "unset";
    r.steps.complete = () => {
      groupAtComplete = r.groups.groupOf(writerOf(r, started.launchId));
      return Promise.resolve();
    };
    const done = await r.steps.ctx.finish();
    expect(done.status).toBe("done");
    expect(groupAtComplete).not.toBe("unset");
    expect(groupAtComplete).not.toBeNull();
    expect(r.groups.groupOf(writerOf(r, started.launchId))).toBeNull();
  });

  test("a launch that is not running cannot be finished, and the refusal does not wait in the queue behind a stop", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    await r.orchestrator.settled();
    await expect(r.steps.ctx.finish()).rejects.toThrow("not running");
  });

  test("behind the composer the group is closed only after the paid jobs have ended: free votes, paid still has a slice live, then the slice ends", async () => {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    let paidReady = false;
    paid.finishReady = () => paidReady;
    const held: { free: LaunchStepsContext | null } = { free: null };
    free.onBegin = (ctx) => {
      held.free = ctx;
    };
    const composed = composeSteps(paid, free);
    const r = await rig({ deps: { steps: composed } });
    const started = await r.start();
    paid.inflight = { requests: 1, renders: 0 };
    await held.free?.finish();
    await composed.settled();
    expect(r.fileOf(started.launchId).status).toBe("running");
    expect(r.groups.groupOf(writerOf(r, started.launchId))).not.toBeNull();
    // The slice ends, the paid part is ready: the composer's finish goes through, once.
    paid.inflight = { requests: 0, renders: 0 };
    paidReady = true;
    for (const listener of paid.readyListeners) listener();
    await composed.settled();
    await r.orchestrator.settled();
    expect(r.fileOf(started.launchId).status).toBe("done");
    expect(paid.completed).toBe(1);
    expect(r.groups.groupOf(writerOf(r, started.launchId))).toBeNull();
  });
});

describe("ctx.finish: a pause that landed first wins (LOW)", () => {
  test("a launch that is pausing is not finished and its sets are not released", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    await r.orchestrator.pause(started.launchId);
    r.steps.inflight = { requests: 0, renders: 0 };
    await expect(r.steps.ctx.finish()).rejects.toThrow();
    expect(r.steps.completed).toBe(0);
    expect(r.fileOf(started.launchId).status).not.toBe("done");
  });
});

describe("host.power (plan §3.8, S4.6b2): the engine's side", () => {
  test("suspend tells the steps at once, before the queue; the launch no longer counts as running, and no paid entry point admits", async () => {
    const r = await rig();
    r.steps.suspend = () => void r.steps.calls.push("suspend");
    const started = await r.start();
    expect(r.orchestrator.mayPay(started.launchId)).toBe(true);
    expect(r.steps.ctx.isRunning()).toBe(true);
    const sleeping = r.orchestrator.power("suspend");
    expect(r.steps.calls).toContain("suspend");
    expect(r.steps.ctx.isRunning()).toBe(false);
    expect(r.orchestrator.mayPay(started.launchId)).toBe(false);
    await sleeping;
    expect(r.fileOf(started.launchId).status).toBe("running");
  });

  test("resume gives the steps their re-check when they have one, else begins them again; the launch runs again", async () => {
    const woken = await rig();
    woken.steps.wake = async () => void woken.steps.calls.push("wake");
    const first = await woken.start();
    await woken.orchestrator.power("suspend");
    await woken.orchestrator.power("resume");
    await woken.orchestrator.settled();
    expect(woken.steps.calls).toEqual(["begin", "wake"]);
    expect(woken.orchestrator.mayPay(first.launchId)).toBe(true);

    const begun = await rig();
    await begun.start();
    await begun.orchestrator.power("suspend");
    await begun.orchestrator.power("resume");
    await begun.orchestrator.settled();
    expect(begun.steps.calls).toEqual(["begin", "begin"]);
  });

  test("the steps get a running context when they wake", async () => {
    const r = await rig();
    let runningAtWake: boolean | null = null;
    r.steps.wake = async (ctx) => {
      runningAtWake = ctx.isRunning();
    };
    await r.start();
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    await r.orchestrator.settled();
    expect(runningAtWake as boolean | null).toBe(true);
  });

  test("a resume with no suspend before it changes nothing", async () => {
    const r = await rig();
    await r.start();
    await r.orchestrator.power("resume");
    await r.orchestrator.settled();
    expect(r.steps.calls).toEqual(["begin"]);
  });

  test("a launch that is paused when the Mac wakes stays paused: nothing is begun", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    await r.orchestrator.settled();
    expect(r.steps.calls.filter((c) => c === "begin")).toHaveLength(1);
    expect(r.fileOf(started.launchId).status).toBe("paused");
  });

  test("a launch that is pausing when the Mac wakes is not begun again either", async () => {
    const r = await rig();
    const started = await r.start();
    r.steps.inflight = { requests: 1, renders: 0 };
    const gate = deferred();
    r.steps.drainGate = gate.promise;
    await r.orchestrator.pause(started.launchId);
    await r.orchestrator.power("suspend");
    await r.orchestrator.power("resume");
    expect(r.steps.calls.filter((c) => c === "begin")).toHaveLength(1);
    gate.resolve();
    await r.orchestrator.settled();
  });

  test("the owner's «Продолжить» ends a sleep whose wake-up never came", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold({ reason: "credits", at: AT, detail: {} });
    await r.orchestrator.power("suspend");
    expect(r.orchestrator.mayPay(started.launchId)).toBe(false);
    await r.orchestrator.resume(started.launchId, started.remainingMicros);
    expect(r.steps.ctx.isRunning()).toBe(true);
    expect(r.orchestrator.mayPay(started.launchId)).toBe(true);
  });

  test("a new launch starts awake", async () => {
    const r = await rig();
    const first = await r.start();
    await r.orchestrator.power("suspend");
    await r.orchestrator.stop(first.launchId);
    const second = await r.start();
    expect(r.orchestrator.mayPay(second.launchId)).toBe(true);
  });

  test("a steps part that throws when told of the sleep does not stop the sleep", async () => {
    const r = await rig();
    r.steps.suspend = () => {
      throw new Error("a part that cannot be told");
    };
    const started = await r.start();
    await r.orchestrator.power("suspend");
    expect(r.orchestrator.mayPay(started.launchId)).toBe(false);
  });
});

describe("a network hold that waits for an automatic continue (S4.6b2, A19)", () => {
  test("a hold with a retry still to come is admitted by «Продолжить» with no reconcile, even with the launch's reserves open", async () => {
    const r = await rig();
    const started = await r.start();
    await openReserve(r, started, 40_000);
    await r.steps.ctx.raisePaidHold({ reason: "network", at: AT, detail: { drops: 1, attempt: 1, nextAt: "2026-10-09T10:06:00.000Z" } });
    const view = await r.orchestrator.pause(started.launchId);
    expect(view.resumeBlockedBy).toBeNull();
    expect((await r.orchestrator.resume(view.launchId, view.remainingMicros)).paidHold).toBeNull();
  });

  test("the ledger test still applies to it: a previous process's reserves close the ledger to the click as to every other", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold({ reason: "network", at: AT, detail: { drops: 1, attempt: 1, nextAt: "2026-10-09T10:06:00.000Z" } });
    const view = await r.orchestrator.pause(started.launchId);
    r.state.admission = { blockedBy: "reconcile-required", error: { code: "RECONCILE_REQUIRED", detail: "open reserves of a previous process" } };
    expect((await failure(r.orchestrator.resume(view.launchId, view.remainingMicros))).code).toBe("RECONCILE_REQUIRED");
  });
});

describe("raisePaidHold and clearPaidHold: decided in the file's own write, by rank (S4.6b2, fix round 1)", () => {
  const waiting = { reason: "network", at: AT, detail: { drops: 1, attempt: 1, nextAt: "2026-10-09T10:06:00.000Z" } } as const;
  const waiting2 = { reason: "network", at: AT, detail: { drops: 2, attempt: 2, nextAt: "2026-10-09T10:11:00.000Z" } } as const;
  const forPerson = { reason: "network", at: AT, detail: { drops: 3, attempt: 2, nextAt: null } } as const;
  const credits = { reason: "credits", at: AT, detail: {} } as const;
  const key = { reason: "key", at: AT, detail: {} } as const;

  test("a hold is raised when none stands, and the log says so", async () => {
    const r = await rig();
    const started = await r.start();
    expect((await r.steps.ctx.raisePaidHold(credits)).won).toBe(true);
    expect(r.fileOf(started.launchId).paidHold).toEqual(credits);
    expect((await r.orchestrator.get(started.launchId)).log.some((l) => l.kind === "hold-credits")).toBe(true);
  });

  test("a hold for a person displaces a waiting one", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold(waiting);
    expect((await r.steps.ctx.raisePaidHold(forPerson)).won).toBe(true);
    expect(r.fileOf(started.launchId).paidHold).toEqual(forPerson);
  });

  test("a waiting hold never displaces a hold for a person, and the loser is not logged", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold(credits);
    expect((await r.steps.ctx.raisePaidHold(waiting)).won).toBe(false);
    expect(r.fileOf(started.launchId).paidHold).toEqual(credits);
    expect((await r.orchestrator.get(started.launchId)).log.some((l) => l.kind === "hold-network")).toBe(false);
  });

  test("among equals the first stays", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold(credits);
    expect((await r.steps.ctx.raisePaidHold(key)).won).toBe(false);
    await r.steps.ctx.clearPaidHold(credits);
    await r.steps.ctx.raisePaidHold(waiting);
    expect((await r.steps.ctx.raisePaidHold(waiting2)).won).toBe(false);
    expect(r.fileOf(started.launchId).paidHold).toEqual(waiting);
  });

  test("two raises at the same moment: exactly one wins", async () => {
    const r = await rig();
    const started = await r.start();
    const [a, b] = await Promise.all([r.steps.ctx.raisePaidHold(credits), r.steps.ctx.raisePaidHold(key)]);
    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
    expect(["credits", "key"].includes(r.fileOf(started.launchId).paidHold?.reason ?? "")).toBe(true);
  });

  test("a hold is cleared only if it is still the one the caller means", async () => {
    const r = await rig();
    const started = await r.start();
    await r.steps.ctx.raisePaidHold(waiting);
    await r.steps.ctx.raisePaidHold(forPerson);
    expect(await r.steps.ctx.clearPaidHold(waiting)).toBe(false);
    expect(r.fileOf(started.launchId).paidHold).toEqual(forPerson);
    expect(await r.steps.ctx.clearPaidHold(forPerson)).toBe(true);
    expect(r.fileOf(started.launchId).paidHold).toBeNull();
  });

  test("a paused launch takes no hold from a step", async () => {
    const r = await rig();
    const started = await r.start();
    await r.orchestrator.pause(started.launchId);
    await expect(r.steps.ctx.raisePaidHold(credits)).rejects.toThrow();
  });
});
