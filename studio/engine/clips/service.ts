import {
  BOLD_CLIPS,
  GROK_FALLBACK,
  PROTOCOL_VERSION,
  type BoldClipsMode,
  type ClipFace,
  type ClipMonthFit,
  type ClipMotionChoice,
  type ClipOptions,
  type ClipRequest,
  type CommandPayload,
  type EngineError,
} from "../../shared/engine";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { CLIP_PLAN_READ_TIMEOUT_MS } from "../control";
import { EngineFailure } from "../engineFailure";
import type { ExportRootCheck } from "../exportRoot";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { ClipJobEnd, JobRegistry } from "../jobs";
import type { Library } from "../library";
import type { PhotoSidecar } from "../library/schemas";
import { scopeKey, type Budget, type ReserveHandle, type ReserveRequest } from "../money/budget";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { VIDEO_TIERS } from "../money/prices";
import { RECONCILE_QUIET_MS } from "../money/reconcile";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { clipOptionPrices, clipPricesOf, estimateClip } from "../money/videoEstimate";
import type { OpenRouterClient } from "../openrouter/types";
import type { RunPlan } from "../runs/plan";
import { EMBEDDING_COMPUTE_TIMEOUT_MS } from "../runs/timeouts";
import type { ExportNumberLibrary } from "../videos/exportNumbers";
import type { CommitTracker } from "../videos/live";
import type { RootLockOptions } from "../videos/rootLock";
import type { ClipRunDeps } from "./attempt";
import type { ClipFaceRole } from "./faceRole";
import { firstFrameRefusalOf } from "./firstFrame";
import { checkClipFace } from "./faceCheck";
import { clipFallbackOf, readFrameFacts, type FrameFacts } from "./frameFacts";
import { createClipHolds, type ClipHolds, type HoldTimers } from "./holds";
import { runClipJob, type ClipJobDeps, type ClipJobOutcome } from "./job";
import { parseClipAttemptId } from "./journal";
import { motionChoicesOf } from "./motion";
import { ClipRecords, type ClipRecordsDeps } from "./records";
import { holdsFromLedger, recoverClips, type ClipRecoveryHost } from "./recover";
import { clipsDirOf } from "./store";
import type { ClipTimings } from "./timings";

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.2, §5.9, I5.46-I5.50): the clip commands on the engine's service bag (the SceneSetService precedent). It owns:
// - the SLOT: one paid clip at a time, claimed synchronously at dispatch (before the first await, so two calls with no await between them make one job) and held, with the engine's
//   paid-command count (`paidStart`/`paidEnd`), until the clip's money closes (every reserve settled or abandoned);
// - the WORK count: every clip job from its start until its record, which the engine's library switch waits for;
// - the HOLD REGISTRY (V3b's `holds.ts`): which attempts may still bill, so the reconcile waits (`TOO_SOON`) and a held abandoned reserve of this process is not a reconcile reason; every change of
//   it announces the money again (`money.changed`), because no ledger line marks those moments;
// - the order of `clips.create`'s refusals, every one free and before any reserve or journal.
// A clip never claims its avatar (photo runs, edits and portraits go on), belongs to no launch group, and is registered with its avatar so a delete waits for it.

/** The video models a clip is priced for: the tiers V2 prices (VIDEO_TIERS), one GET of the listing for the three. */
const CLIP_PRICE_MODELS: PriceModels = { imageModels: [], chatModels: [], videoModels: Object.values(VIDEO_TIERS).map((tier) => tier.model) };

/** A face embedding is a free local computation, bounded like the portraits' (`EMBEDDING_COMPUTE_TIMEOUT_MS`). */
const MASTER_EMBEDDING_TIMEOUT_MS = EMBEDDING_COMPUTE_TIMEOUT_MS;

