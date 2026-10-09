import type { AvatarAllocation, LaunchEstimate } from "../../shared/autopilot/estimate";
import type { EngineError } from "../../shared/engine";
import {
  LaunchView,
  type AutopilotGetResult,
  type AutopilotListResult,
  type FreeHold,
  type LaunchDraft,
  type LaunchStatus,
  type LaunchSummary,
  type LaunchVideo,
  type LogLine,
  type PaidHold,
  type ResumeBlockedBy,
} from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import type { Budget } from "../money/budget";
import type { LaunchRegistry } from "../sceneSets/launchRegistry";
import { EventCoalescer, COALESCE_INTERVAL_MS } from "./coalescer";
import { launchGroupKey, type LaunchGroups, type LaunchGroupSpec } from "./groups";
import { buildLaunchFile, isEnded, type FileMusic, type LaunchFile } from "./launchFile";
import { entryIdOf, type LaunchStore, type StoreScan } from "./launchStore";
import { launchViewOf, minimalViewOf, type ViewContext } from "./launchView";
import type { LaunchStores } from "./lookup";
import { displaces, sameHold } from "./paidFailures";
import type { LaunchPlan } from "./planner";
import { persistedStatus, transition, type LaunchEvent } from "./states";
import type { LaunchSteps, LaunchStepsContext, MirrorSource } from "./steps";
import type { z } from "zod";

// Stage 4 (plan §3): the orchestrator core. It owns the launch's life, not its work: the launch file, the state machine, the commands, the events and the snapshot. What a
// launch DOES (compose, draw, assign, render) is plugged in through `LaunchSteps` (steps.ts: S4.6b, S4.6c).
//
// The launch FILE is the truth; the orchestrator keeps the one unfinished launch's file in memory only so that the snapshot can be built without a read. Every change goes
// through the store's queue as a read-modify-write on the fresh file, and the state machine is asked INSIDE it, so two clicks can never both act on the same state.

/** What the orchestrator reads of a scene set: the launch it is linked to and the slice runs it recorded. `StoredSceneSet` satisfies it. */
export interface ListedSet {
  readonly sceneSetId: string;
  readonly launchId?: string | undefined;
  readonly launchDraw?: { readonly sceneIds?: readonly number[]; readonly slices: readonly { readonly runId: string; readonly sceneIds?: readonly number[] }[] } | undefined;
  /** What the mirrors need; a real `StoredSceneSet` has them all, a test double may leave them out (it then has no mirror). */
  readonly avatarId?: string;
  readonly revision?: number;
  readonly scenes?: readonly { origin: string; removed: boolean; text: string | null }[];
}

/** What the orchestrator needs of the open library. */
export interface OrchestratorLibrary {
  readonly root: string;
  /** `unreadable` is how many of the avatar's set files could not be read: the slices recorded only there are then missing from what the launch can see. */
  readonly sceneSets: { list(avatarId: string): Promise<{ sets: readonly ListedSet[]; unreadable: number }> };
}

/** What a library's launch files and its sets say, read when the library is OPENED, so that adopting it as the live one is synchronous. */
export interface Prepared {
  scan: StoreScan;
  specs: (LaunchGroupSpec & { finished: boolean })[];
  tail: LogLine[];
  /**
   * Per unfinished launch, the avatars whose scene sets could not be read at open. Slices 2..k live only in a set's `launchDraw`, so such an avatar's spend cannot be seen:
   * its WHOLE allocation counts as committed (the group's cap is lowered by it, and spent and R include it) until its set reads again at the next open (M3, fail closed).
   */
  incomplete: { launchId: string; avatarIds: string[] }[];
  /** The sets each unfinished launch has that the mirrors can be built from (S4.6b1), by launch id. */
  mirrorSets: Map<string, MirrorSource[]>;
}

const EMPTY_PREPARED: Prepared = { scan: { launches: [], unreadable: [], folderUnreadable: false }, specs: [], tail: [], incomplete: [], mirrorSets: new Map() };

/** Why the ledger is closed to paid work (`Budget.blocked()`), with the engine's refusal for it. */
export interface Admission {
  blockedBy: "reconcile-required" | "halt" | "ledger";
  error: EngineError;
}

export interface OrchestratorDeps {
  stores: LaunchStores;
  groups: LaunchGroups;
  registry: LaunchRegistry;
  steps: LaunchSteps;
  /** Epoch milliseconds. */
  clock(): number;
  newId(): string;
  /** The one Budget over the ledger; null when the ledger could not be read. */
  budget(): Budget | null;
  /** `Budget.blocked()` as the engine refuses with it, or null when the ledger is open to paid work. NOT the UI's `reconcileNeeded` (A19). */
  admission(): Admission | null;
  keyState(): "ok" | "missing" | "rejected";
  /** The month's free room with live caps, or null when it cannot be known. */
  roomFreeMicros(): number | null;
  /** Announces a launch that passed `LaunchView.safeParse`. */
  emit(launch: LaunchView): void;
  /** A view broke the contract and was not announced. */
  degrade(): void;
  coalesce?: { intervalMs?: number; now?: () => number; schedule?: (run: () => void, ms: number) => () => void };
  warn?(line: string): void;
  /** The title and artist of a track the free steps gave a video, for the results list; null or absent: the list titles it by the track's id. */
  trackLabel?(music: FileMusic): { title: string; artist: string | null } | null;
  /** Test seam: the view builder. */
  viewOf?: (file: LaunchFile, ctx: ViewContext) => unknown;
}

export interface StartInput {
  draft: LaunchDraft;
  acceptedMicros: number;
  plan: LaunchPlan;
  estimate: LaunchEstimate;
  /** From `allocateLaunch`, for the avatars that are not blocked. */
  allocations: readonly AvatarAllocation[];
}

type ListResult = z.infer<typeof AutopilotListResult>;
type GetResult = z.infer<typeof AutopilotGetResult>;

const TAIL = 20;
const GET_LOG = 500;
const MAX_LISTED = 200;

const fail = (error: EngineError): EngineFailure => new EngineFailure(error);

