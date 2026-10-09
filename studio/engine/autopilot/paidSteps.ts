import { budgetHoldDetail, drawAllocationLeft, sliceSize, SLICE_MAX_PHOTOS, type LaunchScopeMoney } from "../../shared/autopilot/money";
import { ErrorCode } from "../../shared/engine";
import { INTERNAL_HOLD_MESSAGE_MAX, type PaidHold, type SkipReason } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import type { StoredSceneSet } from "../library/sceneSets";
import type { Ledger } from "../money/ledger";
import type { SliceStatus } from "../sceneSets/launchDraw";
import { sceneRefusal } from "../sceneSets/refusal";
import { pendingChunks } from "../sceneSets/chunks";
import type { LiveScope } from "./room";
import type { FileAvatar, LaunchFile } from "./launchFile";
import { causeOf, failureRateTripped, isWaitingHold, NETWORK_WAITS_MS, PRICE_WAITS_MS, sameHold } from "./paidFailures";
import { NOT_PAYABLE_DETAIL, type PaidPort } from "./paidPort";
import type { AvatarMirror, ContinueInput, ContinueOutcome, LaunchSteps, LaunchStepsContext, MirrorSource, StepTimers, TimerHandle } from "./steps";

// Stage 4, S4.6b1 (plan §3.2, §3.4, §3.6 rows 2–5, §4.3, §4.4, §4.7, §18, §19): the launch's PAID path, plugged in behind `LaunchSteps`. Per avatar that generates:
//
//   compose ─► [the launch's own «Дописать» when the set is not complete] ─► review wait (switch ON) | approval at once (OFF) ─► slices
//
// Every step is read off the PERSISTED state, never remembered: the launch file (the ids, the allocation, the phase), the set file (does it exist, is it complete, is it
// approved, which slices) and the ledger (which attempt ids were sent). So the same code is the first run and the pickup after «Продолжить», and no step can be made twice:
// a set that exists is not composed again, a slice entry is finished with its own run id, an attempt id that was reserved is never sent again.
//
// Money. Compose and «Дописать» run inside the avatar's `composeMicros`, a slice inside `drawMicros`; the launch's `Budget` group refuses anything above W′ (the first line of
// defence), and the sizes here are the second. Nothing in this file raises a cap, an allocation or the month's budget (A3): a price rise shrinks a slice or holds the launch.
// One paid draw at a time per launch (D2), and at most one compose or «Дописать» start at a time.
//
// FIELD OWNERSHIP in the launch file (the composer enforces it for the free part): this file owns an avatar's `phase` (`composing`, `awaiting-review`, `drawing`, `montage`,
// `waiting`, `skipped`), `waiting`, `skipped` and `photosDone`; the free path owns `videos[].state` (and a video's photos, track, sticker). This file never moves a row backwards out
// of `montage`/`done`, and drops videos only when it skips an avatar (generated ones that have no photos yet).
//
// FINISH. This file never calls `ctx.finish()`: it is a PASSIVE voter (`finishReady`): ready when no worker or job is live and every generating avatar is in
// `montage`/`done`/`skipped`. The composer finishes the launch when the free part has voted too.
//
// THE FAILURE TABLE (S4.6b2, plan §4.6). A paid job that fails, or cannot start, is classified by its error code (`paidFailures.ts`) and `#raise` does what the row says: credits, key and halt
// hold the launch for a person; a request that got no answer continues by itself after 1 and after 5 minutes and then holds (`#networkDrop`, the count per job in the launch file); an
// unavailable price list is retried after 5, 15 and 60 minutes (`#priceUnavailable`); an avatar's own refusal skips it; the month and the allocation hold as before. Free work goes on
// through every hold. The timer of an automatic continue is armed before its hold is written, cancelled by a drain, a suspend, a begin and a release, and checks the admission rule (A19)
// when it fires. The failure-rate guard reads the finished slice's outcome before another slice is bought. `suspend` / `wake` are the engine's side of `host.power`.
// A job that ends in a way the table has no row for (an INTERNAL, any code not listed) holds the launch as `internal { job-failed }` with the job's own words (S4.6r); «Продолжить» runs it again.
// `#stuck` is left for a state that is no job's end (a defect of the steps themselves): a warning in the console, nothing sent.

/** The steps' timers (the bounded automatic continues, the wait for a busy avatar): injectable so a test owns the clock. The default is the global `setTimeout`, NOT unref'd: a drain waits on these. */
const REAL_TIMERS: StepTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle) };

export interface PaidStepsDeps {
  /** The engine, behind the port. Lazy: the steps are built before the engine they serve. */
  port: () => PaidPort;
  warn?: (line: string) => void;
  /** How long an avatar that another job holds waits before the step tries again. */
  retryMs?: number;
  /** Epoch milliseconds, for the time of a hold. */
  clock?: () => number;
  /** The timers of the automatic continues and the busy wait. */
  timers?: StepTimers;
  /**
   * How long a job that got no answer waits before it continues by itself, one entry per automatic continue. The default is the plan's Q2 = A: after 1 and after 5 minutes. Q2 = Б (the owner's
   * other answer) is `[]`: the first drop holds for a person. The owner has not answered; the plan's default stands.
   */
  networkWaitsMs?: readonly number[];
}

const DEFAULT_RETRY_MS = 3_000;
/** A pass over one avatar makes a bounded number of moves: each move changes the persisted state, so the bound is a defect guard, not a limit. Waiting for a busy avatar is no move. */
const MAX_MOVES = 12;

type SetRead = { kind: "set"; set: StoredSceneSet } | { kind: "missing" } | { kind: "unreadable" };
/** What a compose, a «Дописать» or an approval came to: "ran" a job started and ended; "busy" the avatar is held by another job; "retry" read the set again; "end" stop this pass. */
type Move = "ran" | "busy" | "retry" | "end";

const isFailure = (error: unknown, code: string): error is EngineFailure => error instanceof EngineFailure && error.error.code === code;
/** The engine refused because the launch cannot pay now (paused, stopping, held): not a failure and not a busy avatar. The launch's own state will wake the steps again. */
const isNotPayable = (error: unknown): boolean => isFailure(error, "VALIDATION") && (error.error.detail ?? "").startsWith(NOT_PAYABLE_DETAIL);
const plannedOf = (set: MirrorSource) => set.scenes.filter((s) => s.origin === "planned" && !s.removed);
const FINAL_PHASES: readonly string[] = ["montage", "done", "skipped"];
/** The price request of a slice's sizing, in the same counters. */
const PRICES_JOB = "prices";

/**
 * The retry timer of a waiting hold, bound to THAT hold (S4.6b2, fix round 1): it fires only if it is still the launch's armed timer and the very hold it was made for stands. `decided` settles
 * once the write that raised the hold has answered, true when this hold won it.
 */
interface Arm {
  hold: PaidHold;
  handle: TimerHandle | null;
  decided: Promise<boolean>;
  decide: (won: boolean) => void;
  cancelled: boolean;
}