/** `read()`, or a rejection once `ms` passed: a plan that does not answer in time is no plan (the caller logs it and goes on without one). */
export async function readPlanWithin<T>(read: () => Promise<T>, ms: number): Promise<T> {
  const bound = timeoutSignal(ms);
  try {
    return await untilAborted(read(), bound.signal);
  } finally {
    bound.clear();
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts (it never rejects): the money state machine reads `signal.aborted` afterwards. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A signal that fires when either does. */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const fire = (): void => controller.abort();
  if (a.aborted || b.aborted) fire();
  else {
    a.addEventListener("abort", fire, { once: true });
    b.addEventListener("abort", fire, { once: true });
  }
  return controller.signal;
}

/** The engine's service bag, as the clip commands take it. */
export interface ClipServiceDeps {
  newId: () => string;
  /** Wall clock, epoch ms. */
  clock: () => number;
  /** The open library for a free read; null when none is open. */
  currentLibrary: () => Library | null;
  /** The live library for a paid command, counted by the dispatch's own `paidStart`. */
  liveLibrary: () => Promise<Library>;
  usableKey: (purpose: string) => string;
  paidBudget: () => Budget;
  /** The budget for a free read (`clips.options`' month), or null when the ledger cannot be read. */
  budget: () => Budget | null;
  prices: (models: PriceModels) => Promise<PricedBook>;
  checkAccepted: (worstMicros: number, acceptedWorstMicros: number) => void;
  checkMonthlyRoom: (budget: Budget, worstMicros: number) => void;
  /** The very figure `checkMonthlyRoom` refuses by (spent + open + held), as a yes or no: `clips.options`' month never disagrees with `clips.create`'s (I5.47). */
  monthFits: (budget: Budget, worstMicros: number) => boolean;
  /** The engine's paid-command count: a library switch and a reconcile are refused while it is above 0. */
  paidStart: () => void;
  paidEnd: () => void;
  setCap: (key: string, micros: number) => void;
  clearCap: (key: string) => void;
  openRouter: (key: string) => OpenRouterClient;
  jobs: JobRegistry;
  emit: (event: UnsequencedEvent) => void;
  emitMoney: () => void;
  markKeyRejected: (key: string) => void;
  /** An avatar delete is between its prepare and its finish for this avatar. */
  pendingDelete: (avatarId: string) => boolean;
  assertAvatarOnDisk: (library: Library, avatarId: string) => Promise<void>;
  readRunPlan: (library: Library, runId: string) => Promise<RunPlan>;
  /** The face worker's gate (embed for the master, check for the frames), or null when the engine has none. */
  faceGate: () => Pick<WorkerFaceGate, "embed" | "check" | "isBroken"> | null;
  timings: ClipTimings;
  /** Test knobs: the engine's fallback mode (`GROK_FALLBACK`) and `BOLD_CLIPS`. */
  mode?: "auto" | "offer";
  boldClips?: BoldClipsMode;
  /** Test seam: the hold registry's timers. */
  holdTimers?: HoldTimers;
  log: (line: string) => void;
  // ----- S5.V4c's members (the export commits like a render): declared and wired here, read by the export job -----
  /** The export folder, checked now (as a render's save checks it). */
  exportStatus: (requiredBytes?: number) => Promise<ExportRootCheck>;
  /** The renders' live commits: a clip export's temp and placeholder are registered here, so the render recovery never removes them. */
  liveCommits: CommitTracker;
  /** The export root's lock, held from the name claim to the rename. */
  withRootLock: <T>(root: string, work: () => Promise<T>, options?: RootLockOptions) => Promise<T>;
  /** What `highestNamedNumber` reads of the live library, or null when none is open. */
  exportNumbers: () => { library: ExportNumberLibrary; libraryRoot: string } | null;
}

type CreatePayload = CommandPayload<"clips.create">;

export class ClipService {
  readonly #deps: ClipServiceDeps;
  readonly #mode: "auto" | "offer";
  readonly #boldClips: BoldClipsMode;
  /** I5.48: the attempts that may still bill. Apart from the jobs: a job may end long before its hold does. */
  readonly holds: ClipHolds;
  /**
   * I5.50: the one paid clip, from its dispatch until its money closes. The holder is the create's own token, so only that clip can give the slot (and the paid count with it)
   * back, once: an earlier clip ending late never frees a later clip's slot.
   */
  #slot: object | null = null;
  /** Clip jobs from their start until their record (or their end without one). */
  #work = 0;
  /** The clips that have a job on their journal now: no second job on one journal. */
  readonly #activeClips = new Set<string>();
  /** The attempts this process reserved: only those, while held, are left out of the reconcile reasons (a foreign reserve stops paid work whatever its hold says). */
  readonly #ownAttempts = new Set<string>();
  /** Fired by `shutdown`: every clip job stops waiting (a reserve whose POST may have left stays open at worst). */
  readonly #stop = new AbortController();

  /** S5.V4a2: the committed records (list, get, markSeen, delete, retryDownload); the commands below hand over to it. */
  readonly #records: ClipRecords;

  constructor(deps: ClipServiceDeps) {
    this.#deps = deps;
    this.#mode = deps.mode ?? GROK_FALLBACK;
    this.#boldClips = deps.boldClips ?? BOLD_CLIPS;
    this.holds = createClipHolds({ now: deps.clock, ...(deps.holdTimers === undefined ? {} : { timers: deps.holdTimers }), onChange: () => deps.emitMoney() });
    this.#records = new ClipRecords({
      newId: deps.newId,
      clock: deps.clock,
      library: () => {
        const library = deps.currentLibrary();
        return library === null ? null : { hasAvatar: (avatarId) => library.getAvatar(avatarId) !== undefined, clipsDirOf: (avatarId) => clipsDirOf(library, avatarId) };
      },
      pendingDelete: deps.pendingDelete,
      ledger: () => deps.budget()?.ledger ?? null,
      jobs: deps.jobs,
      emit: deps.emit,
      usableKey: deps.usableKey,
      openRouter: deps.openRouter,
      // The folder as a file check wants it: a folder that was looked at and refused reads «elsewhere», one that did not answer reads «unchecked». The case probe is the cautious yes.
      exportRoot: async () => {
        const check = await deps.exportStatus();
        if (check.ok) return { root: check.root, rootId: check.rootId, caseInsensitive: true };
        return check.unanswered === true ? "unanswered" : null;
      },
      host: {
        busy: (clipId) => this.#activeClips.has(clipId),
        begin: (clipId) => {
          this.#work++;
          this.#activeClips.add(clipId);
          return () => {
            this.#work--;
            this.#activeClips.delete(clipId);
          };
        },
        stop: this.#stop.signal,
      },
      faceOf: (input) => this.#faceOf(input),
      log: deps.log,
    });
  }

  // ---------- the records (S5.V4a2) ----------

  list(payload: CommandPayload<"clips.list">): ReturnType<ClipRecords["list"]> {
    return this.#records.list(payload);
  }

  get(payload: CommandPayload<"clips.get">): ReturnType<ClipRecords["get"]> {
    return this.#records.get(payload);
  }

  markSeen(payload: CommandPayload<"clips.markSeen">): ReturnType<ClipRecords["markSeen"]> {
    return this.#records.markSeen(payload);
  }

  delete(payload: CommandPayload<"clips.delete">): ReturnType<ClipRecords["delete"]> {
    return this.#records.delete(payload);
  }

  retryDownload(payload: CommandPayload<"clips.retryDownload">): ReturnType<ClipRecords["retryDownload"]> {
    return this.#records.retryDownload(payload);
  }

  /** A fetched-again clip's face check (I5.52), as a created clip's: judged only when its photo was; a clip whose photo is gone, or whose gate or master cannot be had, is kept unchecked. */
  async #faceOf(input: Parameters<ClipRecordsDeps["faceOf"]>[0]): Promise<ClipFace> {
    const unchecked: ClipFace = { verdict: "skipped", frames: 0, why: "worker" };
    const library = this.#deps.currentLibrary();
    const photo = library?.getPhoto(input.record.sourcePhotoId);
    if (library === null || photo === undefined) return unchecked;
    const read = await readFrameFacts(photo, (runId) => readPlanWithin(() => this.#deps.readRunPlan(library, runId), CLIP_PLAN_READ_TIMEOUT_MS), this.#deps.log);
    if (read.kind !== "gallery") return unchecked;
    const role = read.facts.faceRole;
    const gate = this.#deps.faceGate();
    const masterEmbedding = role === "judged" && gate !== null && !gate.isBroken() ? await this.#masterEmbedding(library, input.record.avatarId, gate, input.signal) : null;
    if (role === "judged" && (gate === null || gate.isBroken() || masterEmbedding === null)) return unchecked;
    return checkClipFace({
      role,
      clipPath: input.clipPath,
      colour: input.colour,
      durationMs: input.durationMs,
      scratchDir: input.scratchDir,
      masterEmbedding: masterEmbedding ?? new Float32Array(0),
      gate: gate ?? { check: () => Promise.reject(new Error("no face gate")) },
      signal: input.signal,
      log: this.#deps.log,
    });
  }

  /** A clip job is running: the library must not change under it (`#busy()`). */
  busy(): boolean {
    return this.#work > 0;
  }

  /** A job works on this clip's files now. */
  isClipBusy(clipId: string): boolean {
    return this.#activeClips.has(clipId);
  }

  /** I5.48: an open reserve of this process that the registry still holds is not a reconcile reason; anything else is. */
  holdsOwnReserve(attemptId: string): boolean {
    return this.#ownAttempts.has(attemptId) && this.holds.untilOf(attemptId) !== undefined;
  }

  /** How long the reconcile must wait for the clips' holds, in whole ms (0: it need not). */
  reconcileWaitMs(): number {
    return Math.ceil(this.holds.waitMs());
  }

  /**
   * When the reconcile can run, or null when nothing delays it: the latest of the clips' holds and, for a clip's reserve of an EARLIER process, the reconcile's own quiet wait (about 5 min after a
   * restart, S5.V6), so the banner can say when without computing anything. A photo's reserve and a clip's own abandoned reserve add nothing here: the first is the photo path's, unchanged, and
   * the second is covered by its hold.
   */
  reconcileAvailableAt(): number | null {
    const held = this.reconcileWaitMs() > 0 ? this.holds.latestUntil() : null;
    const quiet = this.#quietUntil();
    return held === null ? quiet : quiet === null ? held : Math.max(held, quiet);
  }

  #quietUntil(): number | null {
    const budget = this.#deps.budget();
    if (budget === null) return null;
    const earlier = budget.ledger.openReserves().some((reserve) => parseClipAttemptId(reserve.attemptId) !== null && !budget.isInFlight(reserve.attemptId) && !this.#ownAttempts.has(reserve.attemptId));
    if (!earlier) return null;
    const { quietMs } = budget.quiet();
    return quietMs < RECONCILE_QUIET_MS ? this.#deps.clock() + Math.ceil(RECONCILE_QUIET_MS - quietMs) : null;
  }

  /**
   * The engine stops: the holds' timers are cleared, so no hold expiry is announced after this, and every clip job stops waiting. A clip that runs still ends on its own: once its POST
   * may have left it abandons its reserve (open at worst for the next start's reconcile), and announces `money.changed` and `job.cancelled` as it goes.
   */
  shutdown(): void {
    this.holds.clear();
    this.#stop.abort();
  }

  // ---------- a library became the live one (S5.V6, §5.12) ----------

  /**
   * The per-clip guard of a recovery job (no second job on one journal). It is NOT `#work`: a library switch does not wait for a recovery, it stops it (the journal and the holds stay, and
   * the next open of that library recovers again). An avatar delete still waits, since the job is registered with its avatar. Null: a job already works on that clip.
   */
  #enterWork(clipId: string): (() => void) | null {
    if (this.#activeClips.has(clipId)) return null;
    this.#activeClips.add(clipId);
    return () => {
      this.#activeClips.delete(clipId);
    };
  }

  /** The recoveries of the library that was live before the next one: stopped by `libraryOpened` and by `libraryClosed`. */
  #recoveryStop = new AbortController();
  /** The ids of the recovery jobs running now, whatever phase they are in: a cancel of one answers `job-running`. */
  readonly #recoveryJobs = new Set<string>();

  /** The live library went away with no other taking its place (LIBRARY_UNAVAILABLE): its recoveries stop too, with their journals and holds kept. */
  libraryClosed(): void {
    this.#recoveryStop.abort();
    this.#recoveryStop = new AbortController();
  }

  /**
   * The restart's holds when NO library is open at the start (a volume that is not mounted): the journals cannot be read, but the ledger can say which clip reserves are open, and each may be a
   * render still going. Held 60 min from the reserve line's `at`; a library opened later only extends (`recoverClips`).
   */
  restartHolds(): void {
    const reserves = (this.#deps.budget()?.ledger.openReserves() ?? []).filter((r) => parseClipAttemptId(r.attemptId) !== null);
    for (const [attemptId, untilMs] of holdsFromLedger(reserves, this.#deps.clock(), this.#deps.timings)) this.holds.hold(attemptId, untilMs);
  }

  /** The role the clip's source photo had at the gate, or null when it cannot be known (the photo is gone; a plan that does not read is no plan, as `clips.create` reads it). */
  async #faceRoleOf(library: Library, photoId: string): Promise<ClipFaceRole | null> {
    const photo = library.getPhoto(photoId);
    if (photo === undefined) return null;
    const read = await readFrameFacts(photo, (runId) => readPlanWithin(() => this.#deps.readRunPlan(library, runId), CLIP_PLAN_READ_TIMEOUT_MS), this.#deps.log);
    return read.kind === "not-a-gallery-photo" ? null : read.facts.faceRole;
  }

  /** Recovers the clips of a library that has just become the live one: the restart's holds, the sweep, and one free job per journal with no record. In the background; never rejects. */
  libraryOpened(library: Library): void {
    const deps = this.#deps;
    // The recoveries of the library before this one stop here: they leave their journals and holds, and that library recovers again when it is opened.
    this.#recoveryStop.abort();
    this.#recoveryStop = new AbortController();
    const host: ClipRecoveryHost = {
      clock: deps.clock,
      newId: deps.newId,
      timings: deps.timings,
      holds: this.holds,
      // The clip records' lock (V4a2's `withClipLock`) is not on this branch: until the two meet, the lock is a pass-through here. The integration follow-up passes the records' lock in its place.
      withClipLock: (_clipId, work) => work(),
      isCurrent: () => deps.currentLibrary() === library,
      isOwn: (attemptId) => this.#ownAttempts.has(attemptId),
      signal: eitherSignal(this.#stop.signal, this.#recoveryStop.signal),
      ledger: () => deps.budget()?.ledger ?? null,
      jobs: {
        startClip: (jobId, ref, phase) => {
          this.#recoveryJobs.add(jobId);
          return deps.jobs.startClip(jobId, ref, phase);
        },
        clipPhase: (jobId, update) => deps.jobs.clipPhase(jobId, update),
        finishClip: (jobId, end) => {
          this.#recoveryJobs.delete(jobId);
          return deps.jobs.finishClip(jobId, end);
        },
      },
      emit: deps.emit,
      work: { enter: (clipId) => this.#enterWork(clipId), anyActive: () => this.#activeClips.size > 0, isActive: (clipId) => this.#activeClips.has(clipId) },
      usableKey: deps.usableKey,
      openRouter: deps.openRouter,
      sleep: abortableSleep,
      faceGate: deps.faceGate,
      faceRoleOf: (photoId) => this.#faceRoleOf(library, photoId),
      masterEmbedding: (avatarId, signal) => this.#masterEmbedding(library, avatarId, deps.faceGate(), signal),
      log: deps.log,
    };
    recoverClips(host, library).catch((error: unknown) => deps.log(`[clip] the recovery of the library could not run (${error instanceof Error ? error.name : typeof error})`));
  }

  // ---------- clips.cancel (through avatars.cancel) ----------

  /** §5.1: a cancel is allowed only in `preparing`, before the POST; after it the clip is IN_FLIGHT `submitted` and goes on. A clip job that ended answers as cancelled. */
  cancel(jobId: string): void {
    const state = this.#deps.jobs.stateOf(jobId);
    if (state?.kind !== "clip") throw new EngineFailure({ code: "NOT_FOUND", detail: `no clip job ${jobId} in this engine` });
    if (state.status !== "running") return;
    // A recovery (after a restart) is not a clip that was just sent, in whatever phase it is in: its own words, from the existing texts.
    if (this.#recoveryJobs.has(jobId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: "the clip is being recovered after a restart; it cannot be cancelled" });
    if (state.phase !== "preparing") throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "submitted", detail: "the clip has already been sent; it cannot be cancelled" });
    this.#deps.jobs.cancel(jobId);
  }

  // ---------- clips.options ----------

  async options(payload: CommandPayload<"clips.options">): Promise<ClipOptions> {
    const library = this.#deps.currentLibrary();
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    const photo = this.#photoOf(library, payload.avatarId, payload.photoId);
    const read = await this.#facts(library, photo);
    if (read.kind === "refused") return { suitable: false, photoId: photo.id, reason: read.reason };
    const { facts } = read;
    const priced = await this.#deps.prices(CLIP_PRICE_MODELS);
    const fallback = clipFallbackOf(facts, this.#boldClips, this.#mode);
    const { prices, noFallbackPrices } = clipOptionPrices(priced, { mode: this.#mode, boldClips: this.#boldClips, bold: facts.bold });
    const budget = this.#deps.budget();
    const fit = (withWorst: number, withoutWorst: number): ClipMonthFit => {
      if (budget === null) return "none";
      if (fallback === "auto" && this.#deps.monthFits(budget, withWorst)) return "with-fallback";
      return this.#deps.monthFits(budget, withoutWorst) ? "without-fallback" : "none";
    };
    const monthFits = {
      std5: fit(prices.std5.worstMicros, noFallbackPrices.std5.worstMicros),
      pro5: fit(prices.pro5.worstMicros, noFallbackPrices.pro5.worstMicros),
      std10: fit(prices.std10.worstMicros, noFallbackPrices.std10.worstMicros),
      pro10: fit(prices.pro10.worstMicros, noFallbackPrices.pro10.worstMicros),
    };
    return { suitable: true, photoId: photo.id, motions: read.motions, prices, fallback, bold: facts.bold, noFallbackPrices, monthFits };
  }

  // ---------- clips.create ----------

  /** The slot is the FIRST check, taken before the first await: two calls with no await between them make exactly one job. */
  async create(payload: CreatePayload): Promise<{ jobId: string }> {
    if (this.#slot !== null) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "one-at-a-time", detail: "another clip is being made; one paid clip runs at a time" });
    const slot = {};
    this.#slot = slot;
    this.#deps.paidStart();
    let started = false;
    try {
      const answer = await this.#create(payload, slot);
      started = true;
      return answer;
    } finally {
      if (!started) this.#releaseSlot(slot);
    }
  }

  async #create(payload: CreatePayload, slot: object): Promise<{ jobId: string }> {
    const deps = this.#deps;
    const key = deps.usableKey("bring a photo to life");
    const budget = deps.paidBudget();
    const library = await deps.liveLibrary();
    const { avatarId } = payload;
    const photo = this.#photoOf(library, avatarId, payload.photoId);
    await deps.assertAvatarOnDisk(library, avatarId);

    const read = await this.#facts(library, photo);
    if (read.kind === "refused") throw new EngineFailure({ code: "VALIDATION", clipReason: read.reason, detail: `photo ${photo.id} cannot be brought to life (${read.reason})` });
    const { facts, bytes } = read;
    const motion = read.motions.find((choice) => choice.id === payload.motionId);
    if (motion === undefined) throw new EngineFailure({ code: "VALIDATION", clipReason: "unknown-motion", detail: `the motion ${payload.motionId} is not one this photo offers` });
    const photoFallback = clipFallbackOf(facts, this.#boldClips, this.#mode);
    // I5.47: a Grok clip is the offer of mode `offer`, on a photo that allows a fallback; anywhere else it is refused.
    if (payload.model === "grok" && (this.#mode !== "offer" || photoFallback === "none")) {
      throw new EngineFailure({ code: "VALIDATION", clipReason: "grok-not-offered", detail: "Grok is not offered for this clip" });
    }
    // What runs: a Grok clip and a frame of «Смелая» kept to Kling never fall back, whatever the payload says (I5.57).
    const request: ClipRequest = {
      model: payload.model,
      quality: payload.quality,
      seconds: payload.seconds,
      fallback: payload.model === "grok" || photoFallback === "none" ? "none" : payload.fallback,
    };

    const priced = await deps.prices(CLIP_PRICE_MODELS);
    const prices = clipPricesOf(priced);
    const estimate = estimateClip(priced, { ...request, bold: facts.bold }, { mode: this.#mode, boldClips: this.#boldClips });
    deps.checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
    deps.checkMonthlyRoom(budget, estimate.worstMicros);

    // After the last await, with none before the job is registered: a delete prepared meanwhile (the avatar detached), or a library switched away, wins.
    if (deps.pendingDelete(avatarId) || library.getAvatar(avatarId) === undefined || deps.currentLibrary() !== library) {
      throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is no longer in the open library` });
    }
    const jobId = deps.newId();
    const clipId = jobId;
    const cancel = deps.jobs.startClip(jobId, { avatarId, clipId });
    const capKey = scopeKey({ avatarJobId: clipId });
    // §5.9: the clip's scope cap; every reserve of the clip lives inside it, and it goes when the money closes.
    deps.setCap(capKey, Math.min(payload.acceptedWorstMicros, estimate.worstMicros));
    this.#work++;
    this.#activeClips.add(clipId);
    void this.#runJob({
      key,
      budget,
      library,
      jobId,
      clipId,
      avatarId,
      photo,
      bytes,
      facts,
      motion,
      request,
      acceptedWorstMicros: payload.acceptedWorstMicros,
      prices,
      capKey,
      cancel,
      slot,
    });
    return { jobId };
  }

  /** Gives the slot and the paid count back, once, and only for the clip that holds it. */
  #releaseSlot(slot: object): void {
    if (this.#slot !== slot) return;
    this.#slot = null;
    this.#deps.paidEnd();
  }

  // ---------- the job ----------

  async #runJob(job: {
    key: string;
    budget: Budget;
    library: Library;
    jobId: string;
    clipId: string;
    avatarId: string;
    photo: PhotoSidecar;
    bytes: Uint8Array;
    facts: FrameFacts;
    motion: ClipMotionChoice;
    request: ClipRequest;
    acceptedWorstMicros: number;
    prices: ReturnType<typeof clipPricesOf>;
    capKey: string;
    cancel: AbortSignal;
    /** The create's slot token: only this clip gives the slot back. */
    slot: object;
  }): Promise<void> {
    const deps = this.#deps;
    const signal = eitherSignal(job.cancel, this.#stop.signal);
    const ref = { kind: "clip" as const, jobId: job.jobId, avatarId: job.avatarId, clipId: job.clipId };
    let moneyClosed = false;
    /** Every reserve of the clip is settled or abandoned (or none was made): the slot, the paid count and the cap go, once. */
    const closeMoney = (): void => {
      if (moneyClosed) return;
      moneyClosed = true;
      this.#releaseSlot(job.slot);
      deps.clearCap(job.capKey);
      deps.emitMoney();
    };
    let end: ClipJobEnd;
    try {
      const client = deps.openRouter(job.key);
      const gate = deps.faceGate();
      const jobDeps: ClipJobDeps = {
        attempt: {
          budget: this.#budgetFor(job.budget),
          client,
          holds: this.holds,
          timings: deps.timings,
          now: deps.clock,
          sleep: abortableSleep,
        },
        download: client,
        faceGate: gate === null || gate.isBroken() ? null : gate,
        masterEmbedding: (embedSignal) => this.#masterEmbedding(job.library, job.avatarId, gate, embedSignal),
        onPhase: (update) => {
          const progress = deps.jobs.clipPhase(job.jobId, update);
          if (progress !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: progress });
        },
        onMoneyClosed: closeMoney,
        onMoneyNotice: (refusal) => {
          deps.log(`[clip] ${job.clipId}: Grok could not be reserved behind a free Kling (${refusal.reason}); the clip ends free`);
          deps.emitMoney();
        },
        log: deps.log,
      };
      const outcome = await runClipJob(
        jobDeps,
        {
          clipId: job.clipId,
          avatarId: job.avatarId,
          photoId: job.photo.id,
          photo: job.bytes,
          facts: job.facts,
          motion: job.motion,
          request: job.request,
          acceptedWorstMicros: job.acceptedWorstMicros,
          prices: job.prices,
          mode: this.#mode,
          boldClips: this.#boldClips,
          clipsDir: clipsDirOf(job.library, job.avatarId),
          createdAt: new Date(deps.clock()).toISOString(),
        },
        signal,
      );
      end = this.#endOf(outcome, job.key);
    } catch (error) {
      deps.log(`[clip] ${job.clipId}: the job failed (${error instanceof Error ? error.name : typeof error})`);
      end = { status: "failed", error: this.#errorOf(error) };
    } finally {
      // A fault before the chain ran (the client, the gate) still gives the slot and the paid count back: nothing of the clip's money can be open then.
      closeMoney();
      this.#work--;
      this.#activeClips.delete(job.clipId);
    }
    try {
      const state = deps.jobs.finishClip(job.jobId, end);
      const v = PROTOCOL_VERSION;
      if (state?.status === "done" && state.result !== undefined) deps.emit({ v, id: deps.newId(), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: state.result } });
      else if (end.status === "failed") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      else if (end.status === "cancelled") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
    } catch (error) {
      deps.log(`[clip] the end of job ${job.jobId} could not be announced (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  #endOf(outcome: ClipJobOutcome, key: string): ClipJobEnd {
    switch (outcome.kind) {
      case "recorded":
        if (outcome.record.outcome.status === "failed" && outcome.record.outcome.reason === "key-invalid") this.#deps.markKeyRejected(key);
        return { status: "done" };
      case "refused":
        return { status: "failed", error: outcome.error };
      case "cancelled":
      case "interrupted":
        return { status: "cancelled" };
    }
  }

  #errorOf(error: unknown): EngineError {
    if (error instanceof EngineFailure) return error.error;
    return { code: "INTERNAL", detail: "the clip job failed; its journal is kept for the next start" };
  }

  /** The engine's budget as the money state machine sees it: every reserve of this process is remembered (the reconcile reasons), and the money is announced after every ledger change. */
  #budgetFor(budget: Budget): ClipRunDeps["budget"] {
    const announce = (): void => this.#deps.emitMoney();
    return {
      ledger: budget.ledger,
      tryReserve: async (request: ReserveRequest) => {
        const result = await budget.tryReserve(request);
        if (result.ok) {
          this.#ownAttempts.add(request.attemptId);
          announce();
        }
        return result;
      },
      settle: async (handle: ReserveHandle, bill: { costMicros: number; estimated: boolean }) => {
        try {
          await budget.settle(handle, bill);
        } finally {
          announce();
        }
      },
      abandon: async (handle: ReserveHandle) => {
        await budget.abandon(handle);
        announce();
      },
      release: async (handle: ReserveHandle, reason: string) => {
        await budget.release(handle, reason);
        announce();
      },
    };
  }

  /** The master's embedding, taken once at the job's start (a master switch during the clip does not move its verdict). Null, logged, when it cannot be taken: the clip is kept unchecked. */
  async #masterEmbedding(library: Library, avatarId: string, gate: Pick<WorkerFaceGate, "embed"> | null, signal: AbortSignal): Promise<Float32Array | null> {
    if (gate === null) return null;
    const bound = timeoutSignal(MASTER_EMBEDDING_TIMEOUT_MS);
    const either = eitherSignal(bound.signal, signal);
    try {
      const original = await untilAborted(library.loadMasterOriginal(avatarId), either);
      if (original === null) return null;
      const embedding = await untilAborted(gate.embed(original, either), either);
      return embedding.length > 0 && embedding.every(Number.isFinite) && !embedding.every((v) => v === 0) ? embedding : null;
    } catch (error) {
      if (signal.aborted) throw error;
      this.#deps.log(`[clip] the master of avatar ${avatarId} could not be embedded (${error instanceof Error ? error.name : typeof error}); the clip's face is not checked`);
      return null;
    } finally {
      bound.clear();
    }
  }

  // ---------- reads ----------

  /** The avatar's photo: NOT_FOUND for an avatar that is not active (or is being deleted), and for a photo that is not the avatar's. */
  #photoOf(library: Library, avatarId: string, photoId: string): PhotoSidecar {
    const avatar = library.getAvatar(avatarId);
    if (avatar === undefined || avatar.status !== "active" || this.#deps.pendingDelete(avatarId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });
    const photo = library.getPhoto(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} has no photo ${photoId}` });
    return photo;
  }

  /**
   * The photo's facts and motions, or why it cannot be brought to life, in `clips.create`'s order (§5.2): not a gallery photo, its age, its pixels (unreadable, not 9:16), «Смелая» off,
   * no motion. The run plan is read under CLIP_PLAN_READ_TIMEOUT_MS; any failure to read it, a timeout included, is no plan.
   */
  async #facts(
    library: Library,
    photo: PhotoSidecar,
  ): Promise<
    { kind: "suitable"; facts: FrameFacts; bytes: Uint8Array; motions: ReturnType<typeof motionChoicesOf> } | { kind: "refused"; reason: Extract<ClipOptions, { suitable: false }>["reason"] }
  > {
    const log = this.#deps.log;
    const result = await readFrameFacts(photo, (runId) => readPlanWithin(() => this.#deps.readRunPlan(library, runId), CLIP_PLAN_READ_TIMEOUT_MS), log);
    if (result.kind === "not-a-gallery-photo") return { kind: "refused", reason: "not-a-gallery-photo" };
    const { facts } = result;
    if (facts.ageRefused) return { kind: "refused", reason: "age-unverified" };
    let bytes: Uint8Array;
    try {
      bytes = await library.readPhotoVerified(photo.id);
    } catch (error) {
      log(`[clip] photo ${photo.id} could not be read (${error instanceof Error ? error.name : typeof error})`);
      return { kind: "refused", reason: "photo-unreadable" };
    }
    const pixels = firstFrameRefusalOf(bytes);
    if (pixels !== null) return { kind: "refused", reason: pixels };
    if (facts.bold && this.#boldClips === "off") return { kind: "refused", reason: "bold-off" };
    const motions = motionChoicesOf(facts, log);
    if (motions.length === 0) return { kind: "refused", reason: "no-motion" };
    return { kind: "suitable", facts, bytes, motions };
  }
}