export class Orchestrator {
  readonly #d: OrchestratorDeps;
  readonly #coalescer: EventCoalescer;
  #store: LaunchStore | null = null;
  /** The library's one unfinished launch, as of the last write. */
  #current: LaunchFile | null = null;
  /** The file the next `autopilot.changed` carries: the latest changed one, an ended launch included. */
  #announced: LaunchFile | null = null;
  #tail: { id: string; lines: LogLine[] } | null = null;
  /** «Ставим на паузу…»: a pause was clicked and the requests in flight are finishing. A view state, never written. */
  #pausing = false;
  /** Set synchronously by `shutdown()`: from then on nothing begins and nothing counts as running (L7, L8). */
  #closing = false;
  /** `host.power` `suspend` (plan §3.8): the Mac is going to sleep. Set synchronously; from then on nothing counts as running and no paid entry point admits, until `resume` (or the owner's own click, which proves the Mac is awake). */
  #suspended = false;
  /** Launches whose stop has begun and not ended (its drain or its last write is under way): a repeated «Стоп» on one that is not here finishes it again (L1). */
  readonly #stopping = new Set<string>();
  /** The avatars of each launch whose scene sets could not be read at open (M3). */
  #incomplete = new Map<string, string[]>();
  #chain: Promise<unknown> = Promise.resolve();
  readonly #background = new Set<Promise<unknown>>();
  /** The restart's rewrites of the launch files: short, and what a read waits for so that it never shows a launch as running that the restart paused. */
  readonly #recovering = new Set<Promise<unknown>>();

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.#coalescer = new EventCoalescer({
      intervalMs: deps.coalesce?.intervalMs ?? COALESCE_INTERVAL_MS,
      now: deps.coalesce?.now ?? (() => performance.now()),
      schedule:
        deps.coalesce?.schedule ??
        ((run, ms) => {
          const timer = setTimeout(run, ms);
          timer.unref();
          return () => clearTimeout(timer);
        }),
      fire: () => this.#fire(),
    });
  }

  // ---------- the library ----------

  /**
   * Reads the library's launch files and what its sets say of them, when the library is OPENED (staged or not), so that `adopt` needs no await. Never throws: what cannot be
   * read is in the store's index as an unreadable entry, which fails closed.
   */
  async prepare(library: OrchestratorLibrary): Promise<Prepared> {
    try {
      const store = this.#d.stores.storeOf(library);
      const scan = await store.scan();
      const specs: Prepared["specs"] = [];
      const mirrors = new Map<string, MirrorSource[]>();
      const incomplete: Prepared["incomplete"] = [];
      for (const launch of scan.launches) {
        const ended = isEnded(launch.status);
        const setIds = new Set<string>();
        const runIds = new Set<string>();
        const cut: string[] = [];
        const mirrorSets: MirrorSource[] = [];
        for (const row of launch.avatars) {
          // The sets' own `launchDraw.slices` name runs the launch file does not (§19): a slice run left out would reserve outside the group.
          const listed = ended ? { sets: [] as readonly ListedSet[], unreadable: 0 } : await library.sceneSets.list(row.avatarId).catch((): { sets: readonly ListedSet[]; unreadable: number } => ({ sets: [], unreadable: 1 }));
          if (listed.unreadable > 0) {
            // N1: an avatar whose sets cannot all be read has its WHOLE allocation counted as spent (below), so none of its sets or runs joins the group: its ledger lines would be counted twice.
            cut.push(row.avatarId);
            continue;
          }
          if (row.generation !== null) {
            setIds.add(row.generation.sceneSetId);
            runIds.add(row.generation.setRunId);
          }
          for (const set of listed.sets) {
            if (set.launchId !== launch.launchId) continue;
            setIds.add(set.sceneSetId);
            if (set.avatarId !== undefined && set.revision !== undefined && set.scenes !== undefined) mirrorSets.push({ sceneSetId: set.sceneSetId, avatarId: set.avatarId, revision: set.revision, scenes: set.scenes, launchDraw: set.launchDraw?.sceneIds === undefined ? undefined : { sceneIds: set.launchDraw.sceneIds, slices: set.launchDraw.slices.map((s) => ({ sceneIds: s.sceneIds ?? [] })) } });
            for (const slice of set.launchDraw?.slices ?? []) runIds.add(slice.runId);
          }
        }
        const unseen = launch.avatars.filter((a) => cut.includes(a.avatarId)).reduce((sum, a) => sum + a.allocation.composeMicros + a.allocation.drawMicros, 0);
        if (cut.length > 0) incomplete.push({ launchId: launch.launchId, avatarIds: cut });
        mirrors.set(launch.launchId, mirrorSets);
        specs.push({ launchId: launch.launchId, capMicros: Math.max(0, launch.plannedWorstMicros - unseen), setIds: [...setIds], runIds: [...runIds], finished: ended });
      }
      const newest = scan.launches.find((l) => !isEnded(l.status));
      const tail = newest === undefined ? [] : await store.readLog(newest.launchId, TAIL).catch(() => []);
      return { scan, specs, tail, incomplete, mirrorSets: mirrors };
    } catch (error) {
      this.#warn(`studio engine: the launch files could not be read (${error instanceof Error ? error.name : typeof error})`);
      return EMPTY_PREPARED;
    }
  }

  /**
   * The library just became the live one (or none is). Synchronous, so a library switch stays atomic with its busy check: the Budget groups are restored from the launch
   * files before any paid command can run, a launch that was running reads as paused (a restart never lets one run, A5), and the persisted rewrite of that, and the end of a
   * stop a restart found under way, follow in the background (`settled()`).
   */
  adopt(library: OrchestratorLibrary | null, prepared: Prepared | null): void {
    // What is waiting is announced first: a terminal state of the library being left must not be dropped (L3).
    this.#coalescer.flush();
    this.#coalescer.dispose();
    this.#incomplete = new Map((prepared?.incomplete ?? []).map((i) => [i.launchId, i.avatarIds]));
    this.#pausing = false;
    this.#current = null;
    this.#announced = null;
    this.#tail = null;
    this.#store = library === null ? null : this.#d.stores.storeOf(library);
    this.#d.stores.adopt(library);
    this.#d.groups.restore(prepared?.specs ?? []);
    if (library === null || prepared === null) return;
    const unfinished = prepared.scan.launches.filter((l) => !isEnded(l.status));
    const newest = unfinished[0];
    if (newest !== undefined) {
      this.#current = restarted(newest, this.#nowIso(), this.#nowMs()).file;
      this.#tail = { id: newest.launchId, lines: [...prepared.tail] };
    }
    for (const launch of unfinished) this.#d.steps.restore?.(launch.launchId, prepared.mirrorSets.get(launch.launchId) ?? []);
    for (const launch of unfinished) this.#trackRecovery(this.#serial(() => this.#recover(launch.launchId)));
  }

  /** Resolves once the background work is done (the restart's rewrites, a drain that ended) and the announcements are out. Tests wait on it. */
  async settled(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.#background, ...this.#recovering, this.#chain]);
      if (this.#background.size === 0 && this.#recovering.size === 0) break;
    }
    this.flushEvents();
  }

  flushEvents(): void {
    this.#coalescer.flush();
  }

  // ---------- what the engine asks ----------

  snapshotView(): LaunchView | null {
    return this.#current === null ? null : this.#validView(this.#current);
  }

  /** True while a launch is running, pausing or stopping: the library cannot be switched under it, even between two of its jobs. A paused launch stays with its library. */
  blocksLibrarySwitch(): boolean {
    const file = this.#current;
    if (file === null) return false;
    const status = this.#status(file);
    return status === "running" || status === "pausing" || status === "stopping";
  }

  /**
   * Synchronous: whether paid work of this launch may start now. The launch must be the current one, `running` (not pausing, stopping, paused, closing) and hold no paid hold.
   * The engine's internal paid entry points ask it first, so a step that was already past its own check cannot spend for a launch that has since been stopped.
   */
  mayPay(launchId: string): boolean {
    const file = this.#current;
    return file !== null && file.launchId === launchId && !this.#closing && !this.#pausing && !this.#suspended && file.status === "running" && file.paidHold === null;
  }

  /**
   * `host.power` (plan §3.8, S4.6b2), the engine's side. `suspend`: synchronously, before the queue, nothing counts as running and no paid entry point admits; the steps soft-stop what they have
   * in flight and hold their timers. No attempt already sent is aborted (A6). `resume`: when the launch ran before the sleep, the steps put right what the sleep interrupted and go on
   * (`wake`, else `begin`); a launch that is paused, held by its owner or ended is left as it is. A `resume` without a `suspend` changes nothing.
   */
  power(state: "suspend" | "resume"): Promise<void> {
    if (state === "suspend") {
      this.#suspended = true;
      try {
        this.#d.steps.suspend?.();
      } catch (error) {
        this.#warn(`studio engine: the steps could not be told of the sleep (${error instanceof Error ? error.name : typeof error})`);
      }
      return Promise.resolve();
    }
    return this.#serial(async () => {
      if (!this.#suspended) return;
      this.#suspended = false;
      const file = this.#current;
      if (file === null || this.#closing || this.#pausing || file.status !== "running") return;
      const ctx = this.#ctx(file.launchId);
      const steps = this.#d.steps;
      // Not awaited: a wake-up may arm timers and await the ledger test, and a «Пауза» must not wait behind it.
      this.#track(steps.wake === undefined ? Promise.resolve(steps.begin(ctx)) : steps.wake(ctx));
    });
  }

  /** Whether the unfinished launch (paused included) has this avatar: it cannot be deleted. */
  holdsAvatar(avatarId: string): boolean {
    return this.#current?.draft.avatarIds.includes(avatarId) ?? false;
  }

  /** What would refuse a start: a launch that is unfinished (any), and an entry of `autopilot/` that cannot be read (it may describe an active launch). */
  async startBlockers(): Promise<{ active: boolean; unreadable: boolean }> {
    const store = this.#store;
    if (store === null) return { active: false, unreadable: false };
    const scan = await store.scan();
    return { active: this.#current !== null || scan.launches.some((l) => !isEnded(l.status)), unreadable: scan.unreadable.length > 0 };
  }

  // ---------- the commands ----------

  /** `library` is the one the start was planned against: a start that finds another one live (a switch landed meanwhile) is refused, never split between two (M2). */
  start(input: StartInput, library: OrchestratorLibrary): Promise<LaunchView> {
    return this.#serial(async () => {
      this.#assertOpen();
      const store = this.#needStore();
      if (store !== this.#d.stores.storeOf(library)) throw fail({ code: "IN_FLIGHT", detail: "the library changed while the launch was being started; start it again" });
      const blockers = await this.startBlockers();
      if (blockers.active) throw fail({ code: "IN_FLIGHT", detail: "a launch is already unfinished in this library; stop it or wait for it to end" });
      if (blockers.unreadable) throw fail({ code: "VALIDATION", launchReason: "launch-unreadable", detail: "a launch file cannot be read; remove the entry first" });
      const launchId = `launch-${this.#d.newId()}`;
      const draft = buildLaunchFile({ ...input, launchId, createdAt: this.#nowIso(), newId: () => this.#d.newId() });
      const file = await store.create(draft);
      // The file is on disk: from here the ids and the allocations survive a kill. The group is registered before the first reserve, which only the steps can make.
      const sets = file.avatars.flatMap((a) => (a.generation === null ? [] : [a.generation.sceneSetId]));
      const runs = file.avatars.flatMap((a) => (a.generation === null ? [] : [a.generation.setRunId]));
      this.#d.groups.register({ launchId, capMicros: file.plannedWorstMicros, setIds: sets, runIds: runs });
      this.#current = file;
      this.#pausing = false;
      this.#suspended = false;
      this.#tail = { id: launchId, lines: [] };
      this.#announce(file);
      await this.#log(launchId, { at: this.#nowIso(), kind: "start", acceptedMicros: input.acceptedMicros });
      if (!this.#closing) this.#d.steps.begin(this.#ctx(launchId));
      return this.#answer(this.#current ?? file);
    });
  }

  pause(launchId: string): Promise<LaunchView> {
    return this.#serial(async () => {
      const file = await this.#needCurrent(launchId);
      this.#expect(file, "pause");
      this.#pausing = true;
      const { requests, renders } = this.#d.steps.inFlight();
      await this.#log(launchId, { at: this.#nowIso(), kind: "pausing", requests, renders });
      this.#announce(file);
      const drained = this.#drain();
      if (requests === 0 && renders === 0) {
        await drained;
        return this.#settlePause(launchId);
      }
      this.#track(drained.then(() => this.#serial(() => this.#settlePause(launchId))));
      return this.#answer(file);
    });
  }

  resume(launchId: string, acceptedRemainingMicros: number): Promise<LaunchView> {
    return this.#serial(async () => {
      this.#assertOpen();
      const file = await this.#needCurrent(launchId);
      const status = this.#status(file);
      // «Продолжить» also clears a paid hold of a launch that runs; a launch that runs with no hold has nothing to continue.
      if (status === "running" && file.paidHold === null && this.#suspended) {
        // A lost wake-up: the launch runs, nothing holds it, and the screen says so, but the engine still believes the Mac sleeps. The click proves it does not.
        this.#suspended = false;
        if (!this.#closing) this.#d.steps.begin(this.#ctx(launchId));
        return this.#answer(file);
      }
      const clearsHold = status === "running" && file.paidHold !== null;
      if (!clearsHold) this.#expect(file, "resume");
      const at = this.#nowIso();
      // Every check is made on the FRESH file inside the rewrite: a step may have set a hold since the click was read, and a hold is never erased unseen (M1).
      const resumed = await this.#write(launchId, (f) => {
        const fresh = this.#status(f);
        if (fresh !== "paused" && !(fresh === "running" && f.paidHold !== null)) throw wrongState(f.launchId, fresh, "resume");
        const blocked = this.#blockage(f);
        if (blocked !== null) throw fail(blocked.error);
        const remaining = Math.max(0, f.plannedWorstMicros - this.#spentOf(f));
        if (remaining > acceptedRemainingMicros) {
          throw fail({ code: "PRICE_CHANGED", detail: `the launch's remaining worst case is now ${remaining} µ$, above the accepted ${acceptedRemainingMicros} µ$` });
        }
        return { ...f, status: "running", paused: null, paidHold: null, activeSince: f.activeSince ?? at };
      });
      await this.#log(launchId, { at, kind: "resumed", acceptedRemainingMicros });
      // The owner clicked: the Mac is awake, whatever became of the wake-up message.
      this.#suspended = false;
      if (!this.#closing) this.#d.steps.begin(this.#ctx(launchId));
      return this.#answer(resumed);
    });
  }

  stop(launchId: string): Promise<LaunchView> {
    return this.#serial(async () => {
      const file = await this.#needCurrent(launchId);
      if (file.status === "stopping" && !this.#stopping.has(launchId)) {
        // A stop whose last write failed left the launch in «stopping» with nothing under way: the repeated click finishes it (release is idempotent, L1).
        this.#stopping.add(launchId);
        await this.#drain();
        return this.#answer(await this.#completeStop(launchId));
      }
      this.#expect(file, "stop");
      const now = this.#nowMs();
      // «stopping» is persisted FIRST: a quit during «Останавливаем…» finishes the stop on the next start and never reads as a pause.
      const stopping = await this.#write(launchId, (f) => {
        const fresh = this.#status(f);
        if (!transition(fresh, "stop").ok) throw wrongState(f.launchId, fresh, "stop");
        return { ...closeActive(f, now), status: "stopping", paused: null };
      });
      this.#pausing = false;
      this.#stopping.add(launchId);
      const { requests, renders } = this.#d.steps.inFlight();
      const drained = this.#drain();
      if (requests === 0 && renders === 0) {
        await drained;
        return this.#answer(await this.#completeStop(launchId));
      }
      this.#track(drained.then(() => this.#serial(() => this.#completeStop(launchId))));
      return this.#answer(stopping);
    });
  }

  /**
   * «Продолжить запуск: M фото» (S4.6b1, plan §4.7): the owner reviewed an avatar's scenes. The avatar must be waiting for exactly this set in `awaiting-review` (else
   * `not-awaiting`, which also answers a second click); the steps approve the set (SCENES_CHANGED, `over-plan` come from there) and, while the launch runs, start the draw.
   * While it is paused or pausing the approval is only recorded: the avatar waits as «approved, waits for Продолжить» and the draw starts with «Продолжить» (§18 item 9).
   */
  continueAfterReview(input: { launchId: string; avatarId: string; sceneSetId: string; revision: number }): Promise<{ launch: LaunchView; draw: "started" | "waits-for-resume" }> {
    return this.#serial(async () => {
      this.#assertOpen();
      const file = await this.#needCurrent(input.launchId);
      const notAwaiting = (): EngineFailure => fail({ code: "VALIDATION", sceneReason: "not-awaiting", detail: `avatar ${input.avatarId} is not waiting for the review of scene set ${input.sceneSetId}` });
      const status = this.#status(file);
      if (isEnded(status) || status === "stopping") throw notAwaiting();
      const row = file.avatars.find((a) => a.avatarId === input.avatarId);
      if (row === undefined || row.generation?.sceneSetId !== input.sceneSetId || row.phase !== "awaiting-review") throw notAwaiting();
      const review = this.#d.steps.continueAfterReview;
      if (review === undefined) throw notAwaiting();
      const outcome = await review.call(this.#d.steps, this.#ctx(file.launchId), { avatarId: input.avatarId, sceneSetId: input.sceneSetId, revision: input.revision });
      const at = this.#nowIso();
      if (outcome.draw === "waits-for-resume") {
        // The launch is not running, so the steps may not write: the core records that the approval is given and the draw waits.
        await this.#write(file.launchId, (f) => ({ ...f, avatars: f.avatars.map((a) => (a.avatarId === input.avatarId && a.phase === "awaiting-review" ? { ...a, phase: "approved-waiting" as const } : a)) }));
        await this.#log(file.launchId, { at, kind: "review-approved-paused", avatarId: input.avatarId, photos: outcome.photos });
      } else {
        await this.#log(file.launchId, { at, kind: "review-continued", avatarId: input.avatarId, photos: outcome.photos, writtenByOwner: 0 });
      }
      return { launch: this.#answer(this.#current ?? (await this.#needCurrent(file.launchId))), draw: outcome.draw };
    });
  }

  /** The quit: a launch that runs is persisted as paused by «quit» and the steps are told to start nothing new. Whatever is in flight dies with the process. */
  shutdown(): Promise<void> {
    // Synchronously, before the queue: from this instant steps are not running and nothing new begins (L7, L8).
    this.#closing = true;
    return this.#serial(async () => {
      const file = this.#current;
      if (file === null || file.status !== "running") return;
      const { requests } = this.#d.steps.inFlight();
      void this.#drain();
      const now = this.#nowMs();
      const at = this.#nowIso();
      await this.#write(file.launchId, (f) => (f.status !== "running" ? null : { ...closeActive(f, now), status: "paused", paused: { cause: "quit", at } }));
      this.#pausing = false;
      await this.#log(file.launchId, { at, kind: "host-quit", requests });
      this.flushEvents();
    });
  }

  async list(): Promise<ListResult> {
    const store = this.#needStore();
    await Promise.allSettled([...this.#recovering]);
    const scan = await store.scan();
    const launches = scan.launches.slice(0, MAX_LISTED).map((file): LaunchSummary => {
      const current = this.#current?.launchId === file.launchId ? this.#current : file;
      return {
        launchId: file.launchId,
        createdAt: file.createdAt,
        endedAt: file.endedAt,
        status: this.#status(current),
        avatarCount: file.avatars.length,
        avatarIds: file.avatars.map((a) => a.avatarId),
        videosDone: file.avatars.reduce((sum, a) => sum + a.videos.filter((v) => v.state === "done").length, 0),
        videosPlanned: file.plan.videos,
        spentMicros: this.#spentOf(file),
        acceptedMicros: file.acceptedMicros,
        plannedWorstMicros: file.plannedWorstMicros,
      };
    });
    return { launches, unreadable: scan.unreadable.slice(0, MAX_LISTED).map(({ entryId, reason }) => ({ entryId, reason })) };
  }

  async get(launchId: string): Promise<GetResult> {
    const store = this.#needStore();
    await Promise.allSettled([...this.#recovering]);
    const read = await store.read(launchId);
    if (!read.ok) throw fail({ code: "NOT_FOUND", detail: `no launch ${launchId} in the open library` });
    const log = await store.readLog(launchId, GET_LOG).catch(() => []);
    const file = this.#current?.launchId === launchId ? this.#current : read.file;
    const view = this.#validView(file, log.slice(-TAIL));
    if (view === null) throw fail({ code: "INTERNAL", detail: "the launch's view does not fit the contract" });
    return { launch: view, log, videos: read.file.avatars.flatMap((a) => a.videos.flatMap((v) => videoOf(a.avatarId, v, this.#d.trackLabel))) };
  }

  /** `NOT_FOUND` when no plain unreadable entry matches the id, or the file reads fine now (it is never moved). */
  async removeUnreadable(entryId: string): Promise<void> {
    const store = this.#store;
    // The file of the launch that is current is never "an entry nobody holds", however it reads now (L6).
    const current = this.#current;
    if (current !== null && entryId === entryIdOf(`${current.launchId}.json`)) throw fail({ code: "NOT_FOUND", detail: "no unreadable launch entry matches" });
    if (store === null || !(await store.removeUnreadable(entryId))) throw fail({ code: "NOT_FOUND", detail: "no unreadable launch entry matches" });
  }

  // ---------- the state machine ----------

  #status(file: LaunchFile): LaunchStatus {
    return this.#pausing && this.#current?.launchId === file.launchId && file.status === "running" ? "pausing" : file.status;
  }

  /** Refuses (VALIDATION) the event the table does not allow from the launch's status. */
  #expect(file: LaunchFile, action: "pause" | "resume" | "stop"): void {
    const event: LaunchEvent = action;
    const status = this.#status(file);
    if (!transition(status, event).ok) throw wrongState(file.launchId, status, action);
  }

  async #settlePause(launchId: string): Promise<LaunchView> {
    const now = this.#nowMs();
    const at = this.#nowIso();
    const settled = await this.#write(launchId, (f) => (f.status === "running" && this.#pausing ? { ...closeActive(f, now), status: "paused", paused: { cause: "owner", at } } : null));
    if (settled.status === "paused") {
      this.#pausing = false;
      await this.#log(launchId, { at, kind: "paused" });
    }
    return this.#answer(settled);
  }

  /** The end of a stop, whether it was clicked or a restart found it under way: release what the launch holds, then end it. */
  async #completeStop(launchId: string): Promise<LaunchFile> {
    this.#stopping.add(launchId);
    try {
      return await this.#completeStopOnce(launchId);
    } finally {
      this.#stopping.delete(launchId);
    }
  }

  async #completeStopOnce(launchId: string): Promise<LaunchFile> {
    try {
      await this.#d.steps.release(this.#ctx(launchId));
    } catch {
      // A launch whose sets could not be unlinked still ends: a stopped launch is no link at all (the unlinked rule), so nothing stays locked.
      this.#warn(`studio engine: launch ${launchId} could not release everything it held`);
    }
    const spent = this.#finalSpent(launchId);
    const at = this.#nowIso();
    const ended = await this.#write(launchId, (f) => ({
      ...f,
      status: "stopped",
      endedAt: at,
      activeSince: null,
      paused: null,
      spentMicros: spent,
      avatars: f.avatars.map((a) => ({
        ...a,
        videos: a.videos.map((v) => (v.state === "done" || v.state === "dropped" ? v : { ...v, state: "dropped" as const, dropReason: "launch-stopped" as const })),
      })),
    }));
    await this.#log(launchId, { at, kind: "stopped", spentMicros: spent });
    this.#d.groups.finish(launchId);
    this.#pausing = false;
    return ended;
  }

  /** At an adopted library: a launch that was running is paused by the restart, and a stop under way is finished. */
  async #recover(launchId: string): Promise<void> {
    const store = this.#store;
    if (store === null) return;
    const now = this.#nowMs();
    const at = this.#nowIso();
    const outcome = { paused: false };
    try {
      const file = await store.update(launchId, (current) => {
        const read = restarted(current, at, now);
        outcome.paused = read.changed;
        return read.changed ? read.file : null;
      });
      if (this.#current?.launchId === launchId) this.#current = file;
      if (outcome.paused) {
        const cause = file.paused?.cause === "quit" ? "quit" : "engine-restart";
        await this.#log(launchId, { at, kind: "app-restarted", cause, requests: this.#openReservesOf(launchId).requests });
        this.#announce(file);
      }
      if (file.status === "stopping") {
        const ended = await this.#completeStop(launchId);
        this.#announce(ended);
      }
    } catch (error) {
      this.#warn(`studio engine: launch ${launchId} could not be read again after the restart (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  // ---------- admission (A19) ----------

  /**
   * Whether «Продолжить» may let paid work run, by the ONE rule: `Budget.blocked()` (reserves of a previous process, a torn line, a halt: the engine's `admission`) plus
   * the launch's own hold, per reason (§18 item 7). Never the UI's `reconcileNeeded`, which turns on for any reserve of this session left open. A launch with no paid work
   * (W′ = 0) needs neither the ledger nor the key.
   */
  #blockage(file: LaunchFile): { by: ResumeBlockedBy; error: EngineError } | null {
    if (file.plannedWorstMicros > 0) {
      const gate = this.#d.admission();
      if (gate !== null) return { by: gate.blockedBy, error: gate.error };
      const key = this.#d.keyState();
      if (key !== "ok") {
        const detail = key === "missing" ? "no OpenRouter API key is stored; add one in Settings to continue the launch" : "OpenRouter rejected the stored API key (401); store a new key to continue the launch";
        return { by: "key", error: { code: "AUTH_INVALID", detail } };
      }
    }
    const hold = file.paidHold;
    if (hold === null) return null;
    switch (hold.reason) {
      case "budget": {
        const free = this.#d.roomFreeMicros();
        if (free !== null && free >= hold.detail.needMicros) return null;
        return { by: "budget", error: { code: "VALIDATION", detail: `the month has ${free ?? "an unknown amount of"} µ$ of room, the held step needs ${hold.detail.needMicros} µ$` } };
      }
      case "network":
        // A hold with a retry still to come is the wait of an automatic continue: the person who clicks now only skips the wait, under the same ledger test as the timer (above).
        if (hold.detail.nextAt !== null) return null;
        return this.#openReservesOf(file.launchId).requests === 0
          ? null
          : { by: "network", error: { code: "VALIDATION", detail: "requests of the launch got no answer; reconcile in Settings first, then continue" } };
      case "internal":
        return { by: "internal", error: { code: "VALIDATION", detail: "the launch's own check failed; its only exit is «Стоп»" } };
      case "credits":
      case "key":
      case "halt":
      case "price":
      case "price-unavailable":
        return null;
    }
  }

  #resumeBlockedBy(file: LaunchFile): ResumeBlockedBy | null {
    const status = this.#status(file);
    if (!(status === "paused" || (status === "running" && file.paidHold !== null))) return null;
    return this.#blockage(file)?.by ?? null;
  }

  // ---------- money ----------

  #spentOf(file: LaunchFile): number {
    if (isEnded(file.status)) return file.spentMicros;
    return this.#spentNow(file.launchId, file.spentMicros) + this.#unseenOf(file);
  }

  /** An avatar whose scene set could not be read at open may have slices the ledger's group does not know: its whole allocation counts as spent (M3, N1). */
  #unseenOf(file: LaunchFile): number {
    return file.avatars.filter((a) => this.#incomplete.get(file.launchId)?.includes(a.avatarId) === true).reduce((sum, a) => sum + a.allocation.composeMicros + a.allocation.drawMicros, 0);
  }

  /** The sum a launch ends with: the ledger's, and the unseen allocation of the avatars whose sets could not be read (N1). */
  #finalSpent(launchId: string): number {
    const file = this.#current?.launchId === launchId ? this.#current : null;
    return this.#spentNow(launchId) + (file === null ? 0 : this.#unseenOf(file));
  }

  /** The very sum the Budget enforces (§19): settled at cost, open at worst, held, over the launch's group. The file's last one when the ledger cannot say. */
  #spentNow(launchId: string, fallback = this.#current?.spentMicros ?? 0): number {
    const budget = this.#d.budget();
    if (budget === null) return fallback;
    try {
      return budget.committedOfGroup(launchGroupKey(launchId));
    } catch {
      return fallback;
    }
  }

  #openReservesOf(launchId: string): { requests: number; openMicros: number } {
    const budget = this.#d.budget();
    if (budget === null) return { requests: 0, openMicros: 0 };
    const key = launchGroupKey(launchId);
    let requests = 0;
    let openMicros = 0;
    for (const reserve of budget.ledger.openReserves()) {
      if (this.#d.groups.groupOf({ attemptId: reserve.attemptId, scope: reserve.scope })?.key !== key) continue;
      requests += 1;
      openMicros += reserve.worstMicros;
    }
    return { requests, openMicros };
  }

  // ---------- the file ----------

  /** Rewrites the launch under the store's queue; refreshes the sum from the ledger, keeps the in-memory copy, and announces. */
  async #write(launchId: string, change: (current: LaunchFile) => LaunchFile | null): Promise<LaunchFile> {
    const store = this.#needStore();
    const file = await store.update(launchId, (current) => {
      const next = change(current);
      if (next === null) return null;
      return isEnded(next.status) ? next : { ...next, spentMicros: this.#spentNow(launchId, next.spentMicros) };
    });
    if (this.#current?.launchId === launchId) this.#current = isEnded(file.status) ? null : file;
    this.#announce(file);
    return file;
  }

  async #needCurrent(launchId: string): Promise<LaunchFile> {
    if (this.#current?.launchId === launchId) return this.#current;
    const store = this.#needStore();
    const read = await store.read(launchId);
    if (!read.ok) throw fail({ code: "NOT_FOUND", detail: `no launch ${launchId} in the open library` });
    // A launch that is over: its state is what the clicks are refused with.
    return read.file;
  }

  #needStore(): LaunchStore {
    if (this.#store === null) throw fail({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    return this.#store;
  }

  // ---------- the steps' context ----------

  #ctx(launchId: string): LaunchStepsContext {
    return {
      launchId,
      registry: this.#d.registry,
      groups: this.#d.groups,
      file: () => {
        if (this.#current?.launchId !== launchId) throw new Error(`launch ${launchId} is over`);
        return this.#current;
      },
      isRunning: () => !this.#closing && this.#current?.launchId === launchId && this.#current.status === "running" && !this.#pausing && !this.#suspended,
      update: (change) => this.#stepWrite(launchId, change),
      raisePaidHold: async (hold) => {
        // Decided on the fresh file inside the store's own write: two tasks that fail at the same moment cannot both believe they hold the launch.
        let won = false;
        await this.#stepWrite(launchId, (f) => {
          if (f.paidHold !== null && !displaces(hold, f.paidHold)) return null;
          won = true;
          return { ...f, paidHold: hold };
        });
        if (won) await this.#log(launchId, holdLine(hold, this.#nowIso()));
        return { won };
      },
      clearPaidHold: async (expected) => {
        let cleared = false;
        await this.#stepWrite(launchId, (f) => {
          if (f.paidHold === null || !sameHold(f.paidHold, expected)) return null;
          cleared = true;
          return { ...f, paidHold: null };
        });
        return cleared;
      },
      setFreeHold: async (hold) => {
        const file = await this.#stepWrite(launchId, (f) => ({ ...f, freeHold: hold }));
        if (hold !== null) await this.#log(launchId, { at: this.#nowIso(), kind: "hold-export", exportReason: hold.detail.exportReason });
        return file;
      },
      log: (line) => this.#log(launchId, line),
      finish: () => {
        // Refused at once for a launch that does not run: a step that waits in the core's queue while a stop drains it would hold the drain for ever.
        if (this.#current?.launchId !== launchId || this.#current.status !== "running") return Promise.reject(new Error(`launch ${launchId} is not running: only a running launch finishes`));
        return this.#serial(() => this.#finish(launchId));
      },
      isCut: (avatarId) => this.#incomplete.get(launchId)?.includes(avatarId) === true,
      touch: () => {
        if (this.#current?.launchId === launchId) this.#announce(this.#current);
      },
    };
  }

  /** A step's write: only while the launch runs (or is stopping): nothing continues during «Пауза» (A13) and nothing after the end. */
  #stepWrite(launchId: string, change: (file: LaunchFile) => LaunchFile | null): Promise<LaunchFile> {
    return this.#write(launchId, (f) => {
      if (f.status !== "running" && f.status !== "stopping") throw new Error(`launch ${launchId} is ${f.status}: nothing of it continues`);
      return change(f);
    });
  }

  async #finish(launchId: string): Promise<LaunchFile> {
    // The group is closed and the sum read at this moment, so nothing of the launch may be in flight: a live job would reserve outside the group from now on (fix round 1).
    const flight = this.#d.steps.inFlight();
    if (flight.requests > 0 || flight.renders > 0) throw new Error(`launch ${launchId} still has work in flight (${flight.requests} requests, ${flight.renders} renders): it cannot finish`);
    // A pause (or a stop) that landed first wins: nothing is released for a launch that is not running now.
    if (this.#current?.launchId !== launchId || this.#current.status !== "running" || this.#pausing) throw new Error(`launch ${launchId} is not running: only a running launch finishes`);
    try {
      await this.#d.steps.complete?.(this.#ctx(launchId));
    } catch {
      this.#warn(`studio engine: launch ${launchId} could not release everything it held at its end`);
    }
    const spent = this.#finalSpent(launchId);
    const now = this.#nowMs();
    const at = this.#nowIso();
    const done = await this.#write(launchId, (f) => {
      if (f.status !== "running") throw new Error(`launch ${launchId} is ${f.status}: only a running launch finishes`);
      return { ...closeActive(f, now), status: "done", endedAt: at, spentMicros: spent };
    });
    const videosDone = done.avatars.reduce((sum, a) => sum + a.videos.filter((v) => v.state === "done").length, 0);
    await this.#log(launchId, { at, kind: "done", videosDone, videosPlanned: done.plan.videos });
    this.#d.groups.finish(launchId);
    this.#pausing = false;
    return done;
  }

  // ---------- the soft stop ----------

  /** `LaunchSteps.drain`, which never rejects by contract; a step that breaks that contract must not leave a pause or a stop hanging. */
  #drain(): Promise<void> {
    return this.#d.steps.drain().catch(() => {
      this.#warn("studio engine: a launch step failed while draining; the stop goes on");
    });
  }

  // ---------- the log ----------

  async #log(launchId: string, line: LogLine): Promise<void> {
    if (this.#tail?.id === launchId) this.#tail = { id: launchId, lines: [...this.#tail.lines, line].slice(-TAIL) };
    try {
      await this.#store?.appendLog(launchId, line);
    } catch {
      this.#warn(`studio engine: a line of launch ${launchId}'s log could not be written (${line.kind})`);
    }
    if (this.#current?.launchId === launchId) this.#announce(this.#current);
  }

  // ---------- views and events ----------

  #viewContext(file: LaunchFile, tail?: readonly LogLine[]): ViewContext {
    const status = this.#status(file);
    const live = status === "running" || status === "pausing" || status === "stopping";
    return {
      status,
      nowMs: this.#nowMs(),
      spentMicros: this.#spentOf(file),
      inFlight: live ? this.#openReservesOf(file.launchId) : { requests: 0, openMicros: 0 },
      resumeBlockedBy: this.#resumeBlockedBy(file),
      logTail: tail ?? (this.#tail?.id === file.launchId ? this.#tail.lines : []),
      mirror: (avatarId) => this.#d.steps.mirror?.(file.launchId, avatarId) ?? null,
    };
  }

  /**
   * The view, checked against the contract (§19). A view that breaks it is never announced as it is. L2 (S4.6b1): the engine is told, and the owner gets the smallest view that
   * does fit (`minimalViewOf`: no log, no set mirrors), so a running paid launch is never hidden and «Стоп» stays reachable. Only when even that does not fit is there none.
   */
  #validView(file: LaunchFile, tail?: readonly LogLine[]): LaunchView | null {
    const context = this.#viewContext(file, tail);
    try {
      const parsed = LaunchView.safeParse((this.#d.viewOf ?? launchViewOf)(file, context));
      if (parsed.success) return parsed.data;
    } catch {
      // A view that cannot even be built is the same as one that breaks the contract.
    }
    this.#d.degrade();
    try {
      const minimal = LaunchView.safeParse(minimalViewOf(file, context));
      if (minimal.success) return minimal.data;
    } catch {
      // Not even the minimal view could be built.
    }
    return null;
  }

  #answer(file: LaunchFile): LaunchView {
    const view = this.#validView(file);
    if (view === null) throw fail({ code: "INTERNAL", detail: "the launch's view does not fit the contract" });
    return view;
  }

  #announce(file: LaunchFile): void {
    // A change of launch sends what waits first: the last state of the one before (a stop, an end) is never dropped by being replaced (L3).
    if (this.#announced !== null && this.#announced.launchId !== file.launchId) this.#coalescer.flush();
    this.#announced = file;
    this.#coalescer.request();
  }

  #fire(): void {
    const file = this.#announced;
    if (file === null) return;
    const live = this.#current?.launchId === file.launchId ? this.#current : file;
    const view = this.#validView(live);
    if (view !== null) this.#d.emit(view);
  }

  // ---------- plumbing ----------

  /** After `shutdown()` nothing new starts. */
  #assertOpen(): void {
    if (this.#closing) throw fail({ code: "IN_FLIGHT", detail: "the engine is shutting down; nothing new starts" });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.then(
      () => undefined,
      (error: unknown) => this.#warn(`studio engine: a launch step ended with an error (${error instanceof Error ? error.name : typeof error})`),
    );
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }

  #trackRecovery(promise: Promise<unknown>): void {
    const tracked = promise.then(
      () => undefined,
      (error: unknown) => this.#warn(`studio engine: a launch could not be recovered after the restart (${error instanceof Error ? error.name : typeof error})`),
    );
    this.#recovering.add(tracked);
    void tracked.finally(() => this.#recovering.delete(tracked));
  }

  #nowMs(): number {
    return this.#d.clock();
  }

  #nowIso(): string {
    return new Date(this.#d.clock()).toISOString();
  }

  #warn(line: string): void {
    (this.#d.warn ?? ((l: string) => console.warn(l)))(line);
  }
}