/** The error code of whatever a step caught: an engine refusal's, or an `EngineError` carried in a job's end. Undefined for anything else (a defect). */
function codeOf(error: unknown): ErrorCode | undefined {
  if (error instanceof EngineFailure) return error.error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = ErrorCode.safeParse(error.code);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

/**
 * A failed job in a line for the log and the hold: `CODE: detail` for an engine error (a refusal, or the error a job's end carries: its detail is what the window shows anyway), the code alone
 * when it has no detail, and for anything else only the error's name (a message of a foreign error can name a path). Cut to the contract's line.
 */
export function failureWords(error: unknown, code: ErrorCode | undefined): string {
  let detail: string | undefined;
  if (error instanceof EngineFailure) detail = error.error.detail;
  else if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") detail = error.detail;
  const words = code === undefined ? (error instanceof Error ? error.name || "Error" : typeof error) : detail === undefined || detail === "" ? code : `${code}: ${scrubPaths(`${detail}`).trim()}`;
  return words.slice(0, INTERNAL_HOLD_MESSAGE_MAX);
}

/**
 * An engine error's detail is mostly the engine's own words, but a job that wraps a foreign error (`ENOENT: no such file or directory, open '/Users/…/master.png'`) carries the owner's
 * absolute path in it. The words are written to the launch file and the log, so a quoted path (spaces and all) or a bare one with a separator is replaced by `<path>`.
 */
export function scrubPaths(text: string): string {
  const quoted = /(['"`])(?:[A-Za-z]:)?[\\/][^'"`]*\1/g;
  const bare = /(?:[A-Za-z]:)?[\\/][^\s'"`,;]*(?:[\\/][^\s'"`,;]*)+/g;
  return text.replace(quoted, "<path>").replace(bare, "<path>");
}

/** What the set's earlier writer scopes committed: every writer attempt `<setId>:writer-*`, settled at its cost, open at its worst case (plan §3.6 row 2). */
export function writerCommittedMicros(ledger: Pick<Ledger, "lines" | "closeOf">, sceneSetId: string): number {
  const prefix = `${sceneSetId}:writer-`;
  let sum = 0;
  for (const line of ledger.lines) {
    if (line.type !== "reserve" || !line.attemptId.startsWith(prefix)) continue;
    const close = ledger.closeOf(line.attemptId);
    sum += close === undefined ? line.worstMicros : close.type === "settle" ? close.costMicros : 0;
  }
  return sum;
}

/** The slots the unfinished slices could still draw: a slice with no run folder, or a finished one, has none to give. */
function openSlotsOf(slices: readonly { runId: string }[], statuses: ReadonlyMap<string, SliceStatus>): number {
  return slices.reduce((sum, entry) => {
    const status = statuses.get(entry.runId);
    return sum + (status !== undefined && !status.finished ? (status.openSlots ?? 0) : 0);
  }, 0);
}

export class PaidSteps implements LaunchSteps {
  readonly #d: PaidStepsDeps;
  /** The pass over one avatar that is under way, by `<launchId>:<avatarId>`. */
  readonly #workers = new Map<string, Promise<void>>();
  /** A `begin` that found its worker still running: the worker starts again when it ends (L5: a wake-up is never lost). */
  readonly #again = new Map<string, LaunchStepsContext>();
  readonly #mirrors = new Map<string, AvatarMirror>();
  /** Open slots of the avatar's unfinished slices, for the mirror's `resumableSlots`. */
  readonly #resumable = new Map<string, number>();
  /** The launches this instance serves (set mirrors are kept for them only), with the latest context of each. */
  readonly #ctxs = new Map<string, LaunchStepsContext>();
  readonly #restored = new Set<string>();
  /** S4.6v: the restore's background reads of the slices (`resumableSlots`), and who hears that a mirror changed. */
  readonly #background = new Set<Promise<void>>();
  /** Restored sets whose slice runs have not been read yet (the engine was not behind the port when the library opened): the first view that asks for the mirror reads them. */
  readonly #unread = new Map<string, { launchId: string; source: MirrorSource }>();
  readonly #mirrorListeners: ((launchId: string) => void)[] = [];
  /** Avatars that are in an «avatar-busy» episode: the line is logged once per episode, and the phase is left alone until a job starts. */
  readonly #busyKeys = new Set<string>();
  readonly #readyListeners: (() => void)[] = [];
  #subscribed = false;
  /** Sets whose compose or «Дописать» was called (from the call, before it returns) and runs whose job was started: what the soft stop reaches. */
  readonly #liveSets = new Set<string>();
  readonly #liveRuns = new Set<string>();
  /** Starts of a compose or «Дописать» whose call has not returned: inside that window the job's cap is not registered, so the month room overstates. */
  #starting = 0;
  #startWaiters: (() => void)[] = [];
  #composeLane: Promise<unknown> = Promise.resolve();
  #drawLane: Promise<unknown> = Promise.resolve();
  /** The timer of the one automatic continue a launch waits for, by launch id (S4.6b2). At most one: a launch has at most one paid hold. */
  readonly #armed = new Map<string, Arm>();
  /** Timers made for a hold whose write has not come back yet (S4.6b2): a drain must take these back too. */
  readonly #pending = new Set<Arm>();
  /** Waits (a busy avatar) that a drain, a suspend or a stop must be able to end early. */
  readonly #sleepers = new Set<() => void>();
  /** `host.power` `suspend`: the Mac sleeps. Nothing is sent and no timer is held until `wake` (or the owner's own `begin`). */
  #suspended = false;

  constructor(deps: PaidStepsDeps) {
    this.#d = deps;
  }

  // ---------- the seam ----------

  begin(ctx: LaunchStepsContext): void {
    // A begin is the owner's «Продолжить» (or the start): the Mac is awake, and a wait for an automatic continue is over (the owner took over).
    this.#suspended = false;
    this.#cancelTimers();
    this.#ctxs.set(ctx.launchId, ctx);
    this.#subscribe();
    this.#restart(ctx);
  }

  /** Starts the pass of every avatar that still has paid work; a pass that runs already starts once more when it ends. */
  #restart(ctx: LaunchStepsContext): void {
    for (const row of ctx.file().avatars) {
      if (row.generation === null) continue;
      if (row.phase === "skipped" || row.phase === "done" || row.phase === "montage") continue;
      this.#start(ctx, row.avatarId);
    }
  }

  async drain(): Promise<void> {
    // «Пауза», «Стоп» and a quit: no wait for an automatic continue outlives them (A6), and a busy avatar's wait ends at once.
    this.#cancelTimers();
    for (;;) {
      this.#softStopAll();
      this.#wakeSleepers();
      const workers = [...this.#workers.values()];
      if (workers.length === 0) return;
      await Promise.allSettled(workers);
    }
  }

  /** `host.power` `suspend` (plan §3.8): no new attempt leaves, the jobs in flight are soft-stopped (an attempt already sent ends under the ordinary rules), and no timer fires meanwhile. */
  suspend(): void {
    this.#suspended = true;
    this.#cancelTimers();
    this.#softStopAll();
    this.#wakeSleepers();
  }

  /**
   * `host.power` `resume` for a launch that ran. It does NOT claim to check the network: the price list is served from a cache and a dated book when it cannot be fetched, so reading it proves
   * nothing, and a probe of its own would be a request outside the launch's accounting. What it does is put right what the sleep interrupted: a waiting hold whose timer was cancelled is armed
   * again for the remainder, one that came due goes through the very check the timer makes (`#fire`: the admission rule), and a launch with no hold starts its passes again. A network that is
   * still down shows up as the next drop of a job, on the bounded continues.
   */
  async wake(ctx: LaunchStepsContext): Promise<void> {
    this.#suspended = false;
    this.#ctxs.set(ctx.launchId, ctx);
    if (!ctx.isRunning()) return;
    await this.#resumeWait(ctx);
  }

  async release(ctx: LaunchStepsContext): Promise<void> {
    this.#cancelTimers();
    const port = this.#d.port();
    for (const row of ctx.file().avatars) {
      if (row.generation === null) continue;
      try {
        await port.unlinkLaunchSet(row.generation.sceneSetId);
      } catch (error) {
        // A set that was never made, or is gone, has nothing to release; any other failure is told and the stop goes on (a stopped launch is no link at all).
        if (!isFailure(error, "NOT_FOUND")) this.#warn(`studio engine: set ${row.generation.sceneSetId} could not be released (${error instanceof Error ? error.name : typeof error})`);
      }
      this.#mirrors.delete(this.#key(ctx.launchId, row.avatarId));
      this.#resumable.delete(this.#key(ctx.launchId, row.avatarId));
      this.#unread.delete(this.#key(ctx.launchId, row.avatarId));
    }
  }

  /** The launch is done: its sets are released like a stop's, nothing is dropped (the videos are final). */
  complete(ctx: LaunchStepsContext): Promise<void> {
    return this.release(ctx);
  }

  inFlight(): { requests: number; renders: number } {
    return { requests: this.#liveSets.size + this.#liveRuns.size, renders: 0 };
  }

  mirror(launchId: string, avatarId: string): AvatarMirror | null {
    this.#subscribe();
    const key = this.#key(launchId, avatarId);
    const parked = this.#unread.get(key);
    if (parked !== undefined) {
      this.#unread.delete(key);
      this.#track(this.#refreshResumable(parked.launchId, parked.source));
    }
    return this.#mirrors.get(key) ?? null;
  }

  /** The sets a library open found: the mirrors are there before «Продолжить», and the launch's set changes are followed from now on. */
  restore(launchId: string, sets: readonly MirrorSource[]): void {
    this.#restored.add(launchId);
    // A read parked for a library that was left is of no launch of this one.
    for (const [key, parked] of this.#unread) if (parked.launchId !== launchId) this.#unread.delete(key);
    this.#subscribe();
    for (const set of sets) this.#remember(launchId, set);
    // `resumableSlots` needs the slice runs' folders: read in the background, the row shows 0 until then and the launch is announced when they are in (S4.6v).
    for (const set of sets) if ((set.launchDraw?.slices.length ?? 0) > 0) this.#track(this.#refreshResumable(launchId, set));
  }

  onMirrorChange(listener: (launchId: string) => void): void {
    this.#mirrorListeners.push(listener);
  }

  async settled(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  finishReady(launchId: string): boolean {
    if (this.#liveSets.size > 0 || this.#liveRuns.size > 0 || this.#starting > 0) return false;
    for (const key of this.#workers.keys()) if (key.startsWith(`${launchId}:`)) return false;
    const ctx = this.#ctxs.get(launchId);
    if (ctx === undefined) return false;
    try {
      return ctx.file().avatars.every((a) => a.generation === null || FINAL_PHASES.includes(a.phase));
    } catch {
      return false;
    }
  }

  onReadyChange(listener: () => void): void {
    this.#readyListeners.push(listener);
  }

  active(launchId: string, avatarId: string): boolean {
    return this.#workers.has(this.#key(launchId, avatarId));
  }

  /** «Продолжить запуск» (plan §4.7): approve the frozen list; draw now while the launch runs, else only record it. `SCENES_CHANGED` and `over-plan` come from the approval. */
  async continueAfterReview(ctx: LaunchStepsContext, input: ContinueInput): Promise<ContinueOutcome> {
    const port = this.#d.port();
    const row = this.#rowOf(ctx, input.avatarId);
    if (row.generation === null || row.generation.sceneSetId !== input.sceneSetId) throw sceneRefusal(`avatar ${input.avatarId} is not waiting for scene set ${input.sceneSetId}`, "not-awaiting");
    const approved = await port.approveLaunchSet({ sceneSetId: input.sceneSetId, launchId: ctx.launchId, revision: input.revision, plannedCount: plannedCount(row) });
    this.#remember(ctx.launchId, approved);
    const photos = approved.launchDraw?.sceneIds.length ?? 0;
    if (!this.#mayPay(ctx)) return { draw: "waits-for-resume", photos };
    try {
      await this.#setPhase(ctx, input.avatarId, "drawing");
    } catch {
      // The launch was paused between the check and the write: the approval stands, the draw waits.
      return { draw: "waits-for-resume", photos };
    }
    if (!this.#mayPay(ctx)) return { draw: "waits-for-resume", photos };
    this.#start(ctx, input.avatarId);
    return { draw: "started", photos };
  }

  // ---------- one avatar ----------

  #start(ctx: LaunchStepsContext, avatarId: string): void {
    const key = this.#key(ctx.launchId, avatarId);
    if (this.#workers.has(key)) {
      // The running pass may already be past the point that would have seen what woke us: it starts once more when it ends.
      this.#again.set(key, ctx);
      return;
    }
    const pass = this.#drive(ctx, avatarId)
      .catch((error: unknown) => {
        this.#warn(`studio engine: the paid path of avatar ${avatarId} stopped (${error instanceof Error ? error.message : typeof error})`);
      })
      .finally(() => {
        this.#workers.delete(key);
        this.#busyKeys.delete(key);
        const next = this.#again.get(key);
        this.#again.delete(key);
        if (next !== undefined) this.#start(next, avatarId);
        this.#notifyReady();
      });
    this.#workers.set(key, pass);
  }

  async #drive(ctx: LaunchStepsContext, avatarId: string): Promise<void> {
    /** True once this pass ran a job of the set: what is still missing after it is a failure the table of S4.6b2 decides on, not a reason to write again at once. */
    let ranJob = false;
    let moves = 0;
    /** What a compose, a «Дописать» or an approval came to; false: this pass is over. A busy avatar is waited for and is no move. */
    const settle = async (move: Move): Promise<boolean> => {
      if (move === "end") return false;
      if (move === "busy") {
        await this.#busy(ctx, avatarId);
        moves -= 1;
      }
      if (move === "ran") ranJob = true;
      return true;
    };
    while (moves < MAX_MOVES) {
      moves += 1;
      // A job that has just ended is read even when another hold stands now: its drop must be counted in its own job (a hold is no reason to forget it).
      if (!ctx.isRunning() || (!this.#mayPay(ctx) && !ranJob)) return;
      const row = this.#rowOf(ctx, avatarId);
      const generation = row.generation;
      if (generation === null || row.phase === "skipped") return;
      const read = await this.#readSetFor(ctx, avatarId, generation.sceneSetId);
      if (read.kind === "unreadable") return this.#skip(ctx, avatarId, "set-unreadable");
      if (read.kind === "missing") {
        // §3.4: no set file. A ledger line of the set's own attempts means the set was made and cannot be read now: it is never composed again (the ids are spent).
        if (this.#ledgerHasSet(generation.sceneSetId)) return this.#skip(ctx, avatarId, "set-unreadable");
        if (!(await settle(await this.#compose(ctx, row)))) return;
        continue;
      }
      const set = read.set;
      this.#remember(ctx.launchId, set);
      if (set.launchDraw !== undefined) return this.#draw(ctx, avatarId);
      if (this.#pendingWrites(set) > 0) {
        if (ranJob) {
          // The job ended and scenes are still missing: why it stopped is in the set (§4.6), and that decides the hold. This pass is over either way.
          await this.#sceneStepStopped(ctx, avatarId, set);
          return;
        }
        if (!(await settle(await this.#write(ctx, row, set)))) return;
        continue;
      }
      if (!this.#mayPay(ctx)) return;
      if (generation.review) {
        await this.#awaitReview(ctx, avatarId, set);
        return;
      }
      // Review OFF: the approval follows the compose at once, so the owner cannot rewrite or redraw in between (§19).
      if (!(await settle(await this.#approve(ctx, row, set)))) return;
    }
    this.#stuck(avatarId, "the pass made too many moves");
  }

  // ---------- compose and «Дописать» ----------

  async #compose(ctx: LaunchStepsContext, row: FileAvatar): Promise<Move> {
    const generation = row.generation;
    if (generation === null) return "end";
    const split = generation.split;
    const count = split.reduce((sum, s) => sum + s.count, 0);
    const key = this.#key(ctx.launchId, row.avatarId);
    return this.#inLane("compose", async () => {
      if (!this.#busyKeys.has(key)) {
        await this.#setPhase(ctx, row.avatarId, "composing");
        await this.#log(ctx, { at: this.#now(), kind: "scenes-writing", avatarId: row.avatarId, scenes: count });
      }
      // No await between the check and the call: the set's live entry (and with it the soft stop) exists before the call's first await.
      if (!this.#mayPay(ctx)) return "end";
      const port = this.#d.port();
      this.#liveSets.add(generation.sceneSetId);
      this.#starting += 1;
      let started: { jobId: string | null };
      try {
        started = await port.composeLaunchSet(
          { avatarId: row.avatarId, count, categories: split.map((s) => s.ref), poses: ctx.file().draft.poses, acceptedWorstMicros: row.allocation.composeMicros },
          { ids: { sceneSetId: generation.sceneSetId, runId: generation.setRunId }, split, launchId: ctx.launchId },
        );
      } catch (error) {
        this.#startEnded();
        this.#liveSets.delete(generation.sceneSetId);
        return this.#startFailed(ctx, row, `${generation.sceneSetId}:scenes`, error, async () => {
          const estimate = await port.composeEstimate({ avatarId: row.avatarId, count, categories: split.map((s) => s.ref) });
          return { stage: "compose" as const, needMicros: estimate.worstMicros, leftMicros: row.allocation.composeMicros };
        });
      }
      this.#startEnded();
      // The start has returned: a soft stop that found no job before this instant is sent again.
      if (!ctx.isRunning()) port.softStopScenes(generation.sceneSetId);
      this.#busyKeys.delete(key);
      try {
        await this.#setPhase(ctx, row.avatarId, "composing");
        if (started.jobId !== null) await port.whenSceneSetIdle(generation.sceneSetId);
      } finally {
        this.#liveSets.delete(generation.sceneSetId);
      }
      return "ran";
    });
  }

  /** The launch's OWN «Дописать»: its cap is the compose allocation less what the set's earlier writer scopes committed, never a fresh estimate on top (§3.6 row 2, §4.3 item 3). */
  async #write(ctx: LaunchStepsContext, row: FileAvatar, set: StoredSceneSet): Promise<Move> {
    const generation = row.generation;
    const port = this.#d.port();
    const budget = port.budget;
    if (generation === null || budget === null) return this.#stuck(row.avatarId, "the ledger cannot be read");
    const key = this.#key(ctx.launchId, row.avatarId);
    return this.#inLane("compose", async () => {
      if (!this.#busyKeys.has(key)) await this.#setPhase(ctx, row.avatarId, "composing");
      const allowed = Math.max(0, row.allocation.composeMicros - writerCommittedMicros(budget.ledger, generation.sceneSetId));
      const estimate = await port.writeEstimate(generation.sceneSetId);
      if (estimate.worstMicros > allowed) {
        await this.#hold(ctx, row.avatarId, { reason: "price", at: this.#now(), detail: { stage: "rewrite", needMicros: estimate.worstMicros, leftMicros: allowed } });
        return "end";
      }
      if (!this.#mayPay(ctx)) return "end";
      this.#liveSets.add(generation.sceneSetId);
      this.#starting += 1;
      try {
        await port.writeLaunchScenes({ sceneSetId: generation.sceneSetId, launchId: ctx.launchId, revision: set.revision, acceptedWorstMicros: allowed });
      } catch (error) {
        this.#startEnded();
        this.#liveSets.delete(generation.sceneSetId);
        return this.#startFailed(ctx, row, `${generation.sceneSetId}:scenes`, error, async () => {
          const again = await port.writeEstimate(generation.sceneSetId);
          return { stage: "rewrite" as const, needMicros: again.worstMicros, leftMicros: allowed };
        });
      }
      this.#startEnded();
      if (!ctx.isRunning()) port.softStopScenes(generation.sceneSetId);
      this.#busyKeys.delete(key);
      try {
        await this.#setPhase(ctx, row.avatarId, "composing");
        await port.whenSceneSetIdle(generation.sceneSetId);
      } finally {
        this.#liveSets.delete(generation.sceneSetId);
      }
      return "ran";
    });
  }

  /**
   * A compose or «Дописать» ended and scenes are still missing. The set keeps why its write stopped (`write.stoppedBy`): a failure carries the error and decides by the table; a soft stop
   * (a pause, a stop, a sleep) is no failure and leaves the pass; anything else is a state this file has no rule for.
   */
  async #sceneStepStopped(ctx: LaunchStepsContext, avatarId: string, set: StoredSceneSet): Promise<void> {
    if (!ctx.isRunning()) return;
    const write = set.write;
    if (write?.stoppedBy === "failed" && write.stoppedError !== undefined) {
      await this.#raise(ctx, avatarId, `${set.sceneSetId}:scenes`, write.stoppedError, { sceneSetId: set.sceneSetId });
      return;
    }
    this.#stuck(avatarId, `the scenes of the set are not all written (the write stopped: ${write?.stoppedBy ?? "no record"})`);
  }

  async #awaitReview(ctx: LaunchStepsContext, avatarId: string, set: StoredSceneSet): Promise<void> {
    const planned = plannedOf(set);
    const withoutText = planned.filter((s) => s.text === null).length;
    const changed = this.#rowOf(ctx, avatarId).phase !== "awaiting-review";
    await this.#setPhase(ctx, avatarId, "awaiting-review");
    if (changed) await this.#log(ctx, { at: this.#now(), kind: "scenes-ready", avatarId, scenes: planned.length, withoutText });
  }

  /** Review OFF: freezes the scenes with text right after the compose. */
  async #approve(ctx: LaunchStepsContext, row: FileAvatar, set: StoredSceneSet): Promise<Move> {
    const generation = row.generation;
    if (generation === null) return "end";
    try {
      const approved = await this.#d.port().approveLaunchSet({ sceneSetId: generation.sceneSetId, launchId: ctx.launchId, revision: set.revision, plannedCount: plannedCount(row) });
      this.#remember(ctx.launchId, approved);
      return "retry";
    } catch (error) {
      // The set moved between the read and the approval (an edit that landed): read it again. A job of the set still ending: the avatar is busy. Anything else is not this file's to decide.
      if (isFailure(error, "SCENES_CHANGED")) return "retry";
      if (isNotPayable(error)) return "end";
      if (isFailure(error, "IN_FLIGHT")) return "busy";
      return this.#stuck(row.avatarId, `the set could not be approved (${error instanceof EngineFailure ? (error.error.sceneReason ?? error.error.code) : "unknown"})`);
    }
  }

  // ---------- slices ----------

  async #draw(ctx: LaunchStepsContext, avatarId: string): Promise<void> {
    if (!this.#busyKeys.has(this.#key(ctx.launchId, avatarId))) await this.#setPhase(ctx, avatarId, "drawing");
    for (;;) {
      const outcome = await this.#inLane("draw", () => this.#drawSlices(ctx, avatarId));
      if (outcome !== "busy") return;
      // The avatar is held by another job: the draw lane is free while this one waits, so another avatar's slice can go.
      await this.#busy(ctx, avatarId);
      if (!this.#mayPay(ctx)) return;
    }
  }

  async #drawSlices(ctx: LaunchStepsContext, avatarId: string): Promise<"done" | "busy"> {
    const port = this.#d.port();
    /** Runs this pass found finished for want of cap: their slots stay open for good, so they are never started again. */
    const spent = new Set<string>();
    /** Sized from the scene count once the set is read: a slice is at least one photo, and each takes a draw and a start. */
    let limit = 40;
    for (let move = 0; move < limit; move++) {
      if (!this.#mayPay(ctx)) return "done";
      const row = this.#rowOf(ctx, avatarId);
      const generation = row.generation;
      if (generation === null) return "done";
      const read = await this.#readSetFor(ctx, avatarId, generation.sceneSetId);
      const set = read.kind === "set" ? read.set : null;
      const draw = set?.launchDraw;
      if (set === null || draw === undefined) {
        this.#stuck(avatarId, "the approved set cannot be read");
        return "done";
      }
      limit = Math.max(40, draw.sceneIds.length * 4 + 20);
      const statuses = await port.sliceStatuses(set);
      this.#resumable.set(this.#key(ctx.launchId, avatarId), openSlotsOf(draw.slices, statuses));
      this.#remember(ctx.launchId, set);
      // A slice that has a run and is not finished is resumed inside its own cap, before anything new is drawn.
      const open = draw.slices.find((entry) => statuses.get(entry.runId)?.finished === false && !spent.has(entry.runId));
      if (open !== undefined) {
        const outcome = await this.#runSlice(ctx, row, set, open.runId, statuses.get(open.runId));
        if (outcome === "end") return "done";
        if (outcome === "busy") return "busy";
        if (outcome === "spent") spent.add(open.runId);
        continue;
      }
      // Nothing is drawn for an avatar none of whose videos still waits for photos (fix round 1, 6e).
      if (!row.videos.some((v) => v.source === "generated" && (v.state === "planned" || v.state === "waiting-photos"))) {
        await this.#setPhase(ctx, avatarId, "montage");
        return "done";
      }
      // An entry with no run folder is finished first (same run id, cap recomputed and never raised); otherwise the next slice is sized.
      const pending = draw.slices.find((entry) => !statuses.has(entry.runId));
      const taken = new Set(draw.slices.flatMap((entry) => entry.sceneIds));
      const scenesLeft = draw.sceneIds.filter((id) => !taken.has(id)).length;
      if (pending === undefined && scenesLeft === 0) {
        await this.#setPhase(ctx, avatarId, "montage");
        return "done";
      }
      // The failure-rate guard (§4.6): before another slice is bought, the one just finished is looked at. Half of its slots failing the gates or moderation means the master portrait is the
      // problem, not luck: the avatar's remaining slices are not drawn. (Read here, not at the slice's end, so a pause that landed first cannot lose it.)
      const last = draw.slices.at(-1);
      if (pending === undefined && last !== undefined) {
        const outcome = await port.sliceOutcome(last.runId);
        if (outcome !== null && failureRateTripped(outcome)) {
          if (!this.#mayPay(ctx)) return "done";
          await this.#skip(ctx, avatarId, "failure-rate", { failed: outcome.checkFailures, total: outcome.slots });
          return "done";
        }
      }
      const size = pending === undefined ? await this.#sizeOf(ctx, row, set, statuses, scenesLeft) : { photos: Math.min(SLICE_MAX_PHOTOS, pending.sceneIds.length) };
      if (size === "end") return "done";
      if (!this.#mayPay(ctx)) return "done";
      const requested = pending === undefined ? size.photos : pending.sceneIds.length;
      const drawn = await port.drawLaunchSlice({ sceneSetId: generation.sceneSetId, launchId: ctx.launchId, size: size.photos, drawMicros: row.allocation.drawMicros });
      if (drawn.kind === "none-left") {
        await this.#setPhase(ctx, avatarId, "montage");
        return "done";
      }
      if (drawn.kind === "no-room") {
        // The draw allocation left cannot buy one photo at today's prices: the price rose. Nothing is raised (A3).
        await this.#hold(ctx, avatarId, { reason: "price", at: this.#now(), detail: { stage: "slice", fromPhotos: Math.max(1, requested), toPhotos: 0 } });
        return "done";
      }
      const index = Math.max(1, (draw.slices.findIndex((entry) => entry.runId === drawn.runId) + 1) || draw.slices.length + 1);
      if (drawn.sceneIds.length < requested) await this.#log(ctx, { at: this.#now(), kind: "price-shrink", avatarId, fromPhotos: requested, toPhotos: drawn.sceneIds.length });
      await this.#log(ctx, { at: this.#now(), kind: "slice-start", avatarId, index, total: Math.max(index, Math.ceil(draw.sceneIds.length / SLICE_MAX_PHOTOS)), photos: drawn.sceneIds.length, capMicros: drawn.capMicros });
    }
    this.#stuck(avatarId, "the draw made too many moves");
    return "done";
  }

  /** The next slice's size (plan §4.4): `min(25, scenes left, ⌊allocation left / photo⌋, ⌊room / photo⌋)`, read only once no compose is starting (§19). "end": a hold was set. */
  async #sizeOf(ctx: LaunchStepsContext, row: FileAvatar, set: StoredSceneSet, statuses: Map<string, SliceStatus>, scenesLeft: number): Promise<{ photos: number } | "end"> {
    const port = this.#d.port();
    let photoWorst: number;
    try {
      photoWorst = await port.photoWorstMicros();
    } catch (error) {
      // PRICE_UNAVAILABLE retries after 5, 15 and 60 minutes; a drop of the price request is a drop like any other; anything else is told and left.
      return this.#raise(ctx, row.avatarId, PRICES_JOB, error);
    }
    await this.#pricesWork(ctx);
    const live = await this.#liveSlices(ctx);
    await this.#composeSettled();
    if (!this.#mayPay(ctx)) return "end";
    const room = port.monthRoom(live);
    if (room === null) return this.#stuck(row.avatarId, "the ledger cannot be read");
    const scopes: LaunchScopeMoney[] = [];
    for (const entry of set.launchDraw?.slices ?? []) {
      const status = statuses.get(entry.runId);
      if (status === undefined) continue;
      scopes.push(status.finished ? { state: "finished", committedMicros: status.committedMicros } : { state: "live", capMicros: entry.capMicros });
    }
    const size = sliceSize({ scenesLeft, drawLeftMicros: drawAllocationLeft(row.allocation.drawMicros, scopes), roomMicros: room.freeMicros, photoWorstMicros: photoWorst });
    if (size.blockedBy === "allocation") {
      await this.#hold(ctx, row.avatarId, { reason: "price", at: this.#now(), detail: { stage: "slice", fromPhotos: Math.min(SLICE_MAX_PHOTOS, scenesLeft), toPhotos: 0 } });
      return "end";
    }
    if (size.blockedBy === "room") {
      await this.#hold(ctx, row.avatarId, { reason: "budget", at: this.#now(), detail: { kind: "new-slice", freeMicros: room.freeMicros, needMicros: photoWorst } });
      return "end";
    }
    return { photos: size.photos };
  }

  /** The launch's resumable slices that are not running now, for the month room (plan §4.4, §19): they will come back, so their unspent cap is not free. */
  async #liveSlices(ctx: LaunchStepsContext): Promise<LiveScope[]> {
    const port = this.#d.port();
    const live: LiveScope[] = [];
    for (const row of ctx.file().avatars) {
      if (row.generation === null) continue;
      const read = await this.#readSetFor(ctx, row.avatarId, row.generation.sceneSetId);
      if (read.kind !== "set" || read.set.launchDraw === undefined) continue;
      const statuses = await port.sliceStatuses(read.set);
      for (const entry of read.set.launchDraw.slices) if (statuses.get(entry.runId)?.finished === false) live.push({ scope: { runId: entry.runId }, capMicros: entry.capMicros });
    }
    return live;
  }

  /**
   * Starts (or resumes) one slice run and waits for its end. "spent": nothing is left to run in it. "busy": the avatar is held. "end": stop this pass (a hold, a skip, a stop).
   * A run that ends failed is a row of the §4.6 table: the month (a resume needs the room), the cap (the slice is finished), or a cause for `#raise`.
   */
  async #runSlice(ctx: LaunchStepsContext, row: FileAvatar, set: StoredSceneSet, runId: string, status: SliceStatus | undefined): Promise<"again" | "spent" | "busy" | "end"> {
    const port = this.#d.port();
    if (!this.#mayPay(ctx)) return "end";
    this.#liveRuns.add(runId);
    let started: Awaited<ReturnType<PaidPort["startLaunchSlice"]>>;
    try {
      started = await port.startLaunchSlice(runId);
    } catch (error) {
      this.#liveRuns.delete(runId);
      if (isNotPayable(error)) return "end";
      if (isFailure(error, "IN_FLIGHT")) return "busy";
      if (isFailure(error, "BUDGET_EXCEEDED")) return this.#budgetStopped(ctx, row, set, runId, false);
      if (isFailure(error, "PRICE_CHANGED")) {
        // The slice is already started: it cannot shrink, so at today's price what is left of it no longer fits its cap. Nothing is raised (A3).
        const open = status !== undefined && !status.finished ? (status.openSlots ?? 1) : 1;
        await this.#hold(ctx, row.avatarId, { reason: "price", at: this.#now(), detail: { stage: "slice", fromPhotos: Math.max(1, open), toPhotos: 0 } });
        return "end";
      }
      return this.#raise(ctx, row.avatarId, runId, error);
    }
    // The start has returned: a soft stop that found no job before this instant is sent again.
    if (!ctx.isRunning()) port.softStopRun(runId);
    this.#busyKeys.delete(this.#key(ctx.launchId, row.avatarId));
    await this.#pricesWork(ctx);
    if (started.kind === "finished") {
      this.#liveRuns.delete(runId);
      return "spent";
    }
    let end: Awaited<typeof started.ended>;
    try {
      await this.#setPhase(ctx, row.avatarId, "drawing");
      end = await started.ended;
    } finally {
      this.#liveRuns.delete(runId);
    }
    if (end.status === "done") {
      const arrived = end.photoIds.length;
      await this.#rewrite(ctx, (file) => this.#patchRow(file, row.avatarId, (a) => ({ ...a, photosDone: a.photosDone + arrived })));
      return "again";
    }
    // A soft stop (a pause, a stop, a sleep) ends the run cancelled with its slots open: «Продолжить» or the wake-up resumes it.
    if (!ctx.isRunning()) return "end";
    if (end.status === "cancelled") return this.#stuck(row.avatarId, "the slice was cancelled and nothing asked for a stop");
    const cause = causeOf(end.error.code);
    if (cause.kind === "cap") return "spent";
    if (cause.kind === "budget") return this.#budgetStopped(ctx, row, set, runId, true);
    return this.#raise(ctx, row.avatarId, runId, end.error);
  }

  /**
   * The month has no room for the slice's next attempt (refused at its start, or mid-run as a `limit` that ended it): `paidHold { budget }` for a resume, naming the room the resume needs
   * (`Engine.resumeSliceHold`). Mid-run the log says how far the slice got («бюджет месяца закончился»).
   */
  async #budgetStopped(ctx: LaunchStepsContext, row: FileAvatar, set: StoredSceneSet, runId: string, midRun: boolean): Promise<"end"> {
    const port = this.#d.port();
    try {
      const detail = await port.resumeSliceHold(runId, await this.#liveSlices(ctx));
      if (midRun) {
        const total = set.launchDraw?.slices.find((entry) => entry.runId === runId)?.sceneIds.length ?? 0;
        const left = (await port.sliceStatuses(set)).get(runId);
        const open = left !== undefined && !left.finished ? (left.openSlots ?? total) : 0;
        await this.#log(ctx, { at: this.#now(), kind: "budget-ended", avatarId: row.avatarId, done: Math.max(0, total - open), total });
      }
      await this.#hold(ctx, row.avatarId, { reason: "budget", at: this.#now(), detail });
      return "end";
    } catch {
      return this.#stuck(row.avatarId, "the month has no room for the slice and its hold could not be read");
    }
  }

  // ---------- holds, waits, skips ----------

  /** A refused start of a compose or «Дописать»: the avatar is busy (wait), the allocation no longer covers it (a price hold), or it is not this file's to decide. */
  async #startFailed(
    ctx: LaunchStepsContext,
    row: FileAvatar,
    jobKey: string,
    error: unknown,
    price: () => Promise<{ stage: "compose" | "rewrite"; needMicros: number; leftMicros: number }>,
  ): Promise<Move> {
    if (isNotPayable(error)) return "end";
    if (isFailure(error, "IN_FLIGHT")) return ctx.isRunning() ? "busy" : "end";
    if (isFailure(error, "PRICE_CHANGED")) {
      const detail = await price();
      if (detail.leftMicros < detail.needMicros) {
        await this.#hold(ctx, row.avatarId, { reason: "price", at: this.#now(), detail });
        return "end";
      }
      // The price fell back between the refusal and the estimate: ask again (bounded by the pass's moves).
      return "retry";
    }
    if (isFailure(error, "SCENES_CHANGED")) return "retry";
    if (isFailure(error, "BUDGET_EXCEEDED")) {
      // §4.6, BUDGET_EXCEEDED at a step start: the month has no room for the step. It needs the room for its own worst case; «Продолжить» is admitted once that much is free.
      const need = await price();
      const room = this.#d.port().monthRoom();
      await this.#hold(ctx, row.avatarId, { reason: "budget", at: this.#now(), detail: budgetHoldDetail({ kind: "new-slice", freeMicros: room?.freeMicros ?? 0, photoWorstMicros: need.needMicros }) });
      return "end";
    }
    return this.#raise(ctx, row.avatarId, jobKey, error);
  }

  /**
   * Raises the launch's paid hold and parks the avatar as waiting. The hold is decided inside the file's own write (`raisePaidHold`) by rank (`holdRank`): it stands when nothing stood or when it
   * outranks what stood (which it displaces, timer and all). Otherwise the one that stands stays: the cause is met again, at no cost, by the pass that follows the hold. True when this hold stands.
   */
  async #hold(ctx: LaunchStepsContext, avatarId: string | null, hold: PaidHold): Promise<boolean> {
    // The avatar parks first: whoever sees the hold finds the row already waiting behind it.
    if (avatarId !== null) await this.#setPhase(ctx, avatarId, "waiting", { reason: "paid-hold" });
    const { won } = await ctx.raisePaidHold(hold);
    // A hold that won took the place of whatever stood: a waiting hold's timer belongs to a hold that is gone.
    if (won) this.#cancelTimers(ctx.launchId);
    return won;
  }

  // ---------- the failure table (plan §4.6) ----------

  /**
   * A paid job failed, or could not start, for a cause the table has a row for: credits, key, halt, no answer, reconcile, prices unavailable, or the avatar itself. Sets the hold (or skips the
   * avatar) and returns "end": this pass has nothing more to send. A cause with no row holds the launch as `internal { job-failed }` with the job's words (`#jobFailed`, S4.6r); `#stuck` is only for a state that is no job's end. Nothing is raised or sent here (A3, A6).
   * Not for a launch that stopped running meanwhile (a pause, a stop, a sleep): the resume meets the same state, and a 402 or a 401 then costs nothing.
   */
  async #raise(ctx: LaunchStepsContext, avatarId: string | null, jobKey: string, error: unknown, scene?: { sceneSetId: string }): Promise<"end"> {
    if (!ctx.isRunning()) return "end";
    const code = codeOf(error);
    const cause = code === undefined ? ({ kind: "unknown" } as const) : causeOf(code);
    const at = this.#now();
    switch (cause.kind) {
      case "credits":
        await this.#hold(ctx, avatarId, { reason: "credits", at, detail: {} });
        return "end";
      case "key":
        await this.#hold(ctx, avatarId, { reason: "key", at, detail: {} });
        return "end";
      case "halt":
        await this.#hold(ctx, avatarId, { reason: "halt", at, detail: { code: cause.code } });
        return "end";
      case "network":
        return this.#networkDrop(ctx, avatarId, jobKey);
      case "reconcile": {
        // The ledger holds reserves it cannot vouch for: the same exit as a network hold (a reconcile, then «Продолжить»), with no retry. A request that was not answered is a drop of its job.
        const counted = await this.#countDrop(ctx, jobKey, false);
        await this.#hold(ctx, avatarId, { reason: "network", at, detail: { drops: counted.drops, attempt: counted.continues, nextAt: null } });
        return "end";
      }
      case "price-unavailable":
        return this.#priceUnavailable(ctx, avatarId);
      case "avatar":
        if (avatarId === null) return this.#stuck("the launch", `a launch-wide step met an avatar's refusal (${failureWords(error, code)})`);
        await this.#skip(ctx, avatarId, cause.reason);
        return "end";
      case "budget": {
        // A compose or «Дописать» stopped by the month: the hold of §4.6's «BUDGET_EXCEEDED at a step start», needing the room for the step's own worst case.
        const port = this.#d.port();
        try {
          const need = scene === undefined ? await port.photoWorstMicros() : (await port.writeEstimate(scene.sceneSetId)).worstMicros;
          const room = port.monthRoom();
          await this.#hold(ctx, avatarId, { reason: "budget", at, detail: budgetHoldDetail({ kind: "new-slice", freeMicros: room?.freeMicros ?? 0, photoWorstMicros: need }) });
          return "end";
        } catch {
          return this.#jobFailed(ctx, avatarId, error, code, at);
        }
      }
      case "price": {
        // A compose or «Дописать» stopped because the price rose: a price hold when the step no longer fits what its allocation leaves. When it does fit, there is nothing to wait for but a click.
        const port = this.#d.port();
        const budget = port.budget;
        const generation = avatarId === null ? undefined : ctx.file().avatars.find((a) => a.avatarId === avatarId)?.generation;
        const row = avatarId === null ? undefined : ctx.file().avatars.find((a) => a.avatarId === avatarId);
        if (scene !== undefined && budget !== null && row !== undefined && generation !== null && generation !== undefined) {
          try {
            const allowed = Math.max(0, row.allocation.composeMicros - writerCommittedMicros(budget.ledger, generation.sceneSetId));
            const need = (await port.writeEstimate(scene.sceneSetId)).worstMicros;
            if (allowed < need) {
              await this.#hold(ctx, avatarId, { reason: "price", at, detail: { stage: "rewrite", needMicros: need, leftMicros: allowed } });
              return "end";
            }
          } catch {
            // falls to the failed job's hold below
          }
        }
        return this.#jobFailed(ctx, avatarId, error, code, at);
      }
      case "cap":
      case "busy":
        // No row of the table serves a compose or «Дописать» stopped by the launch's cap or by a busy avatar (the slice's rows are handled where the slice runs): it is named, and the click runs the job again.
        return this.#jobFailed(ctx, avatarId, error, code, at);
      default:
        return this.#jobFailed(ctx, avatarId, error, code, at);
    }
  }

  /**
   * S4.6r: a job that ended in a way the table has no row for (an INTERNAL: a master photo that cannot be prepared, say) is not left to hang: the launch holds as `internal` with the job's own words,
   * and «Продолжить» runs the job again. Nothing is sent meanwhile, and the ledger's admission rule still applies to the click.
   */
  async #jobFailed(ctx: LaunchStepsContext, avatarId: string | null, error: unknown, code: ErrorCode | undefined, at: string): Promise<"end"> {
    const words = failureWords(error, code);
    this.#warn(`studio engine: the paid path of ${avatarId === null ? "the launch" : `avatar ${avatarId}`} stopped: a job ended in a way the table has no row for (${words})`);
    await this.#hold(ctx, avatarId, { reason: "internal", at, detail: { kind: "job-failed", message: words } });
    return "end";
  }

  /**
   * Counts a drop in its own job's entry, on the fresh file, whatever hold stands. `spend` says whether this drop also uses one of the job's automatic continues; a job that has used them all
   * does not (its entry keeps `continues` at the most it was given).
   */
  async #countDrop(ctx: LaunchStepsContext, jobKey: string, spend: boolean): Promise<{ drops: number; continues: number; spent: boolean }> {
    const waits = this.#d.networkWaitsMs ?? NETWORK_WAITS_MS;
    let result = { drops: 1, continues: 0, spent: false };
    await this.#rewrite(ctx, (f) => {
      const cur = f.autoContinues?.[jobKey] ?? { drops: 0, continues: 0 };
      // By the drop's number, not by the continues left: a drop that landed under a hold for a person spent none, and must not push the third drop out to a fourth.
      const spent = spend && cur.continues < waits.length && cur.drops + 1 <= waits.length;
      result = { drops: cur.drops + 1, continues: cur.continues + (spent ? 1 : 0), spent };
      return { ...f, autoContinues: { ...f.autoContinues, [jobKey]: { drops: result.drops, continues: result.continues } } };
    });
    return result;
  }

  /**
   * No answer (network, a timeout, a final 429 or 5xx): the job continues by itself after its first drop (1 minute) and its second (5 minutes), then waits for a person. Every drop is counted in
   * its own job whatever hold stands. The third drop is a hold for a person and displaces a waiting hold of another job. While a hold for a person stands, a drop does not use a continue (no wait
   * will serve it) and only parks its avatar. The wait is a hold with `nextAt`; its timer checks the admission rule before it clears the hold.
   */
  async #networkDrop(ctx: LaunchStepsContext, avatarId: string | null, jobKey: string): Promise<"end"> {
    const waits = this.#d.networkWaitsMs ?? NETWORK_WAITS_MS;
    const standing = ctx.file().paidHold;
    const personHolds = standing !== null && !isWaitingHold(standing);
    const counted = await this.#countDrop(ctx, jobKey, !personHolds);
    const at = this.#now();
    if (counted.spent) {
      const afterMs = waits[counted.continues - 1] ?? 0;
      const hold: PaidHold = { reason: "network", at, detail: { drops: counted.drops, attempt: counted.continues, nextAt: new Date(this.#clock() + afterMs).toISOString() } };
      await this.#log(ctx, { at, kind: "network-retry", ...(avatarId === null ? {} : { avatarId }), attempt: counted.continues, attempts: waits.length, afterMs });
      await this.#holdWithRetry(ctx, avatarId, hold, afterMs);
      return "end";
    }
    if (personHolds && counted.drops <= waits.length) {
      // A hold for a person stands and this job still has continues: no wait would serve it, so it only parks, and the pass after that hold meets whatever is still wrong.
      if (avatarId !== null) await this.#setPhase(ctx, avatarId, "waiting", { reason: "paid-hold" });
      return "end";
    }
    // The job has used its continues: this is the third drop. It is raised whatever stands (the rank decides: it displaces a waiting hold and every hold a click would clear at once), because
    // otherwise «Продолжить» would be admitted with this job's requests unanswered and no reconcile (A19).
    await this.#hold(ctx, avatarId, { reason: "network", at, detail: { drops: counted.drops, attempt: counted.continues, nextAt: null } });
    return "end";
  }

  /** The price list did not load: retry after 5, 15 and 60 minutes (the launch's count, in the file), then hold for a person. A retry is used only when its wait is the one that stands. */
  async #priceUnavailable(ctx: LaunchStepsContext, avatarId: string | null): Promise<"end"> {
    const used = ctx.file().priceRetries ?? 0;
    const at = this.#now();
    if (used >= PRICE_WAITS_MS.length) {
      await this.#hold(ctx, avatarId, { reason: "price-unavailable", at, detail: { attempt: used, nextAt: null } });
      return "end";
    }
    if (ctx.file().paidHold !== null) {
      // Something already holds the launch (a wait that will restart this pass, or a person's hold): no retry is spent on a wait that will not be ours.
      if (avatarId !== null) await this.#setPhase(ctx, avatarId, "waiting", { reason: "paid-hold" });
      return "end";
    }
    const afterMs = PRICE_WAITS_MS[used] ?? 0;
    const hold: PaidHold = { reason: "price-unavailable", at, detail: { attempt: used + 1, nextAt: new Date(this.#clock() + afterMs).toISOString() } };
    await this.#rewrite(ctx, (f) => ({ ...f, priceRetries: Math.max(f.priceRetries ?? 0, used) + 1 }));
    await this.#holdWithRetry(ctx, avatarId, hold, afterMs);
    return "end";
  }

  /** The prices were read: the retries of the price list start over (a hold from last week must not shorten today's). */
  async #pricesWork(ctx: LaunchStepsContext): Promise<void> {
    if ((ctx.file().priceRetries ?? 0) === 0) return;
    await this.#rewrite(ctx, (f) => ((f.priceRetries ?? 0) === 0 ? null : { ...f, priceRetries: 0 }));
  }

  // ---------- the timer of a waiting hold ----------

  /**
   * A waiting hold with its timer. The timer is created BEFORE the hold is written (nobody can see the hold and find no timer behind it) and is bound to the hold that WON the write: if the hold
   * lost (another one stands), the timer is taken back; if it won, it replaces the timer of whatever it displaced. It fires only if it is still the launch's armed timer and its hold still stands.
   */
  async #holdWithRetry(ctx: LaunchStepsContext, avatarId: string | null, hold: PaidHold, afterMs: number): Promise<void> {
    const arm = this.#makeArm(ctx, hold, afterMs);
    let won = false;
    try {
      if (avatarId !== null) await this.#setPhase(ctx, avatarId, "waiting", { reason: "paid-hold" });
      ({ won } = await ctx.raisePaidHold(hold));
    } catch (error) {
      this.#dropArm(arm, false);
      throw error;
    }
    if (won) this.#install(ctx.launchId, arm);
    else this.#dropArm(arm, false);
    arm.decide(won && !arm.cancelled);
  }

  #makeArm(ctx: LaunchStepsContext, hold: PaidHold, afterMs: number): Arm {
    let decide: (won: boolean) => void = () => undefined;
    const decided = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const arm: Arm = { hold, handle: null, decided, decide, cancelled: false };
    // A pause, a stop or a sleep that landed first has already cancelled what it found: nothing is armed behind it.
    if (!ctx.isRunning()) {
      arm.cancelled = true;
      return arm;
    }
    arm.handle = this.#timers().set(() => {
      void (async () => {
        if (!(await arm.decided) || arm.cancelled || this.#armed.get(ctx.launchId) !== arm) return;
        this.#armed.delete(ctx.launchId);
        await this.#fire(ctx, arm.hold);
      })().catch((error: unknown) => this.#warn(`studio engine: an automatic continue of launch ${ctx.launchId} failed (${error instanceof Error ? error.name : typeof error})`));
    }, afterMs);
    this.#pending.add(arm);
    return arm;
  }

  /** The hold of `arm` stands: its timer is the launch's, and the timer of whatever it replaced is gone. */
  #install(launchId: string, arm: Arm): void {
    this.#pending.delete(arm);
    // A timer that was taken back (a pause, a sleep) installs nothing: it must not take a newer timer away either.
    if (arm.cancelled) return;
    const old = this.#armed.get(launchId);
    if (old !== undefined && old !== arm) this.#dropArm(old, false);
    this.#armed.set(launchId, arm);
  }

  #dropArm(arm: Arm, decision: boolean): void {
    arm.cancelled = true;
    this.#pending.delete(arm);
    if (arm.handle !== null) this.#timers().clear(arm.handle);
    arm.decide(decision);
  }

  /**
   * The wait is over. The launch must still run (not paused, stopped or asleep: those cancelled the timer, this is the second line), and the hold must still be this very one. Under the admission
   * rule (A19) the hold is cleared and the passes start again; with the ledger closed the wait ends and a person decides (the same hold, with no retry left, which displaces the waiting one).
   */
  async #fire(ctx: LaunchStepsContext, hold: PaidHold): Promise<void> {
    if (this.#suspended || !ctx.isRunning()) return;
    const current = ctx.file().paidHold;
    if (current === null || !sameHold(current, hold)) return;
    if (!this.#d.port().admitted()) {
      if (current.reason === "network") await this.#hold(ctx, null, { ...current, detail: { ...current.detail, nextAt: null } });
      else if (current.reason === "price-unavailable") await this.#hold(ctx, null, { ...current, detail: { ...current.detail, nextAt: null } });
      return;
    }
    if (await ctx.clearPaidHold(hold)) this.#restart(ctx);
  }

  /**
   * After a sleep (or any moment the timer of a standing waiting hold is gone): a wait with time left is armed again for the remainder; one that came due goes through `#fire`, the very check
   * the timer makes. A launch with no hold simply starts its passes again; a hold for a person is left to the person.
   */
  async #resumeWait(ctx: LaunchStepsContext): Promise<void> {
    const hold = ctx.file().paidHold;
    if (hold === null) {
      this.#restart(ctx);
      return;
    }
    if (!isWaitingHold(hold)) return;
    const remaining = Date.parse(hold.detail.nextAt ?? "") - this.#clock();
    if (remaining > 0) {
      const arm = this.#makeArm(ctx, hold, remaining);
      this.#install(ctx.launchId, arm);
      arm.decide(true);
      return;
    }
    await this.#fire(ctx, hold);
  }

  #cancelTimers(launchId?: string): void {
    for (const [id, arm] of [...this.#armed]) {
      if (launchId !== undefined && id !== launchId) continue;
      this.#dropArm(arm, false);
      this.#armed.delete(id);
    }
    // Timers created for a hold whose write has not come back yet.
    for (const arm of [...this.#pending]) this.#dropArm(arm, false);
  }

  #wakeSleepers(): void {
    for (const wake of [...this.#sleepers]) wake();
  }

  #timers(): StepTimers {
    return this.#d.timers ?? REAL_TIMERS;
  }

  #clock(): number {
    return (this.#d.clock ?? Date.now)();
  }

  /** Another job holds the avatar: it waits as «avatar-busy» and tries again, never fails (plan §3.8). The line is logged once per episode. */
  async #busy(ctx: LaunchStepsContext, avatarId: string): Promise<void> {
    const key = this.#key(ctx.launchId, avatarId);
    if (!this.#busyKeys.has(key)) {
      this.#busyKeys.add(key);
      await this.#log(ctx, { at: this.#now(), kind: "avatar-busy", avatarId });
    }
    await this.#setPhase(ctx, avatarId, "waiting", { reason: "avatar-busy" });
    await this.#sleep(this.#d.retryMs ?? DEFAULT_RETRY_MS);
  }

  /**
   * A wait that a drain, a suspend or a stop ends at once. Not `unref`ed: a drain waits on the pass that sleeps here, and with an unref'd timer Bun on Windows idles for ever with that drain's
   * promise pending (the same reason as freeSteps' `#sleep`). Nothing outlives the wait: it clears its own timer however it ends.
   */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timers = this.#timers();
      const done = (): void => {
        this.#sleepers.delete(done);
        timers.clear(handle);
        resolve();
      };
      const handle = timers.set(done, ms);
      this.#sleepers.add(done);
    });
  }

  /** The avatar leaves the launch; its allocation stays (nothing is released). Only generated videos that have no photos yet are dropped: a library or a rendering video is the free path's. */
  async #skip(ctx: LaunchStepsContext, avatarId: string, reason: Exclude<SkipReason, "failure-rate">): Promise<void>;
  async #skip(ctx: LaunchStepsContext, avatarId: string, reason: "failure-rate", counts: { failed: number; total: number }): Promise<void>;
  async #skip(ctx: LaunchStepsContext, avatarId: string, reason: SkipReason, counts?: { failed: number; total: number }): Promise<void> {
    const skipped = reason === "failure-rate" ? { reason, failed: counts?.failed ?? 0, total: counts?.total ?? 0 } : { reason };
    await this.#rewrite(ctx, (file) =>
      this.#patchRow(file, avatarId, (a) => ({
        ...a,
        phase: "skipped",
        waiting: null,
        skipped,
        videos: a.videos.map((v) =>
          v.source === "generated" && (v.state === "planned" || v.state === "waiting-photos") ? { ...v, state: "dropped" as const, dropReason: "avatar-skipped" as const } : v,
        ),
      })),
    );
    await this.#log(ctx, { at: this.#now(), kind: "skipped", avatarId, reason, ...(reason === "failure-rate" ? { failed: counts?.failed ?? 0, total: counts?.total ?? 0 } : {}) });
  }

  /** An end the table has no row for (a defect, or a cause that is not this file's): the avatar stays where it is and nothing more is sent. */
  #stuck(avatarId: string, why: string): "end" {
    this.#warn(`studio engine: the paid path of avatar ${avatarId} waits: ${why}`);
    return "end";
  }

  // ---------- the persisted state ----------

  #rowOf(ctx: LaunchStepsContext, avatarId: string): FileAvatar {
    const row = ctx.file().avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined) throw new Error(`avatar ${avatarId} is not in launch ${ctx.launchId}`);
    return row;
  }

  /**
   * A whole-file rewrite through the context. The core refuses a step's write once the launch is paused or ended (nothing continues during «Пауза», A13): a step that meets that
   * refusal because the launch stopped running meanwhile just stops writing; any other refusal is a defect and is thrown.
   */
  async #rewrite(ctx: LaunchStepsContext, change: (file: LaunchFile) => LaunchFile | null): Promise<void> {
    try {
      await ctx.update(change);
    } catch (error) {
      if (ctx.isRunning()) throw error;
    }
  }

  /** Sets the avatar's phase (and `waiting`), as one whole-file rewrite; writes nothing when it already reads so. A row that reached `montage`/`done` or was skipped never goes back. */
  async #setPhase(ctx: LaunchStepsContext, avatarId: string, phase: "composing" | "awaiting-review" | "drawing" | "montage" | "waiting", waiting?: { reason: "avatar-busy" | "open-set" | "paid-hold" }): Promise<void> {
    await this.#rewrite(ctx, (file) => {
      const row = file.avatars.find((a) => a.avatarId === avatarId);
      if (row === undefined || row.phase === "skipped") return null;
      if ((row.phase === "montage" || row.phase === "done") && phase !== "montage") return null;
      const nextWaiting = phase === "waiting" ? (waiting ?? { reason: "paid-hold" as const }) : null;
      if (row.phase === phase && row.waiting?.reason === nextWaiting?.reason) return null;
      return this.#patchRow(file, avatarId, (a) => ({ ...a, phase, waiting: nextWaiting }));
    });
  }

  #patchRow(file: LaunchFile, avatarId: string, change: (row: FileAvatar) => FileAvatar): LaunchFile {
    return { ...file, avatars: file.avatars.map((a) => (a.avatarId === avatarId ? change(a) : a)) };
  }

  /** The set as the avatar's pass sees it. An avatar cut by the unread-sets rule (its whole allocation counts as spent and its sets are outside the group) reads as unreadable: the same rule everywhere. */
  async #readSetFor(ctx: LaunchStepsContext, avatarId: string, sceneSetId: string): Promise<SetRead> {
    if (ctx.isCut(avatarId)) return { kind: "unreadable" };
    return this.#readSet(avatarId, sceneSetId);
  }

  async #readSet(avatarId: string, sceneSetId: string): Promise<SetRead> {
    const library = this.#d.port().library;
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open" });
    const set = await library.sceneSets.get(avatarId, sceneSetId);
    if (set !== null) return { kind: "set", set };
    // `get` answers null for a missing file and for one that cannot be read: the avatar's listing tells them apart (an unreadable record may be this set: fail closed).
    const listed = await library.sceneSets.list(avatarId);
    return listed.unreadable > 0 ? { kind: "unreadable" } : { kind: "missing" };
  }

  /** Any reserve of the set's own attempts (`<setId>:…`): the set was made, whatever its file says now. */
  #ledgerHasSet(sceneSetId: string): boolean {
    const budget = this.#d.port().budget;
    if (budget === null) return true;
    return budget.ledger.lines.some((line) => line.type === "reserve" && line.attemptId.startsWith(`${sceneSetId}:`));
  }

  /** The chunks that still have a scene to write and an attempt left. */
  #pendingWrites(set: StoredSceneSet): number {
    const budget = this.#d.port().budget;
    return pendingChunks(set, budget === null ? null : budget.ledger).length;
  }

  #remember(launchId: string, set: MirrorSource): void {
    const planned = plannedOf(set);
    const withoutText = planned.filter((s) => s.text === null).length;
    const draw = set.launchDraw;
    const taken = new Set((draw?.slices ?? []).flatMap((s) => s.sceneIds));
    const undrawn = draw === undefined ? 0 : draw.sceneIds.filter((id) => !taken.has(id)).length;
    const slices = draw?.slices.length ?? 0;
    const key = this.#key(launchId, set.avatarId);
    this.#mirrors.set(key, {
      sceneSetId: set.sceneSetId,
      setRevision: set.revision,
      scenes: planned.length,
      scenesWithoutText: withoutText,
      continuePhotos: planned.length - withoutText,
      slice: slices === 0 ? null : { index: slices, total: Math.max(slices, Math.ceil((draw?.sceneIds.length ?? 0) / SLICE_MAX_PHOTOS)) },
      undrawnScenes: undrawn,
      resumableSlots: this.#resumable.get(key) ?? 0,
    });
  }

  /** The restore's read of one set's slice runs: how many slots a started slice could still draw. A launch released meanwhile, or a read that fails, leaves the row as it was. */
  async #refreshResumable(launchId: string, source: MirrorSource): Promise<void> {
    try {
      const port = this.#d.port();
      // No library behind the port yet (it is opening, or being left): not a set that is gone. The next view of the row reads again.
      if (port.library === null) throw new Error("no library");
      const stored = await port.library.sceneSets.get(source.avatarId, source.sceneSetId);
      if (stored === null || stored.launchDraw === undefined) return;
      const statuses = await port.sliceStatuses(stored);
      const key = this.#key(launchId, source.avatarId);
      // Released (stopped, done) or replaced by another set while the folders were read: there is no row to fill.
      if (this.#mirrors.get(key)?.sceneSetId !== stored.sceneSetId) return;
      this.#resumable.set(key, openSlotsOf(stored.launchDraw.slices, statuses));
      // The read is older than the mirror when an edit landed meanwhile: it keeps its newer revision and only the slots are new.
      const current = this.#mirrors.get(key);
      if (current === undefined || stored.revision >= current.setRevision) this.#remember(launchId, stored);
      else this.#mirrors.set(key, { ...current, resumableSlots: this.#resumable.get(key) ?? 0 });
      this.#notifyMirror(launchId);
    } catch {
      // The engine is not behind the port yet, or the library is switching: the next view that asks for this row reads again.
      this.#unread.set(this.#key(launchId, source.avatarId), { launchId, source });
    }
  }

  #track(work: Promise<void>): void {
    this.#background.add(work);
    void work.finally(() => this.#background.delete(work));
  }

  #notifyMirror(launchId: string): void {
    for (const listener of this.#mirrorListeners) {
      try {
        listener(launchId);
      } catch (error) {
        this.#warn(`studio engine: a listener of the set mirrors failed (${error instanceof Error ? error.name : typeof error})`);
      }
    }
  }

  /** Follows the sets of this instance's launches: an owner's edit during the review moves the revision the view names, and the launch is announced again. */
  #subscribe(): void {
    if (this.#subscribed) return;
    try {
      const port = this.#d.port();
      if (port.onSetChanged === undefined) return;
      port.onSetChanged((set) => {
        if (set.launchId === undefined || !(this.#ctxs.has(set.launchId) || this.#restored.has(set.launchId))) return;
        this.#remember(set.launchId, set);
        this.#ctxs.get(set.launchId)?.touch();
        // A launch restored after a restart has no context to touch until «Продолжить»: the orchestrator hears of it here (S4.6v).
        if (!this.#ctxs.has(set.launchId)) this.#notifyMirror(set.launchId);
      });
      this.#subscribed = true;
    } catch {
      // The engine is not behind the port yet (the steps are built before it): the next call tries again.
    }
  }

  // ---------- lanes, the soft stop ----------

  /** One compose or «Дописать» start at a time, one paid draw at a time (plan D2). */
  #inLane<T>(lane: "compose" | "draw", work: () => Promise<T>): Promise<T> {
    const chain = lane === "compose" ? this.#composeLane : this.#drawLane;
    const run = chain.then(work, work);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    if (lane === "compose") this.#composeLane = next;
    else this.#drawLane = next;
    return run;
  }

  #startEnded(): void {
    this.#starting = Math.max(0, this.#starting - 1);
    if (this.#starting > 0) return;
    const waiters = this.#startWaiters;
    this.#startWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves when no compose or «Дописать» is inside its start window. */
  async #composeSettled(): Promise<void> {
    while (this.#starting > 0) await new Promise<void>((resolve) => this.#startWaiters.push(resolve));
  }

  /** The soft stop of «Пауза» and «Стоп»: every job of the launch, started or starting. Idempotent; a start that returns later is stopped by its own re-check. */
  #softStopAll(): void {
    const port = this.#d.port();
    for (const sceneSetId of this.#liveSets) port.softStopScenes(sceneSetId);
    for (const runId of this.#liveRuns) port.softStopRun(runId);
  }

  #notifyReady(): void {
    for (const listener of this.#readyListeners) {
      try {
        listener();
      } catch (error) {
        this.#warn(`studio engine: a finish listener failed (${error instanceof Error ? error.name : typeof error})`);
      }
    }
  }

  /** True while the launch runs and nothing holds its paid work: the one test before every paid move. */
  #mayPay(ctx: LaunchStepsContext): boolean {
    return ctx.isRunning() && ctx.file().paidHold === null;
  }

  async #log(ctx: LaunchStepsContext, line: Parameters<LaunchStepsContext["log"]>[0]): Promise<void> {
    await ctx.log(line);
  }

  #key(launchId: string, avatarId: string): string {
    return `${launchId}:${avatarId}`;
  }

  #now(): string {
    return new Date((this.#d.clock ?? Date.now)()).toISOString();
  }

  #warn(line: string): void {
    (this.#d.warn ?? ((l: string) => console.warn(l)))(line);
  }
}

/** n: the photos the launch planned for the avatar (the sum of its split). */
function plannedCount(row: FileAvatar): number {
  return row.generation === null ? 0 : row.generation.split.reduce((sum, s) => sum + s.count, 0);
}

export function createPaidSteps(deps: PaidStepsDeps): PaidSteps {
  return new PaidSteps(deps);
}
