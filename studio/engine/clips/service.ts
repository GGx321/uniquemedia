import {
  BOLD_CLIPS,
  CLIP_OPTION_KEYS,
  GROK_FALLBACK,
  PROTOCOL_VERSION,
  clipBatchExpectedMicros,
  clipBatchWorstMicros,
  clipWorstMicros,
  type BoldClipsMode,
  type ClipBatchOptions,
  type ClipFace,
  type ClipMonthFit,
  type ClipMotionChoice,
  type ClipOptionKey,
  type ClipOptions,
  type ClipPrices,
  type ClipRequest,
  type CommandPayload,
  type EngineError,
} from "../../shared/engine";
import type { Estimate } from "../../shared/engine/estimate";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { CLIP_PLAN_READ_PARALLEL, CLIP_PLAN_READ_TIMEOUT_MS } from "../control";
import { EngineFailure } from "../engineFailure";
import type { ExportRootCheck } from "../exportRoot";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { ClipBatchRef, ClipJobEnd, JobRegistry } from "../jobs";
import type { Library } from "../library";
import type { PhotoSidecar } from "../library/schemas";
import { scopeKey, type Budget, type ReserveHandle, type ReserveRefusal, type ReserveRequest } from "../money/budget";
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
import { ClipBatch, type BatchMember, type BatchPorts, type MemberRun, type PhotoRecheck } from "./batch";
import { ClipExports } from "./export";
import { ClipCopies, type ClipCopyMedia, type DraftView, type KnownAvatars } from "./copies";
import { ClipImports, type ClipMediaPort } from "./importClip";
import type { ExportFpsMode } from "./exportProfile";
import type { ClipFaceRole } from "./faceRole";
import { firstFrameRefusalOf } from "./firstFrame";
import { checkClipFace } from "./faceCheck";
import { clipFallbackOf, readFrameFacts, type FrameFacts } from "./frameFacts";
import { createClipHolds, type ClipHolds, type HoldTimers } from "./holds";
import { runClipJob, type ClipJobDeps, type ClipJobOutcome, type ClipMoneyEnd } from "./job";
import { clipAttemptId, parseClipAttemptId } from "./journal";
import { motionChoicesOf } from "./motion";
import { openClipReserveMicros } from "./openReserve";
import { ClipRecords, type ClipRecordsDeps } from "./records";
import { clipFaceOf } from "./ready";
import { holdsFromLedger, recoverClips, type ClipRecoveryHost } from "./recover";
import type { ClipRecord } from "./schemas";
import { clipsDirOf } from "./store";
import type { ClipTimings } from "./timings";

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.2, §5.9, I5.46-I5.50): the clip commands on the engine's service bag (the SceneSetService precedent). It owns:
// - the SLOT: one paid clip at a time, claimed synchronously at dispatch (before the first await, so two calls with no await between them make one job) and held, with the engine's
//   paid-command count (`paidStart`/`paidEnd`), until the clip's money closes (every reserve settled or abandoned);
// - the WORK count: every create job and download retry from its start until its record, which the engine's library switch waits for (a restart's recovery is not counted: a switch stops it);
// - the per-clip guard (`#activeClips`): ONE set for every job on a clip (create, retry, recovery), which a delete or a retry of that clip answers `job-running` by;
// - the HOLD REGISTRY (V3b's `holds.ts`): which attempts may still bill, so the reconcile waits (`TOO_SOON`) and a held abandoned reserve of this process is not a reconcile reason; every change of
//   it announces the money again (`money.changed`), because no ledger line marks those moments;
// - the order of `clips.create`'s refusals, every one free and before any reserve or journal.
// A clip never claims its avatar (photo runs, edits and portraits go on), belongs to no launch group, and is registered with its avatar so a delete waits for it.

/** The video models a clip is priced for: the tiers V2 prices (VIDEO_TIERS), one GET of the listing for the three. */
const CLIP_PRICE_MODELS: PriceModels = { imageModels: [], chatModels: [], videoModels: Object.values(VIDEO_TIERS).map((tier) => tier.model) };

/** A face embedding is a free local computation, bounded like the portraits' (`EMBEDDING_COMPUTE_TIMEOUT_MS`). */
const MASTER_EMBEDDING_TIMEOUT_MS = EMBEDDING_COMPUTE_TIMEOUT_MS;
/** What a reconcile refused for the startup walk is told to wait before it tries again. */
const WALK_RETRY_MS = 2_000;

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

/** A Kling clip refused for free whose request kept its fallback: what mode `offer` offers on Grok. */
function offersGrok(record: ClipRecord): boolean {
  return record.outcome.status === "failed" && record.outcome.reason === "refused-free" && record.request.model === "kling" && record.request.fallback === "auto";
}