// ---------- pure helpers ----------

function wrongState(launchId: string, status: LaunchStatus, action: string): EngineFailure {
  return fail({ code: "VALIDATION", detail: `launch ${launchId} is ${status}: it cannot be asked to ${action} now` });
}

/** The file with the time of the work done so far added up and the clock stopped. */
function closeActive(file: LaunchFile, nowMs: number): LaunchFile {
  const since = file.activeSince === null ? null : Date.parse(file.activeSince);
  return { ...file, activeMs: file.activeMs + (since === null ? 0 : Math.max(0, nowMs - since)), activeSince: null };
}

/**
 * How a launch reads after a restart (plan §3.8): `running` (and `pausing`, which is written as running) is `paused` by the restart, with the time up to its last write
 * counted; `paused`, `stopping` (finished by the caller), `done` and `stopped` stay as they are.
 */
function restarted(file: LaunchFile, atIso: string, nowMs: number): { file: LaunchFile; changed: boolean } {
  if (persistedStatus(file.status) !== "running") return { file, changed: false };
  const lastWrite = Date.parse(file.updatedAt);
  const closed = closeActive(file, Number.isNaN(lastWrite) ? nowMs : Math.min(nowMs, lastWrite));
  return { file: { ...closed, status: "paused", paused: { cause: "engine-restart", at: atIso } }, changed: true };
}

