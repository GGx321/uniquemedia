import { drawAllocationLeft, sliceSize, SLICE_MAX_PHOTOS, type LaunchScopeMoney } from "../../shared/autopilot/money";
import type { PaidHold, SkipReason } from "../../shared/engine/autopilot";
import { EngineFailure } from "../engineFailure";
import type { StoredSceneSet } from "../library/sceneSets";
import type { Ledger } from "../money/ledger";
import type { SliceStatus } from "../sceneSets/launchDraw";
import { sceneRefusal } from "../sceneSets/refusal";
import { pendingChunks } from "../sceneSets/chunks";
import type { LiveScope } from "./room";
import type { FileAvatar, LaunchFile } from "./launchFile";
import type { PaidPort } from "./paidPort";
import type { AvatarMirror, ContinueInput, ContinueOutcome, LaunchSteps, LaunchStepsContext, MirrorSource } from "./steps";

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
// NOT here (S4.6b2): the failure table of §4.6 (credits, key, network, halts, the bounded automatic continues), the failure-rate guard, `host.power`. A job that ends in a way this
// file has no rule for leaves the avatar where it is (`#stuck`: a warning in the console, nothing sent), so S4.6b2 has one place to plug the table in.

export interface PaidStepsDeps {
  /** The engine, behind the port. Lazy: the steps are built before the engine they serve. */
  port: () => PaidPort;
  warn?: (line: string) => void;
  /** How long an avatar that another job holds waits before the step tries again. */
  retryMs?: number;
  /** Epoch milliseconds, for the time of a hold. */
  clock?: () => number;
}

const DEFAULT_RETRY_MS = 3_000;
/** A pass over one avatar makes a bounded number of moves: each move changes the persisted state, so the bound is a defect guard, not a limit. Waiting for a busy avatar is no move. */
const MAX_MOVES = 12;

type SetRead = { kind: "set"; set: StoredSceneSet } | { kind: "missing" } | { kind: "unreadable" };
/** What a compose, a «Дописать» or an approval came to: "ran" a job started and ended; "busy" the avatar is held by another job; "retry" read the set again; "end" stop this pass. */
type Move = "ran" | "busy" | "retry" | "end";