/** A refusal of the batch's month hold, as the command's error: the codes map one to one (the batch is refused whole, and nothing was held). */
function holdRefusalOf(refusal: ReserveRefusal): EngineError {
  switch (refusal.reason) {
    case "BUDGET_EXCEEDED":
    case "RUN_CAP_EXCEEDED":
      return { code: refusal.reason, detail: `committed ${refusal.committedMicros} µ$ + the batch's ${refusal.worstMicros} µ$ > the limit ${refusal.limitMicros} µ$; nothing was held` };
    case "RECONCILE_REQUIRED":
      return { code: "RECONCILE_REQUIRED", detail: `${refusal.openAttempts} open attempt(s)${refusal.torn ? ", a torn ledger line" : ""}; reconcile before a batch; nothing was held` };
    case "HALTED":
      return { code: refusal.cause, detail: "the ledger is halted; nothing was held" };
  }
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
  /** 5b.2: the same month figure as a room, `max(0, monthlyBudget - (spent + open + held))`: `clips.batchOptions` reads it once and derives every `monthFits` from it, so its answer agrees with itself. */
  monthRoomMicros: (budget: Budget) => number;
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
  /** Test seam: the records' removal of a file (the delete's), so a test can hold a delete in its middle. */
  records?: Pick<ClipRecordsDeps, "remove">;
  /** Test seam: awaited before each clips folder of a library's startup walk is listed, so a test can hold the walk open. */
  recoveryBeforeList?: (dir: string) => void | Promise<void>;
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
  /** Test knob: the export's fps mode (`EXPORT_FPS` when absent). */
  exportFps?: ExportFpsMode;
  /** The engine's export folder switch, as a render reads it: a pick waiting for its settings, and the folder the settings name now. */
  exportSwitch?: { pending(): boolean; currentPath(): string };
  /** 5b.2 (S5.WA2): the own-media service, for `media.importClip`. Absent: the command answers INTERNAL (a test that builds a clip service without media). */
  media?: ClipMediaPort & ClipCopyMedia;
  /** 5b.2 (S5.WA2): the avatar's saved montage drafts, for `ClipSummary.use.inDrafts` (which drafts hold a clip's copy). Absent: no clip has `inDrafts`. */
  drafts?: (avatarId: string) => Promise<readonly DraftView[]>;
}

type CreatePayload = CommandPayload<"clips.create">;
type CreateBatchPayload = CommandPayload<"clips.createBatch">;

/** The token of the one clip money unit: what holds it, and the batch it is when it is one. */
interface ClipUnit {
  readonly kind: "clip" | "batch";
}

/** A photo of a batch as read at create or in `clips.batchOptions`: why it cannot be made, or its facts and the motions it offers. */
type ItemRead =
  | { kind: "refused"; reason: Extract<ClipOptions, { suitable: false }>["reason"] }
  | { kind: "suitable"; facts: FrameFacts; motions: ReturnType<typeof motionChoicesOf> };

/** Finished batches kept for a late `clips.cancelBatch`. */
const KEEP_FINISHED_BATCHES = 50;

export class ClipService {
  readonly #deps: ClipServiceDeps;
  readonly #mode: "auto" | "offer";
  readonly #boldClips: BoldClipsMode;
  /** I5.48: the attempts that may still bill. Apart from the jobs: a job may end long before its hold does. */
  readonly holds: ClipHolds;
  /**
   * I5.50 / I5.61: the ONE clip money unit of the whole engine, from its dispatch until its money closes: a single clip, or a batch (until its last member's money closes). The holder is
   * the dispatch's own token, so only that unit can give the paid count back, once: an earlier clip ending late never frees a later unit.
   */
  #unit: ClipUnit | null = null;
  /** 5b.2: the batches of this process, by id; a finished one stays (bounded) so a late `clips.cancelBatch` answers 0 and not NOT_FOUND. */
  readonly #batches = new Map<string, ClipBatch>();
  /** Create jobs and download retries from their start until their record (or their end without one); a recovery is not counted. */
  #work = 0;
  /** The clips a job works on now (create, retry, recovery): no second job on one clip, and a delete or a retry of one is `job-running`. */
  readonly #activeClips = new Set<string>();
  /** The attempts this process reserved: only those, while held, are left out of the reconcile reasons (a foreign reserve stops paid work whatever its hold says). */
  readonly #ownAttempts = new Set<string>();
  /**
   * Startup walks of a library's clips folders still running, by the time each began (S5.VR): until one has taken the restart's holds, the reconcile cannot know what may still bill. A walk that hangs
   * (a dropped external disk) is waited for only until `holdSubmittedMs` after it began: every restart hold counts from an `at` earlier than the start, so none can run past that.
   */
  readonly #walks = new Map<number, number>();
  #walkSeq = 0;
  /** Fired by `shutdown`: every clip job stops waiting (a reserve whose POST may have left stays open at worst). */
  readonly #stop = new AbortController();

  /** S5.V4a2: the committed records (list, get, markSeen, delete, retryDownload); the commands below hand over to it. */
  readonly #records: ClipRecords;
  /** S5.V4c: «Сохранить в папку», the export jobs (one at a time). */
  readonly #exports: ClipExports;
  /** 5b.2 (S5.WA2): a clip becoming the montage's own video; absent when the service was built without the media service. */
  readonly #imports: ClipImports | null;
  /** 5b.2 (S5.WA2): how long a clip's montage copy lives (a clip delete, an avatar delete, the library-open sweep); absent without the media service. */
  readonly #copies: ClipCopies | null;