function holdLine(hold: PaidHold, at: string): LogLine {
  switch (hold.reason) {
    case "budget":
      return { at, kind: "hold-budget", holdKind: hold.detail.kind, freeMicros: hold.detail.freeMicros, needMicros: hold.detail.needMicros };
    case "credits":
      return { at, kind: "hold-credits" };
    case "key":
      return { at, kind: "hold-key" };
    case "halt":
      return { at, kind: "hold-halt", code: hold.detail.code };
    case "network":
      return { at, kind: "hold-network", drops: hold.detail.drops };
    case "price-unavailable":
      return { at, kind: "hold-price-unavailable", attempt: hold.detail.attempt };
    case "price":
      return { at, kind: "hold-price", detail: hold.detail };
    case "internal":
      return { at, kind: "hold-internal", holdKind: hold.detail.kind };
  }
}

/** The video as the results list shows it. `done` lists when the file kept its length, size and track (S4.6c2). */
function videoOf(avatarId: string, v: LaunchFile["avatars"][number]["videos"][number], label: OrchestratorDeps["trackLabel"]): LaunchVideo[] {
  const base = { key: v.key, avatarId, shape: v.shape, size: v.size, durationMs: null, bytes: null, track: null, dropReason: null, videoId: null, publishedAt: null } as const;
  if (v.state === "dropped") return [{ ...base, state: "dropped", dropReason: v.dropReason, videoId: v.videoId }];
  if (v.state === "waiting-music") return [{ ...base, state: "waiting-music" }];
  // A done video lists with the length and size the free steps kept and the track it was given; one without them (done before they were kept) cannot meet the contract and is left out.
  if (v.state === "done" && v.videoId !== null && v.durationMs !== undefined && v.bytes !== undefined && v.music !== undefined) {
    const id = v.music.source === "trending" ? v.music.trackId : v.music.mediaId;
    const named = label?.(v.music) ?? null;
    return [{ ...base, state: "done", videoId: v.videoId, durationMs: v.durationMs, bytes: v.bytes, track: { source: v.music.source, title: named?.title ?? id, artist: named?.artist ?? null } }];
  }
  if (v.state === "rendering" && v.videoId !== null) return [{ ...base, state: "rendering", videoId: v.videoId }];
  return [];
}

export type { FreeHold };
