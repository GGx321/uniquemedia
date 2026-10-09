import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetHoldDetail, MonthRoom } from "../../../shared/autopilot/money";
import type { Estimate } from "../../../shared/engine";
import type { LaunchView } from "../../../shared/engine/autopilot";
import type { StoredSceneSet } from "../../library/sceneSets";
import { sampleSet } from "../../library/testing/sceneSetSample";
import { Budget } from "../../money/budget";
import { Ledger } from "../../money/ledger";
import type { DrawSliceResult, SliceStatus } from "../../sceneSets/launchDraw";
import { LaunchRegistry } from "../../sceneSets/launchRegistry";
import { LaunchGroups } from "../groups";
import type { LaunchFile } from "../launchFile";
import { AUTOPILOT_DIR } from "../launchStore";
import { LaunchStores } from "../lookup";
import { Orchestrator } from "../orchestrator";
import type { LaunchComposePayload, LaunchSliceStart, PaidPort, SliceOutcome } from "../paidPort";
import { createPaidSteps, type PaidStepsDeps } from "../paidSteps";
import type { LaunchStepsContext, StepTimers, TimerHandle } from "../steps";
import { A, B, startInput } from "./launchFixtures";

// Test-only (S4.6b1, shared since S4.6b2): the paid steps against a double of the engine, wired to a real orchestrator, launch store, ledger and Budget group. Not part of the product.

export { A, B };

export const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const roots: string[] = [];
/** Removes the temp folders the rigs made; the test file calls it from its own `afterEach`. */
export async function cleanupRigs(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

export const PHOTO = 210_000;
export const WRITER = 37_500;
export const BIG: MonthRoom = { budgetMicros: 1_000_000_000, committedMicros: 0, freeMicros: 1_000_000_000 };

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function until(condition: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/** A clock and timers a test owns: nothing fires until `advance`. Time starts at T0. */
export class FakeTimers implements StepTimers {
  now = T0;
  #ticks = 0;
  /** A clock that moves a millisecond on every read, so holds written at «the same moment» still differ (a frozen clock hides every identity bug that compares times). */
  readonly clock = (): number => this.now + this.#ticks++;
  readonly #due = new Map<number, { at: number; run: () => void }>();
  #next = 1;
  set(run: () => void, ms: number): number {
    const id = this.#next++;
    this.#due.set(id, { at: this.now + ms, run });
    return id;
  }
  clear(handle: TimerHandle): void {
    if (typeof handle === "number") this.#due.delete(handle);
  }
  /** How many timers are armed. */
  pending(): number {
    return this.#due.size;
  }
  /** Moves the clock and fires every timer that falls due, in order; the work they start runs on the real event loop. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.#due.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.#due.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].run();
    }
    this.now = target;
  }
  iso(offsetMs = 0): string {
    return new Date(this.now + offsetMs).toISOString();
  }
}

export const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** The engine, as far as the paid steps see it. Every method records its call; a method with no behaviour planted refuses, so a stray call fails the test. */
export class FakePort implements PaidPort {
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
  /** The single admission rule (A19): false while `Budget.blocked()` would not be null. */
  admit = true;
  /** How a slice's slots ended, by run id (S4.6b2); absent reads as «no failure». */
  outcomes = new Map<string, SliceOutcome>();

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

  admitted(): boolean {
    this.calls.push("admitted");
    return this.admit;
  }

  async sliceOutcome(runId: string): Promise<SliceOutcome | null> {
    return this.outcomes.get(runId) ?? { slots: 10, checkFailures: 0 };
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

export interface Rig {
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

export interface RigOptions {
  /** Overrides of the steps' own dependencies (timers, clock, retry). */
  steps?: Partial<PaidStepsDeps>;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "studio-paid-steps-"));
  roots.push(root);
  const libraryRoot = join(root, "library");
  await mkdir(libraryRoot, { recursive: true });
  const groups = new LaunchGroups();
  const ledger = await Ledger.open(join(root, "ledger.jsonl"));
  const budget = new Budget(ledger, { runCapMicros: () => 1_000_000_000, groupOf: (req) => groups.groupOf(req), monthlyBudgetMicros: 1_000_000_000, clock: () => T0, monotonic: () => 0 });
  const stores = new LaunchStores();
  const port = new FakePort(budget);
  const steps = createPaidSteps({ port: () => port, retryMs: 5, warn: () => undefined, ...options.steps });
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
    admission: () => (port.admit ? null : { blockedBy: "reconcile-required", error: { code: "RECONCILE_REQUIRED", detail: "the ledger holds open reserves of a previous process" } }),
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
export const LAUNCH = "launch-orch-0001";
export const SET1 = "orch-0002";
export const RUN1 = "orch-0003";
export const SET2 = "orch-0004";
export const RUN2 = "orch-0005";
export const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** A compose that writes the set and answers at once. */
export const composes = (port: FakePort, launchId: string, count = 10) => async (_payload: LaunchComposePayload, ids: { sceneSetId: string; runId: string }) => {
  port.seed({ sceneSetId: ids.sceneSetId, runId: ids.runId, launchId, count });
  return { sceneSetId: ids.sceneSetId, jobId: "job-compose-0001" };
};