const isFailure = (error: unknown, code: string): error is EngineFailure => error instanceof EngineFailure && error.error.code === code;
const plannedOf = (set: MirrorSource) => set.scenes.filter((s) => s.origin === "planned" && !s.removed);
const FINAL_PHASES: readonly string[] = ["montage", "done", "skipped"];

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

  constructor(deps: PaidStepsDeps) {
    this.#d = deps;
  }

  // ---------- the seam ----------

  begin(ctx: LaunchStepsContext): void {
    this.#ctxs.set(ctx.launchId, ctx);
    this.#subscribe();
    for (const row of ctx.file().avatars) {
      if (row.generation === null) continue;
      if (row.phase === "skipped" || row.phase === "done" || row.phase === "montage") continue;
      this.#start(ctx, row.avatarId);
    }
  }

  async drain(): Promise<void> {
    for (;;) {
      this.#softStopAll();
      const workers = [...this.#workers.values()];
      if (workers.length === 0) return;
      await Promise.allSettled(workers);
    }
  }

  async release(ctx: LaunchStepsContext): Promise<void> {
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
    return this.#mirrors.get(this.#key(launchId, avatarId)) ?? null;
  }

  /** The sets a library open found: the mirrors are there before «Продолжить», and the launch's set changes are followed from now on. */
  restore(launchId: string, sets: readonly MirrorSource[]): void {
    this.#restored.add(launchId);
    for (const set of sets) this.#remember(launchId, set);
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
      if (!this.#mayPay(ctx)) return;
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
          this.#stuck(avatarId, "the scenes of the set are not all written");
          return;
        }
        if (!(await settle(await this.#write(ctx, row, set)))) return;
        continue;
      }
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
        return this.#startFailed(ctx, row, error, async () => {
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
        return this.#startFailed(ctx, row, error, async () => {
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
      this.#resumable.set(
        this.#key(ctx.launchId, avatarId),
        draw.slices.reduce((sum, entry) => {
          const status = statuses.get(entry.runId);
          return sum + (status !== undefined && !status.finished ? (status.openSlots ?? 0) : 0);
        }, 0),
      );
      this.#remember(ctx.launchId, set);
      // A slice that has a run and is not finished is resumed inside its own cap, before anything new is drawn.
      const open = draw.slices.find((entry) => statuses.get(entry.runId)?.finished === false && !spent.has(entry.runId));
      if (open !== undefined) {
        const outcome = await this.#runSlice(ctx, row, open.runId);
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
      return this.#stuck(row.avatarId, `the price of a photo could not be read (${error instanceof Error ? error.name : typeof error})`);
    }
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

  /** Starts (or resumes) one slice run and waits for its end. "spent": nothing is left to run in it. "busy": the avatar is held. "end": stop this pass. */
  async #runSlice(ctx: LaunchStepsContext, row: FileAvatar, runId: string): Promise<"again" | "spent" | "busy" | "end"> {
    const port = this.#d.port();
    if (!this.#mayPay(ctx)) return "end";
    this.#liveRuns.add(runId);
    let started: Awaited<ReturnType<PaidPort["startLaunchSlice"]>>;
    try {
      started = await port.startLaunchSlice(runId);
    } catch (error) {
      this.#liveRuns.delete(runId);
      if (isFailure(error, "IN_FLIGHT")) return "busy";
      if (isFailure(error, "BUDGET_EXCEEDED")) {
        try {
          const detail = await port.resumeSliceHold(runId, await this.#liveSlices(ctx));
          await this.#hold(ctx, row.avatarId, { reason: "budget", at: this.#now(), detail });
          return "end";
        } catch {
          return this.#stuck(row.avatarId, "the month has no room for the slice and its hold could not be read");
        }
      }
      return this.#stuck(row.avatarId, `the slice could not be started (${error instanceof EngineFailure ? error.error.code : error instanceof Error ? error.name : "unknown"})`);
    }
    // The start has returned: a soft stop that found no job before this instant is sent again.
    if (!ctx.isRunning()) port.softStopRun(runId);
    this.#busyKeys.delete(this.#key(ctx.launchId, row.avatarId));
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
    // A soft stop ends the run cancelled with its slots open: «Продолжить» resumes it. Any other end is S4.6b2's table.
    if (!ctx.isRunning()) return "end";
    return this.#stuck(row.avatarId, `the slice ended ${end.status === "failed" ? `failed (${end.error.code})` : end.status}`);
  }

  // ---------- holds, waits, skips ----------

  /** A refused start of a compose or «Дописать»: the avatar is busy (wait), the allocation no longer covers it (a price hold), or it is not this file's to decide. */
  async #startFailed(
    ctx: LaunchStepsContext,
    row: FileAvatar,
    error: unknown,
    price: () => Promise<{ stage: "compose" | "rewrite"; needMicros: number; leftMicros: number }>,
  ): Promise<Move> {
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
    return this.#stuck(row.avatarId, `the set could not be written (${error instanceof EngineFailure ? error.error.code : error instanceof Error ? error.name : "unknown"})`);
  }

  async #hold(ctx: LaunchStepsContext, avatarId: string, hold: PaidHold): Promise<void> {
    await ctx.setPaidHold(hold);
    await this.#setPhase(ctx, avatarId, "waiting", { reason: "paid-hold" });
  }

  /** Another job holds the avatar: it waits as «avatar-busy» and tries again, never fails (plan §3.8). The line is logged once per episode. */
  async #busy(ctx: LaunchStepsContext, avatarId: string): Promise<void> {
    const key = this.#key(ctx.launchId, avatarId);
    if (!this.#busyKeys.has(key)) {
      this.#busyKeys.add(key);
      await this.#log(ctx, { at: this.#now(), kind: "avatar-busy", avatarId });
    }
    await this.#setPhase(ctx, avatarId, "waiting", { reason: "avatar-busy" });
    const wait = this.#d.retryMs ?? DEFAULT_RETRY_MS;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      timer.unref();
    });
  }

  /** The avatar leaves the launch; its allocation stays (nothing is released). Only generated videos that have no photos yet are dropped: a library or a rendering video is the free path's. */
  async #skip(ctx: LaunchStepsContext, avatarId: string, reason: Extract<SkipReason, "set-unreadable">): Promise<void> {
    await this.#rewrite(ctx, (file) =>
      this.#patchRow(file, avatarId, (a) => ({
        ...a,
        phase: "skipped",
        waiting: null,
        skipped: { reason },
        videos: a.videos.map((v) =>
          v.source === "generated" && (v.state === "planned" || v.state === "waiting-photos") ? { ...v, state: "dropped" as const, dropReason: "avatar-skipped" as const } : v,
        ),
      })),
    );
    await this.#log(ctx, { at: this.#now(), kind: "skipped", avatarId, reason });
  }

  /** An end this file has no rule for (S4.6b2's table): the avatar stays where it is and nothing more is sent. */
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