  constructor(deps: ClipServiceDeps) {
    this.#deps = deps;
    this.#mode = deps.mode ?? GROK_FALLBACK;
    this.#boldClips = deps.boldClips ?? BOLD_CLIPS;
    const copies = deps.media === undefined ? null : new ClipCopies({ media: deps.media, ...(deps.drafts === undefined ? {} : { drafts: deps.drafts }), log: deps.log });
    this.#copies = copies;
    this.holds = createClipHolds({ now: deps.clock, ...(deps.holdTimers === undefined ? {} : { timers: deps.holdTimers }), onChange: () => deps.emitMoney() });
    // A job on a clip (a download retry, an export) holds the clip against its other commands and the library against a switch, until it ends.
    const host = {
      busy: (clipId: string) => this.#activeClips.has(clipId),
      begin: (clipId: string) => {
        this.#work++;
        this.#activeClips.add(clipId);
        return () => {
          this.#work--;
          this.#activeClips.delete(clipId);
        };
      },
      stop: this.#stop.signal,
    };
    this.#records = new ClipRecords({
      newId: deps.newId,
      clock: deps.clock,
      library: () => {
        const library = deps.currentLibrary();
        return library === null ? null : { root: library.root, hasAvatar: (avatarId) => library.getAvatar(avatarId) !== undefined, clipsDirOf: (avatarId) => clipsDirOf(library, avatarId) };
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
      host,
      faceOf: (input) => this.#faceOf(input),
      log: deps.log,
      ...(deps.records?.remove === undefined ? {} : { remove: deps.records.remove }),
      ...(copies === null
        ? {}
        : {
            copies: { removeOf: (avatarId: string, clipId: string, root: string) => copies.removeOfClip(avatarId, clipId, root) },
            // 5b.2 (Q-F = 1): what uses a ready clip: a finished video (the used index) and the saved drafts that hold its copy.
            uses: {
              videoUse: (avatarId: string, clipId: string, photoId: string) => deps.currentLibrary()?.videoUseOfClip(avatarId, clipId, photoId),
              draftsOf: (avatarId: string) => copies.draftUsesOf(avatarId),
            },
          }),
    });
    this.#exports = new ClipExports({
      newId: deps.newId,
      clock: deps.clock,
      log: deps.log,
      library: () => {
        const library = deps.currentLibrary();
        return library === null ? null : { key: library, clipsDirOf: (avatarId) => clipsDirOf(library, avatarId), avatar: (avatarId) => library.getAvatar(avatarId) };
      },
      pendingDelete: deps.pendingDelete,
      jobs: deps.jobs,
      emit: deps.emit,
      host,
      withClipLock: (clipId, work) => this.#records.withClipLock(clipId, work),
      rewrite: (avatarId, clipId, build) => this.#records.rewrite(avatarId, clipId, build),
      exportStatus: deps.exportStatus,
      liveCommits: deps.liveCommits,
      withRootLock: deps.withRootLock,
      exportNumbers: deps.exportNumbers,
      ...(deps.exportFps === undefined ? {} : { fps: deps.exportFps }),
      ...(deps.exportSwitch === undefined ? {} : { exportSwitch: deps.exportSwitch }),
    });
    this.#imports =
      deps.media === undefined
        ? null
        : new ClipImports({
            media: deps.media,
            locate: (avatarId, clipId) => this.#records.locate(avatarId, clipId),
            withClipLock: (clipId, work) => this.#records.withClipLock(clipId, work),
            host,
            log: deps.log,
          });
  }

  // ---------- a clip becomes the montage's own video (5b.2, S5.WA2) ----------

  /** `media.importClip`: the copy's media id at once when a live copy exists, else the id of the import job that starts. See `ClipImports`. */
  importClip(payload: CommandPayload<"media.importClip">): Promise<{ mediaId: string } | { jobId: string }> {
    if (this.#imports === null) return Promise.reject(new EngineFailure({ code: "INTERNAL", detail: "media.importClip is not implemented yet" }));
    return this.#imports.start(payload);
  }

  /** The avatar went to the Trash: its montage copies are removed, asynchronously and quietly (what cannot go now is swept at the next library open). */
  removeCopiesOfAvatar(avatarId: string, root: string): Promise<void> {
    return this.#copies?.removeOfAvatar(avatarId, root) ?? Promise.resolve();
  }

  /** The library-open sweep of copies whose avatar and whose avatar folder are gone. Never throws. */
  sweepCopies(avatars: KnownAvatars): Promise<number> {
    return this.#copies?.sweep(avatars) ?? Promise.resolve(0);
  }

  /** A clip import of this avatar runs: an avatar delete waits for it (the import job has no avatar in the job registry). */
  importingFor(avatarId: string): boolean {
    return this.#imports?.importingFor(avatarId) ?? false;
  }

  // ---------- «Сохранить в папку» (S5.V4c) ----------

  export(payload: CommandPayload<"clips.export">): Promise<{ jobId: string }> {
    return this.#exports.start(payload);
  }

  /** An export is queued or running: it saves into the current export folder, so a pick of another one waits (`export.choose`). */
  exporting(): boolean {
    return this.#exports.active() > 0;
  }

  // ---------- the records (S5.V4a2) ----------

  list(payload: CommandPayload<"clips.list">): ReturnType<ClipRecords["list"]> {
    return this.#records.list(payload, { grokOffers: (records) => this.#grokOffers(records) });
  }

  /**
   * §5.2, §5.7 (I5.47): the Grok offer of each listed clip that has one, computed now from the live price book. Only mode `offer` offers, and only on a Kling clip refused for free whose request
   * kept its fallback: a Grok clip, a clip whose owner chose no fallback, and a frame of «Смелая» kept to Kling (its fallback was forced to `none` at create) are never offered. The offer is Grok's
   * own clip of the same length, the figure `clips.options` shows (`grok5` / `grok10`). With no clip to offer no price is read; a book that cannot be read leaves the offers out of the list.
   */
  async #grokOffers(records: readonly ClipRecord[]): Promise<Map<string, Estimate>> {
    const offered = this.#mode === "offer" ? records.filter(offersGrok) : [];
    if (offered.length === 0) return new Map();
    try {
      const { prices } = clipOptionPrices(await this.#deps.prices(CLIP_PRICE_MODELS), { mode: this.#mode, boldClips: this.#boldClips, bold: false });
      return new Map(offered.map((record) => [record.id, record.request.seconds === 10 ? prices.grok10 : prices.grok5]));
    } catch (error) {
      this.#deps.log(`[clip] the Grok offer could not be priced (${error instanceof Error ? error.name : typeof error}); the clips are listed without it`);
      return new Map();
    }
  }

  get(payload: CommandPayload<"clips.get">): ReturnType<ClipRecords["get"]> {
    return this.#records.get(payload, { grokOffers: (records) => this.#grokOffers(records) });
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

  /** A fetched-again clip's face check (`clipFaceOf`), as a recovered clip's: the role of its photo in the live library (null when the photo is gone), the gate unless it is broken. */
  async #faceOf(input: Parameters<ClipRecordsDeps["faceOf"]>[0]): Promise<ClipFace> {
    const library = this.#deps.currentLibrary();
    const role = library === null ? null : await this.#faceRoleOf(library, input.record.sourcePhotoId);
    const gate = this.#deps.faceGate();
    const usable = gate === null || gate.isBroken() ? null : gate;
    return clipFaceOf({
      role,
      gate: usable,
      masterEmbedding: async () => (library === null ? null : this.#masterEmbedding(library, input.record.avatarId, usable, input.signal)),
      check: checkClipFace,
      clipPath: input.clipPath,
      colour: input.colour,
      durationMs: input.durationMs,
      scratchDir: input.scratchDir,
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

  /**
   * How long the reconcile must wait for the clips' holds, in whole ms (0: it need not). While a library's startup walk of the clips folders is still running the holds of a restart do not exist
   * yet, and only the reconcile's quiet rule (about 5 min) would hold it back: a walk slower than that, on a slow external disk, would let it settle at worst a clip that is still rendering. So it waits
   * for the walk, and asks to be tried again soon (S5.VR).
   */
  reconcileWaitMs(): number {
    const held = Math.ceil(this.holds.waitMs());
    return this.#walkWaiting() ? Math.max(held, WALK_RETRY_MS) : held;
  }

  /** A startup walk is running and still inside its bound. */
  #walkWaiting(): boolean {
    if (this.#walks.size === 0) return false;
    const began = Math.min(...this.#walks.values());
    return this.#deps.clock() < began + this.#deps.timings.holdSubmittedMs;
  }

  /**
   * When the reconcile can run, or null when nothing delays it: the latest of the clips' holds and, for a clip's reserve of an EARLIER process, the reconcile's own quiet wait (about 5 min after a
   * restart, S5.V6), so the banner can say when without computing anything. A photo's reserve and a clip's own abandoned reserve add nothing here: the first is the photo path's, unchanged, and
   * the second is covered by its hold.
   */
  reconcileAvailableAt(): number | null {
    const held = this.holds.waitMs() > 0 ? this.holds.latestUntil() : null;
    // While a walk runs the reconcile answers «in a moment», so the banner says that moment and not «now».
    const walk = this.#walkWaiting() ? this.#deps.clock() + WALK_RETRY_MS : null;
    const quiet = this.#quietUntil();
    const times = [held, quiet, walk].filter((t): t is number => t !== null);
    return times.length === 0 ? null : Math.max(...times);
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
    // An export reads the library's file and writes its record: it stops too (until its name is claimed; from then it finishes).
    this.#exports.libraryGone();
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
      // The records' own lock, the one a delete, a retry and every rewrite take: a recovery decides about a clip only between them, never in the middle of one.
      withClipLock: (clipId, work) => this.#records.withClipLock(clipId, work),
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
      ...(deps.recoveryBeforeList === undefined ? {} : { beforeList: deps.recoveryBeforeList }),
      log: deps.log,
    };
    const walkId = ++this.#walkSeq;
    this.#walks.set(walkId, deps.clock());
    recoverClips(host, library)
      .catch((error: unknown) => deps.log(`[clip] the recovery of the library could not run (${error instanceof Error ? error.name : typeof error})`))
      .finally(() => {
        const began = this.#walks.get(walkId) ?? deps.clock();
        this.#walks.delete(walkId);
        // The wait that the walk asked for ends here: a banner that showed «через пару секунд» refreshes. Only for a walk that outlasted that moment; a quick walk ends before anyone is told to wait,
        // and an event at every start would only trail the replies of the commands the start answers.
        if (deps.clock() - began >= WALK_RETRY_MS) deps.emitMoney();
      });
  }

  // ---------- clips.cancel (through avatars.cancel) ----------

  /** §5.1: a cancel is allowed only in `preparing`, before the POST; after it the clip is IN_FLIGHT `submitted` and goes on. A clip job that ended answers as cancelled. */
  cancel(jobId: string): void {
    const state = this.#deps.jobs.stateOf(jobId);
    if (state?.kind !== "clip") throw new EngineFailure({ code: "NOT_FOUND", detail: `no clip job ${jobId} in this engine` });
    if (state.status !== "running") return;
    // An export (S5.V4c) moves no money: it stops until its name is claimed, and ends `cancelled`.
    if (this.#exports.owns(jobId)) return this.#exports.cancel(jobId);
    // A recovery (after a restart) is not a clip that was just sent, in whatever phase it is in: its own words, from the existing texts.
    if (this.#recoveryJobs.has(jobId)) throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "job-running", detail: "the clip is being recovered after a restart; it cannot be cancelled" });
    // 5b.2 (I5.63): a batch member still waiting for its turn is cancelled alone, free; the rest of the batch goes on.
    if (state.phase === "queued") {
      for (const batch of this.#batches.values()) if (batch.cancelMember(jobId)) return;
    }
    if (state.phase !== "preparing") throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "submitted", detail: "the clip has already been sent; it cannot be cancelled" });
    this.#deps.jobs.cancel(jobId);
  }

  /** `clips.cancelBatch` (5b.2, I5.63): every member still queued is cancelled, free; a member already sent is never cancelled. The count of those cancelled. NOT_FOUND for a batch this avatar does not have. */
  cancelBatch(payload: CommandPayload<"clips.cancelBatch">): { cancelled: number } {
    const batch = this.#batches.get(payload.batchId);
    if (batch === undefined || batch.avatarId !== payload.avatarId) throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${payload.avatarId} has no batch ${payload.batchId}` });
    return { cancelled: batch.cancelQueued() };
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
    const budget = this.#deps.budget();
    return this.#suitableOptions(photo.id, facts, read.motions, priced, (worstMicros) => budget !== null && this.#deps.monthFits(budget, worstMicros));
  }

  /** The sheet of one suitable photo (`ClipOptions`): its prices from one book, and whether the month (`fits`, one yes-or-no on a worst case) takes each option. */
  #suitableOptions(photoId: string, facts: FrameFacts, motions: ReturnType<typeof motionChoicesOf>, priced: Awaited<ReturnType<ClipServiceDeps["prices"]>>, fits: (worstMicros: number) => boolean): ClipOptions {
    const fallback = clipFallbackOf(facts, this.#boldClips, this.#mode);
    const { prices, noFallbackPrices } = clipOptionPrices(priced, { mode: this.#mode, boldClips: this.#boldClips, bold: facts.bold });
    const fit = (withWorst: number, withoutWorst: number): ClipMonthFit => {
      if (fallback === "auto" && fits(withWorst)) return "with-fallback";
      return fits(withoutWorst) ? "without-fallback" : "none";
    };
    const monthFits = {
      std5: fit(prices.std5.worstMicros, noFallbackPrices.std5.worstMicros),
      pro5: fit(prices.pro5.worstMicros, noFallbackPrices.pro5.worstMicros),
      std10: fit(prices.std10.worstMicros, noFallbackPrices.std10.worstMicros),
      pro10: fit(prices.pro10.worstMicros, noFallbackPrices.pro10.worstMicros),
    };
    return { suitable: true, photoId, motions, prices, fallback, bold: facts.bold, noFallbackPrices, monthFits };
  }

  // ---------- clips.batchOptions (5b.2, S5.WB2) ----------

  /**
   * The sheet of a batch, free: each photo's own `ClipOptions` in the order asked, the four sums over the photos that can be made, the month's room and what fits. The month is read ONCE, after
   * the last await and in one synchronous step, and every `monthFits` (a photo's and the batch's) is derived from that one figure, so the answer never disagrees with itself even while a hold is taken
   * elsewhere (a concurrent hold would otherwise make an answer the contract's own refines reject).
   */
  async batchOptions(payload: CommandPayload<"clips.batchOptions">): Promise<ClipBatchOptions> {
    const library = this.#deps.currentLibrary();
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    this.#avatarOf(library, payload.avatarId);
    const reads = await this.#readItems(library, payload.avatarId, payload.photoIds);
    const priced = await this.#deps.prices(CLIP_PRICE_MODELS);
    // ----- from here, synchronous -----
    const budget = this.#deps.budget();
    const room = budget === null ? 0 : this.#deps.monthRoomMicros(budget);
    const fits = (worstMicros: number): boolean => budget !== null && worstMicros <= room;
    const items = reads.map((read, i): ClipOptions => {
      const photoId = payload.photoIds[i] ?? "";
      if (read.kind === "refused") return { suitable: false, photoId, reason: read.reason };
      return this.#suitableOptions(photoId, read.facts, read.motions, priced, fits);
    });
    const members = reads.flatMap((read) => (read.kind === "suitable" ? [{ bold: read.facts.bold }] : []));
    const book = clipPricesOf(priced);
    const anyFallback = items.some((item) => item.suitable && item.fallback === "auto");
    const sum = (quality: "std" | "pro", seconds: 5 | 10) => {
      if (members.length === 0) return { expected: 0, worst: 0, worstNoFallback: 0 };
      const parts = { quality, seconds, mode: this.#mode, boldClips: this.#boldClips, prices: book };
      return {
        expected: clipBatchExpectedMicros(members, { ...parts, fallback: "auto" }),
        worst: clipBatchWorstMicros(members, { ...parts, fallback: "auto" }),
        worstNoFallback: clipBatchWorstMicros(members, { ...parts, fallback: "none" }),
      };
    };
    const sums = { std5: sum("std", 5), pro5: sum("pro", 5), std10: sum("std", 10), pro10: sum("pro", 10) };
    const fit = (key: ClipOptionKey): ClipMonthFit => {
      if (members.length === 0) return "none";
      if (anyFallback && fits(sums[key].worst)) return "with-fallback";
      return fits(sums[key].worstNoFallback) ? "without-fallback" : "none";
    };
    const monthFits = { std5: fit("std5"), pro5: fit("pro5"), std10: fit("std10"), pro10: fit("pro10") };
    return { items, sums, monthRoomMicros: room, monthFits };
  }

  /** The avatar, active and not being deleted: NOT_FOUND otherwise. */
  #avatarOf(library: Library, avatarId: string): void {
    const avatar = library.getAvatar(avatarId);
    if (avatar === undefined || avatar.status !== "active" || this.#deps.pendingDelete(avatarId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });
  }

  /**
   * Each photo's facts and motions (or why it cannot be made), CLIP_PLAN_READ_PARALLEL at a time (L4): the deadline of the batch commands counts rounds of plan reads. A photo that is not in the
   * library, or is another avatar's, is `not-a-gallery-photo` (an item's own answer, never NOT_FOUND). The photo bytes are not kept: a member's are read again at its turn.
   */
  async #readItems(library: Library, avatarId: string, photoIds: readonly string[]): Promise<ItemRead[]> {
    const reads: ItemRead[] = new Array<ItemRead>(photoIds.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= photoIds.length) return;
        const photo = library.getPhoto(photoIds[i] ?? "");
        if (photo === undefined || photo.avatarId !== avatarId) {
          reads[i] = { kind: "refused", reason: "not-a-gallery-photo" };
          continue;
        }
        const read = await this.#facts(library, photo);
        reads[i] = read.kind === "refused" ? read : { kind: "suitable", facts: read.facts, motions: read.motions };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CLIP_PLAN_READ_PARALLEL, photoIds.length) }, worker));
    return reads;
  }

  // ---------- clips.create ----------

  /**
   * Why a new clip money unit cannot start now, or null (5b.2, I5.61). The ONE place the in-flight refusal of `clips.create` and `clips.createBatch` is decided: a single clip holding the unit is
   * `one-at-a-time`, a batch holding it is `batch-running`. Part C's `motion-busy` guard joins here.
   */
  unitRefusal(): EngineFailure | null {
    if (this.#unit === null) return null;
    if (this.#unit.kind === "batch") {
      return new EngineFailure({ code: "IN_FLIGHT", clipReason: "batch-running", detail: "a batch of clips is being made; wait for it to end or cancel the rest" });
    }
    return new EngineFailure({ code: "IN_FLIGHT", clipReason: "one-at-a-time", detail: "another clip is being made; one paid clip runs at a time" });
  }

  /** Takes the unit and the paid count, synchronously (5b.1's order: before the first await). */
  #claimUnit(kind: ClipUnit["kind"]): ClipUnit {
    const unit: ClipUnit = { kind };
    this.#unit = unit;
    this.#deps.paidStart();
    return unit;
  }

  /** The slot is the FIRST check, taken before the first await: two calls with no await between them make exactly one job. */
  async create(payload: CreatePayload): Promise<{ jobId: string }> {
    const refusal = this.unitRefusal();
    if (refusal !== null) throw refusal;
    const slot = this.#claimUnit("clip");
    let started = false;
    try {
      const answer = await this.#create(payload, slot);
      started = true;
      return answer;
    } finally {
      if (!started) this.#releaseUnit(slot);
    }
  }

  async #create(payload: CreatePayload, slot: ClipUnit): Promise<{ jobId: string }> {
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
    const cancel = deps.jobs.startClip(jobId, {
      avatarId,
      clipId,
      facts: { photoId: photo.id, request, motion: { source: motion.source, label: motion.label }, acceptedWorstMicros: payload.acceptedWorstMicros },
    });
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
      photoId: photo.id,
      bytes,
      facts,
      motion,
      request,
      acceptedWorstMicros: payload.acceptedWorstMicros,
      prices,
      capKey,
      cancel,
      unit: slot,
    });
    return { jobId };
  }

  /** Gives the unit and the paid count back, once, and only for the unit that holds it. */
  #releaseUnit(unit: ClipUnit): void {
    if (this.#unit !== unit) return;
    this.#unit = null;
    this.#deps.paidEnd();
  }

  // ---------- clips.createBatch (5b.2, S5.WB2) ----------

  /**
   * The batch «Оживить выбранные» (plan s5b2 §5.2.2, I5.61-I5.63). The unit is the FIRST check, taken before the first await like a single clip's, and it is the batch's until its last member's money
   * closes. Every refusal below is free and leaves nothing behind: no hold, no cap, no job, no unit.
   */
  async createBatch(payload: CreateBatchPayload): Promise<{ batchId: string; jobIds: string[] }> {
    const refusal = this.unitRefusal();
    if (refusal !== null) throw refusal;
    const unit = this.#claimUnit("batch");
    let started = false;
    try {
      const answer = await this.#createBatch(payload, unit);
      started = true;
      return answer;
    } finally {
      if (!started) this.#releaseUnit(unit);
    }
  }

  async #createBatch(payload: CreateBatchPayload, unit: ClipUnit): Promise<{ batchId: string; jobIds: string[] }> {
    const deps = this.#deps;
    // The key is checked here for the refusal order; each member reads it again at its turn (a rejected or changed key reaches the later members).
    deps.usableKey("bring photos to life");
    const budget = deps.paidBudget();
    const library = await deps.liveLibrary();
    const { avatarId } = payload;
    // NOT_FOUND is the avatar's alone: a photo that is missing or another avatar's is that item's own VALIDATION.
    this.#avatarOf(library, avatarId);
    await deps.assertAvatarOnDisk(library, avatarId);

    // The items in the pick order; the lowest refused item is the one told, with its own reason and its path (one `clipReason` per error).
    const reads = await this.#readItems(library, avatarId, payload.items.map((item) => item.photoId));
    const chosen: { photoId: string; facts: FrameFacts; motion: ClipMotionChoice }[] = [];
    for (const [i, item] of payload.items.entries()) {
      const read = reads[i];
      if (read === undefined || read.kind === "refused") {
        const reason = read === undefined ? "not-a-gallery-photo" : read.reason;
        throw new EngineFailure({ code: "VALIDATION", clipReason: reason, path: ["items", i], detail: `item ${i} (photo ${item.photoId}) cannot be brought to life (${reason})` });
      }
      const motion = read.motions.find((choice) => choice.id === item.motionId);
      if (motion === undefined) {
        throw new EngineFailure({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", i], detail: `item ${i}: the motion ${item.motionId} is not one this photo offers` });
      }
      chosen.push({ photoId: item.photoId, facts: read.facts, motion });
    }

    // The price book of the batch, and each member's share: its worst case under it (Kling-only for «Смелая», max(Kling, Grok) in `auto` with a fallback allowed).
    const priced = await deps.prices(CLIP_PRICE_MODELS);
    const book = clipPricesOf(priced);
    const drafts = chosen.map((member) => {
      const fallback = clipFallbackOf(member.facts, this.#boldClips, this.#mode) === "none" ? "none" : payload.fallback;
      const request: ClipRequest = { model: "kling", quality: payload.quality, seconds: payload.seconds, fallback };
      const share = clipWorstMicros({ ...request, mode: this.#mode, bold: member.facts.bold, boldClips: this.#boldClips, prices: book });
      const jobId = deps.newId();
      return { ...member, request, share, jobId, clipId: jobId, capKey: scopeKey({ avatarJobId: jobId }) };
    });
    const total = clipBatchWorstMicros(
      chosen.map((member) => ({ bold: member.facts.bold })),
      { quality: payload.quality, seconds: payload.seconds, mode: this.#mode, fallback: payload.fallback, boldClips: this.#boldClips, prices: book },
    );
    if (drafts.reduce((sum, d) => sum + d.share, 0) !== total) throw new EngineFailure({ code: "INTERNAL", detail: "the members' shares do not add up to the batch's worst case" });
    deps.checkAccepted(total, payload.acceptedWorstMicros);

    // Each member's cap is its share, and the month is held for every member at once (all or nothing): a refusal leaves nothing held and nothing capped.
    for (const d of drafts) deps.setCap(d.capKey, d.share);
    const batchId = deps.newId();
    /** Set only when the batch is running: until then a failure takes everything back, the registered jobs included. */
    let started = false;
    const registered: { jobId: string; clipId: string }[] = [];
    let workTaken = false;
    try {
      const hold = await budget.tryHold(drafts.map((d) => ({ attemptId: clipAttemptId(d.clipId, 1), scope: { avatarJobId: d.clipId }, worstMicros: d.share })));
      if (!hold.ok) throw new EngineFailure(holdRefusalOf(hold));
      // After the last await, with none before the jobs are registered: a delete prepared meanwhile (the avatar detached), or a library switched away, wins.
      if (deps.pendingDelete(avatarId) || library.getAvatar(avatarId) === undefined || deps.currentLibrary() !== library) {
        throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is no longer in the open library` });
      }
      const size = drafts.length;
      const members: BatchMember[] = drafts.map((d, i) => ({
        index: i + 1,
        photoId: d.photoId,
        motion: d.motion,
        request: d.request,
        facts: d.facts,
        share: d.share,
        jobId: d.jobId,
        clipId: d.clipId,
        capKey: d.capKey,
        signal: (() => {
          const signal = deps.jobs.startClip(
            d.jobId,
            {
              avatarId,
              clipId: d.clipId,
              facts: { photoId: d.photoId, request: d.request, motion: { source: d.motion.source, label: d.motion.label }, acceptedWorstMicros: d.share },
              batch: { batchId, batchIndex: i + 1, batchSize: size, waitReason: "turn" },
            },
            "queued",
          );
          registered.push({ jobId: d.jobId, clipId: d.clipId });
          return signal;
        })(),
        wake: new AbortController(),
        held: true,
        retried: false,
        state: "queued",
      }));
      for (const member of members) {
        const progress = deps.jobs.progress(member.jobId, 0);
        if (progress !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: progress });
      }
      // The batch's own work count: a library switch waits while any member is queued or running, and gives way when the batch is over.
      this.#work++;
      workTaken = true;
      const batch = new ClipBatch(this.#batchPorts({ budget, library, avatarId, batchId, size, unit }), { id: batchId, avatarId, members });
      this.#remember(batch);
      batch.start();
      started = true;
      return { batchId, jobIds: members.map((member) => member.jobId) };
    } finally {
      if (!started) {
        // A start that failed leaves nothing: the jobs it registered end cancelled (no zombie `queued` job to pin the sleep blocker, the quit question or an avatar delete), the holds and caps go back.
        for (const { jobId, clipId } of registered) {
          const state = deps.jobs.finishClip(jobId, { status: "cancelled" });
          if (state !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.cancelled", payload: { kind: "clip", jobId, avatarId, clipId } });
        }
        if (workTaken) this.#work--;
        for (const d of drafts) {
          budget.releaseHold(clipAttemptId(d.clipId, 1));
          deps.clearCap(d.capKey);
        }
        deps.emitMoney();
      }
    }
  }

  /** The batches kept: the running ones, and the last few that ended. */
  #remember(batch: ClipBatch): void {
    this.#batches.set(batch.id, batch);
    const finished = [...this.#batches.values()].filter((candidate) => candidate.over);
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_BATCHES))) this.#batches.delete(old.id);
  }

  /** What a batch needs of the service: the engine's seams, the hold registry, and the clip job of one member. */
  #batchPorts(ctx: { budget: Budget; library: Library; avatarId: string; batchId: string; size: number; unit: ClipUnit }): BatchPorts {
    const deps = this.#deps;
    return {
      clock: deps.clock,
      readKey: () => deps.usableKey("bring photos to life"),
      newId: deps.newId,
      timings: deps.timings,
      jobs: deps.jobs,
      emit: deps.emit,
      emitMoney: deps.emitMoney,
      setCap: deps.setCap,
      clearCap: deps.clearCap,
      log: deps.log,
      budget: ctx.budget,
      holds: this.holds,
      mode: this.#mode,
      boldClips: this.#boldClips,
      stop: this.#stop.signal,
      readPrices: async () => clipPricesOf(await deps.prices(CLIP_PRICE_MODELS)),
      recheck: (member) => this.#recheck(ctx.library, ctx.avatarId, member.photoId),
      runMember: (run) => this.#startMember(run, ctx),
      finished: () => {
        this.#work--;
        this.#releaseUnit(ctx.unit);
        deps.emitMoney();
      },
      sleep: abortableSleep,
    };
  }

  /** A member's turn has come: 5b.1's clip job, verbatim, under the member's own scope and cap. The batch hears of its money through `run.onMoneyClosed`. */
  #startMember(run: MemberRun, ctx: { budget: Budget; library: Library; avatarId: string; batchId: string; size: number }): void {
    const { member } = run;
    this.#work++;
    this.#activeClips.add(member.clipId);
    void this.#runJob({
      key: run.key,
      budget: ctx.budget,
      library: ctx.library,
      jobId: member.jobId,
      clipId: member.clipId,
      avatarId: ctx.avatarId,
      photoId: member.photoId,
      bytes: run.bytes,
      facts: member.facts,
      motion: member.motion,
      request: member.request,
      acceptedWorstMicros: member.share,
      prices: run.prices,
      capKey: member.capKey,
      cancel: member.signal,
      unit: null,
      member: { ref: { batchId: ctx.batchId, batchIndex: member.index, batchSize: ctx.size }, onMoneyClosed: run.onMoneyClosed },
    });
  }

  /** A member's photo at its turn: still in the gallery of its avatar, and its file still readable and usable as a first frame. */
  async #recheck(library: Library, avatarId: string, photoId: string): Promise<PhotoRecheck> {
    const deps = this.#deps;
    const present = (): boolean => deps.currentLibrary() === library && !deps.pendingDelete(avatarId) && library.getAvatar(avatarId) !== undefined && library.getPhoto(photoId)?.avatarId === avatarId;
    if (!present()) return { kind: "gone" };
    let bytes: Uint8Array;
    try {
      bytes = await library.readPhotoVerified(photoId);
    } catch (error) {
      if (!present()) return { kind: "gone" };
      deps.log(`[clip] photo ${photoId} could not be read at its batch turn (${error instanceof Error ? error.name : typeof error})`);
      return { kind: "unreadable" };
    }
    if (!present()) return { kind: "gone" };
    return firstFrameRefusalOf(bytes) === null ? { kind: "ok", bytes } : { kind: "unreadable" };
  }

  // ---------- the job ----------

  async #runJob(job: {
    key: string;
    budget: Budget;
    library: Library;
    jobId: string;
    clipId: string;
    avatarId: string;
    photoId: string;
    bytes: Uint8Array;
    facts: FrameFacts;
    motion: ClipMotionChoice;
    request: ClipRequest;
    acceptedWorstMicros: number;
    prices: ReturnType<typeof clipPricesOf>;
    capKey: string;
    cancel: AbortSignal;
    /** A single clip's unit token: only this clip gives the unit back, when its money closes. A batch member holds none: the batch gives the unit back when its last member's money closes. */
    unit: ClipUnit | null;
    /** 5b.2: the batch this clip is a member of, and what to tell it when the money closed. */
    member?: { ref: ClipBatchRef; onMoneyClosed: (end?: ClipMoneyEnd) => void };
  }): Promise<void> {
    const deps = this.#deps;
    const signal = eitherSignal(job.cancel, this.#stop.signal);
    const ref = { kind: "clip" as const, jobId: job.jobId, avatarId: job.avatarId, clipId: job.clipId };
    let moneyClosed = false;
    /** Every reserve of the clip is settled or abandoned (or none was made): the unit (a single clip's), the paid count and the cap go, once; a batch member then tells its batch how it ended. */
    const closeMoney = (end?: ClipMoneyEnd): void => {
      if (moneyClosed) return;
      moneyClosed = true;
      if (job.unit !== null) this.#releaseUnit(job.unit);
      deps.clearCap(job.capKey);
      deps.emitMoney();
      // A batch member whose POST was refused for its key: later members must see the key as rejected at their turn, before this job's own end is announced.
      if (job.member !== undefined && end?.kind === "failed" && end.reason === "key-invalid") deps.markKeyRejected(job.key);
      try {
        job.member?.onMoneyClosed(end);
      } catch (error) {
        deps.log(`[clip] ${job.clipId}: the batch could not take the end of its member's money (${error instanceof Error ? error.name : typeof error})`);
      }
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
          const progress = deps.jobs.clipPhase(job.jobId, { ...update, openReserveMicros: openClipReserveMicros(job.budget.ledger, job.clipId) });
          if (progress !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: progress });
        },
        onMoneyClosed: (end) => closeMoney(end),
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
          photoId: job.photoId,
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
          ...(job.member === undefined ? {} : { batch: job.member.ref }),
        },
        signal,
      );
      end = this.#endOf(outcome, job.key, job.member !== undefined);
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
      else if (end.status === "cancelled") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.cancelled", payload: end.detail === undefined ? ref : { ...ref, detail: end.detail } });
    } catch (error) {
      deps.log(`[clip] the end of job ${job.jobId} could not be announced (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  #endOf(outcome: ClipJobOutcome, key: string, member = false): ClipJobEnd {
    switch (outcome.kind) {
      case "recorded":
        if (outcome.record.outcome.status === "failed" && outcome.record.outcome.reason === "key-invalid") this.#deps.markKeyRejected(key);
        return { status: "done" };
      case "refused":
        return { status: "failed", error: outcome.error };
      case "cancelled":
        // A batch member the owner cancelled before its POST says so; a stop of the engine (`interrupted`) is no one's cancel.
        return member ? { status: "cancelled", detail: "cancelled" } : { status: "cancelled" };
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
