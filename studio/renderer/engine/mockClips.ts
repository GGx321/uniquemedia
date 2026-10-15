import {
  BOLD_CLIPS,
  CLIP_FILE_DAMAGED_DETAIL,
  CLIP_JOB_STEPS,
  CLIP_RETRYABLE_FAILURES,
  EXPORT_FPS,
  GROK_FALLBACK,
  isBoldCategory,
  MAX_LISTED_BATCHES,
  MAX_LISTED_CLIPS,
  PROTOCOL_VERSION,
  CLIP_OPTION_KEYS,
  clipAllowsAutoGrok,
  clipBatchExpectedMicros,
  clipBatchWorstMicros,
  clipBilledMicros,
  clipExpectedMicros,
  clipReserveMicros,
  clipWorstMicros,
  type BoldClipsMode,
  type ClipBatchOptions,
  type ClipBatchSummary,
  type ClipCancelDetail,
  type ClipCost,
  type ClipExport,
  type ClipExportLine,
  type ClipExportProfile,
  type ClipFace,
  type ClipFailReason,
  type ClipModelUsed,
  type ClipMonthFit,
  type ClipMotion,
  type ClipMotionChoice,
  type ClipMotionSource,
  type ClipOptionKey,
  type ClipOptions,
  type ClipPhase,
  type ClipPriceParts,
  type ClipPrices,
  type ClipQuality,
  type ClipRequest,
  type ClipSeconds,
  type ClipSummary,
  type ClipUse,
  type CommandPayload,
  type EngineError,
  type Estimate,
  type ExportUnavailableReason,
  type FileState,
  type JobProgress,
  type JobState,
  type PhotoSummary,
  type ReconcileResult,
} from "../../shared/engine";
import { clipAlone } from "../../shared/engine/clipAlone";
import {
  afterRestart,
  applyBatchChange,
  batchSummaryOf,
  clipBatchOutcomeOf,
  moneyOpen,
  newestFirst,
  runningClipIds,
  startBatchState,
  toForget,
  withCosts,
  type BatchChange,
  type ClipBatchState,
  type MemberLook,
} from "../../shared/engine/clipBatchSummary";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { MockClipBatch, type BatchMember, type MockBatchPorts, type MockMoneyEnd } from "./mockClipBatch";
import type { Scheduler } from "./scheduler";

// Stage 5, 5b.1, S5.V7 (plan s5b1 §5.15): the clips of the mock engine. It answers what the ENGINE answers (engine/clips/*), number for number and state for state, so the «Клипы» tab can be built and
// demoed without the engine and the parity suite can tell the two apart. The mock cannot import `engine/` (the renderer bundle must not), so what the engine decides with is written out here and
// HELD to the engine by tests that can import both: the timings (mockEngine.clips.holds.test.ts), the motions and the recovery table (mockEngine.clips.test.ts, .restart.test.ts), and the parity stories.
//
// It plays a photo with NO run plan (the photo's own face marks decide: engine/clips/frameFacts.ts, `planlessFacts`), which is what the parity rig seeds. Time is the mock's scheduler and its clock;
// the real timings are the default and the rig passes the short set, as the engine's rig does.

// ---------- timings ----------

/** The engine's `ClipTimings` (engine/clips/timings.ts), less the proof retry pause, which the mock has no use for. */
export interface MockClipTimings {
  readonly pollMs: number;
  readonly proofFirstReadMs: number;
  readonly proofSecondReadMs: number;
  /** The pause before a free read that came back unreadable (or a record not there yet, for a completed job) is tried again. */
  readonly proofRetryMs: number;
  readonly lifetimeMs: number;
  readonly latePollMs: number;
  readonly lateGiveUpMs: number;
  readonly holdUncertainMs: number;
  readonly holdTerminalMs: number;
  readonly holdSubmittedMs: number;
  readonly exportProgressMs: number;
  /** 5b.2 (I5.62): a batch member waits at most this long for the money to be alone before its POST; past it, it submits and a refusal is then `net-uncounted` (worst). */
  readonly aloneWaitMs: number;
  /** 5b.2 (I5.62): after a 429 at a member's submit, no batch member is submitted for this long. */
  readonly rateLimitPauseMs: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const REAL: MockClipTimings = Object.freeze({
  pollMs: 20 * SECOND,
  proofFirstReadMs: 15 * SECOND,
  proofSecondReadMs: 2 * MINUTE,
  proofRetryMs: 5 * SECOND,
  lifetimeMs: 20 * MINUTE,
  latePollMs: 60 * SECOND,
  lateGiveUpMs: 60 * MINUTE,
  holdUncertainMs: 20 * MINUTE,
  holdTerminalMs: 2 * MINUTE,
  holdSubmittedMs: 60 * MINUTE,
  exportProgressMs: 2 * SECOND,
  aloneWaitMs: 2 * MINUTE + 10 * SECOND,
  rateLimitPauseMs: 60 * SECOND,
});

const scaled = (set: MockClipTimings, by: number): MockClipTimings =>
  Object.freeze({
    pollMs: set.pollMs / by,
    proofFirstReadMs: set.proofFirstReadMs / by,
    proofSecondReadMs: set.proofSecondReadMs / by,
    proofRetryMs: set.proofRetryMs / by,
    lifetimeMs: set.lifetimeMs / by,
    latePollMs: set.latePollMs / by,
    lateGiveUpMs: set.lateGiveUpMs / by,
    holdUncertainMs: set.holdUncertainMs / by,
    holdTerminalMs: set.holdTerminalMs / by,
    holdSubmittedMs: set.holdSubmittedMs / by,
    exportProgressMs: set.exportProgressMs / by,
    aloneWaitMs: set.aloneWaitMs / by,
    rateLimitPauseMs: set.rateLimitPauseMs / by,
  });

/** `real`: the engine's. `short`: the real one divided by a thousand, every ordering kept (the parity rig and the packaged smoke). `demo`: the dev build, where a minute of waiting is too long to look at. */
export const MOCK_CLIP_TIMINGS = Object.freeze({ real: REAL, short: scaled(REAL, 1_000), demo: scaled(REAL, 20) });
export type MockClipTimingsName = keyof typeof MOCK_CLIP_TIMINGS;

/** A free read that is not there yet (or not readable) is tried this many times before the money path settles without it (engine/clips/timings.ts `PROOF_READ_TRIES`; held to it by mockEngine.clips.holds.test.ts). */
export const MOCK_PROOF_READ_TRIES = 3;
const PROOF_READ_TRIES = MOCK_PROOF_READ_TRIES;

/** The budget's own quiet rule and request timeout (engine/money/reconcile.ts, budget.ts): a restart's reserve waits for both. */
const RECONCILE_QUIET_MS = 2 * MINUTE;
const REQUEST_TIMEOUT_MS = 3 * MINUTE;

// ---------- prices (the 2026-10-10 listing, plan §5.9) ----------

const RATES: ClipPrices = Object.freeze({
  std: { perSecondMicros: 84_000, perInputImageMicros: 0 },
  pro: { perSecondMicros: 112_000, perInputImageMicros: 0 },
  grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 },
});

const FALLBACK_DATE = "2026-10-10";

/** How the mock's video listing reads: `live` (the default), unreadable so the dated table stands in (`fallback`), or readable and lacking a price (`missing`: PRICE_UNAVAILABLE `video`). */
export type MockVideoPrices = "live" | "fallback" | "missing";

// ---------- scripted outcomes ----------

/**
 * What one attempt (Kling, or Grok behind it) does. The names follow the engine's settle table (plan §5.7):
 * - `ok`: completed with `usage.cost`. `ok-uncosted`: completed with no usage and no `/generation` record (or one that reads 0 on all three reads, or a poll whose `usage.cost` is 0 and whose `/generation` reads 0: a completed job's 0 is «not yet», VR item 7), settled at the worst.
 * - `refused-submit`: a moderation 4xx at the POST (free, no job). `refused-free`: a content failure at the poll, proven free. `refused-paid`: `/generation` bills it. `refused-unknown`: the net-usage
 *   check rose. `refused-uncounted`: the check could not count (the STRICT proof: not free).
 * - `provider-error` / `-paid` / `-unknown`: a failure that is not a content refusal, through the same proof.
 * - `rate-limited`, `bad-request`, `key-invalid`, `no-credits`: a refusal at the POST that is not a moderation one. `uncertain`: a 5xx or a timeout at the POST.
 * - `late`: no terminal status for the lifetime and never one. `late-ok`: one that comes in after the lifetime.
 * - `download-failed`, `invalid-file`, `disk-full`: completed and billed, the file not stored.
 * - `no-room` (Grok only): the month has no room for Grok's reserve.
 * - `ok-above-worst` (5b.2, S5.WB3): completed, and billed above the reserve: the ledger halts (`SETTLE_ABOVE_WORST`), the clip is delivered. `fault` (5b.2): the money state machine throws after the reserve, so whether
 *   anything is open is not known: the job fails INTERNAL and the reserve stays open. Neither can be played by the real rig's provider (the engine's tests hold them); the mock plays them for the batch's stops.
 */
export type MockClipAttempt =
  | "ok"
  | "ok-uncosted"
  | "refused-submit"
  | "refused-free"
  | "refused-paid"
  | "refused-unknown"
  | "refused-uncounted"
  | "provider-error"
  | "provider-error-paid"
  | "provider-error-unknown"
  | "rate-limited"
  | "bad-request"
  | "key-invalid"
  | "no-credits"
  | "uncertain"
  | "late"
  | "late-ok"
  | "download-failed"
  | "invalid-file"
  | "disk-full"
  | "no-room"
  | "ok-above-worst"
  | "fault";

export type MockClipFace = "match" | "mismatch" | "few-faces" | "worker";

/** The next `clips.create`: the first attempt, the Grok attempt behind a free refusal (default `ok`), and the face check's verdict (default a match). */
export type MockClipScript = MockClipAttempt | { first?: MockClipAttempt; then?: MockClipAttempt; face?: MockClipFace };

export type MockRetryResult = "ok" | "failed" | "gone";
/** `fail`: the encode fails halfway. `damaged`: the library's own file is not usable — the engine's `#damaged` stop, before the encode: no frame, INTERNAL with `CLIP_FILE_DAMAGED_DETAIL`. */
export type MockExportResult = "ok" | "fail" | "damaged";

// ---------- the journal, as the engine writes it ----------

/** The lines of a clip's journal (engine/clips/schemas.ts): the same shapes, so the engine's own recovery plan can read the mock's. */
export type MockJournalLine =
  | { type: "requested"; clipId: string; photoId: string; request: ClipRequest; motion: ClipMotion; acceptedWorstMicros: number; batch?: BatchRef; at: string }
  | { type: "submitted"; attemptId: string; model: "kling" | "grok"; providerJobId: string; at: string }
  | {
      type: "ended";
      attemptId: string;
      status: "completed" | "failed" | "cancelled" | "expired" | "refused" | "uncertain" | "late";
      providerCostMicros?: number;
      costSource: "usage" | "generation" | "proof" | "worst" | "none";
      /** A POST the provider refused with a 4xx that is not moderation: why, so a restart records the reason the live path did (engine/clips/schemas.ts `failReason`). */
      failReason?: "rate-limited" | "key-invalid" | "no-credits" | "bad-request";
      at: string;
    }
  | { type: "downloaded"; sha256: string; bytes: number; at: string };

type AttemptModel = "kling" | "grok";

/** A batch member's place (engine/jobs.ts `ClipBatchRef`): the three fields come all or none. */
interface BatchRef {
  batchId: string;
  /** 1-based, the pick order. */
  batchIndex: number;
  batchSize: number;
}

interface RecordAttempt {
  attemptId: string;
  model: AttemptModel;
  providerJobId?: string;
  outcome: "completed" | "failed" | "cancelled" | "expired" | "refused" | "uncertain" | "late";
  providerCostMicros?: number;
  costSource: "usage" | "generation" | "proof" | "worst" | "none";
}

type ClipOutcome =
  | { status: "ready"; width: number; height: number; durationMs: number; face: ClipFace }
  | { status: "failed"; reason: ClipFailReason; retryDownloadUntil?: string };

/** A committed record (engine/clips/schemas.ts `ClipRecord`), less the disk. */
interface MockClipRecord {
  id: string;
  avatarId: string;
  photoId: string;
  createdAt: string;
  seen: boolean;
  motion: ClipMotion;
  request: ClipRequest;
  model: ClipModelUsed;
  attempts: RecordAttempt[];
  recovered: boolean;
  exports: ClipExportLine[];
  outcome: ClipOutcome;
  /** 5b.2: the batch the clip was made in (the record's `batchId`, `batchIndex`, `batchSize`). */
  batch?: BatchRef;
}

/** One reserve of the clip's ledger lines (`<clipId>:video#<n>`), open until it is settled. */
interface Line {
  attemptId: string;
  clipId: string;
  model: AttemptModel;
  worstMicros: number;
  reserveAtMs: number;
  state: "open" | "settled";
  costMicros: number;
  estimated: boolean;
  /** Reserved by this process (a restart makes every open line foreign). */
  own: boolean;
  /** From the reserve until the line settles or is abandoned (a late or uncertain attempt): the budget's `isInFlight`, which the engine leaves out of the reconcile reasons. */
  inFlight: boolean;
}

/** What a create job's tile shows (S5.V8b): from the request for a fresh job, from the journal's `requested` line for a recovered one. The same four fields the engine's job carries. */
interface JobFacts {
  photoId: string;
  request: ClipRequest;
  motion: { source: ClipMotionSource; label: string };
  acceptedWorstMicros: number;
}

interface Job {
  jobId: string;
  avatarId: string;
  clipId: string;
  kind: "create" | "retry" | "recovery" | "export";
  status: "running" | "done" | "failed" | "cancelled";
  phase: ClipPhase;
  model?: AttemptModel;
  submittedAt?: string;
  proveUntil?: string;
  /** A create or recovery job of a clip that is still being made; an export or a retried download has none. */
  facts?: JobFacts;
  /** What the mock's ledger can still charge for the clip, as of the job's last phase; absent when no reserve is open (the engine's `openClipReserveMicros`). */
  openReserveMicros?: number;
  done: number;
  total: number;
  result?: { kind: "clip"; avatarId: string; clipId: string; exported?: { relPath: string } };
  error?: EngineError;
  timers: (() => void)[];
  /** A create job: its slot token, and whether its money closed. */
  moneyClosed: boolean;
  /** An export waiting for its turn. */
  queued: boolean;
  /** An export past the point of no return: the name it claimed. A cancel from then on changes nothing (engine/clips/export.ts, «done wins»). */
  claimed: string | null;
  /** 5b.2: the batch this job is a member of, and what a `queued` or `proving` member waits for. */
  batch?: BatchRef;
  waitReason?: WaitReason;
  /** 5b.2: why a batch member that never ran was cancelled (`job.cancelled`'s `detail`). */
  detail?: ClipCancelDetail;
  /** 5b.2: the batch this job is a member of and the member it stands for: the batch is told how its money ended. */
  member?: { batch: MockClipBatch<MemberPayload>; ref: BatchMember<MemberPayload> };
  /** 5b.2 (S5.WB2c): a member job whose turn came (engine `#startMember`): its own end is told to the batch's summary. */
  ran?: true;
}

type WaitReason = "turn" | "alone" | "rate-limit" | "proof";

/** A price book as the engine's cache keeps it: the rates, when they were read, and where they came from (`live` listing, or the dated table) and the day. */
interface PriceBook {
  rates: ClipPrices;
  readAtMs: number;
  source: "live" | "fallback";
  asOf: string;
}

/** What a batch member needs to run its clip when its turn comes (the batch itself needs none of it). */
interface MemberPayload {
  request: ClipRequest;
  motion: ClipMotion;
  facts: Facts;
}

/** The facts a job's events and state carry, or nothing: the fields are all there or none is. */
function jobFactsOf(job: Job): Partial<JobFacts> & { openReserveMicros?: number } {
  if (job.facts === undefined) return {};
  return {
    photoId: job.facts.photoId,
    request: job.facts.request,
    motion: job.facts.motion,
    acceptedWorstMicros: job.facts.acceptedWorstMicros,
    ...(job.openReserveMicros === undefined ? {} : { openReserveMicros: job.openReserveMicros }),
  };
}

/** 5b.2: a batch member's place in the batch, in every event and state of its job (all three or none), and what it waits for while it is `queued` or `proving` (the contract allows no other phase one). */
function jobBatchOf(job: Job): { batchId?: string; batchIndex?: number; batchSize?: number; waitReason?: WaitReason } {
  if (job.batch === undefined) return {};
  const waits = job.waitReason !== undefined && (job.phase === "queued" || job.phase === "proving");
  return { batchId: job.batch.batchId, batchIndex: job.batch.batchIndex, batchSize: job.batch.batchSize, ...(waits ? { waitReason: job.waitReason } : {}) };
}

type Out<T> = { ok: true; result: T } | { ok: false; error: EngineError };
const good = <T>(result: T): Out<T> => ({ ok: true, result });
const bad = (error: EngineError): Out<never> => ({ ok: false, error });

/** What the mock engine hands the clips: its clock, its ledger of reserves, its library and its export folder. */
export interface MockClipsHost {
  scheduler: Scheduler;
  stepMs: number;
  nextId(prefix: string): string;
  /** The mock's clock, advanced by a second (`nowIso`). */
  nowIso(): string;
  clockMs(): number;
  setClockAtLeast(ms: number): void;
  emit(event: UnsequencedEvent): void;
  emitMoney(): void;
  /** The key and ledger gate of a paid command (`keyAndLedgerGate`). */
  gate(): EngineError | null;
  /** What the budget refuses a clip attempt's reserve with while the ledger is halted or needs a reconcile (`Budget.blocked`), or null: the attempts meet it mid-job, after the create's own gate passed. */
  reserveRefusal(): EngineError | null;
  /** `usableKey` (engine/clips/records.ts): the key alone, for a free call that still goes to the provider. */
  keyGate(): EngineError | null;
  markKeyRejected(): void;
  /** 5b.2: a settle came in above its reserve: the ledger halts (`SETTLE_ABOVE_WORST`) until the owner reconciles. */
  haltLedger(): void;
  /** 5b.2: the ledger can be read (`Budget` exists); when it cannot, a batch's sheet has no room and nothing fits. */
  ledgerReadable(): boolean;
  /** The mock's open reserves, attempt id to worst: the clips add theirs and take them back. */
  reserves: Map<string, number>;
  spend(micros: number): void;
  spentMicros(): number;
  monthlyBudgetMicros(): number;
  pricesAsOf(): string;
  avatar(avatarId: string): { name: string; active: boolean; masterPhotoId: string } | undefined;
  deletePending(avatarId: string): boolean;
  photo(avatarId: string, photoId: string): PhotoSummary | undefined;
  /** The export folder, checked as a render's save checks it; the reason it cannot take `requiredBytes`, or null. */
  checkExport(requiredBytes?: number): ExportUnavailableReason | null;
  exportOk(): boolean;
  exportRootId(): string;
  exportFiles(): Set<string>;
  exportRelPath(avatarName: string, avatarId: string, date: string, named: Iterable<string>): string;
  /**
   * 5b.2 (S5.WA3, I5.59, Q-F = 1): what the clips need of the montage copies. `removeCopies` is the clip delete's first step (the engine's `ClipCopies.removeOfClip`): every copy of the clip is removed, or a
   * render that holds one refuses (`in-use`) with nothing removed. `use` is `ClipSummary.use` of a ready clip: a finished video's use of its frame, and the saved drafts that hold its copy.
   */
  removeCopies(avatarId: string, clipId: string): "none" | "removed" | "in-use";
  use(avatarId: string, clipId: string, photoId: string): ClipUse | undefined;
}

export interface MockClipsOptions {
  mode?: "auto" | "offer";
  boldClips?: BoldClipsMode;
  exportFps?: "interpolate" | "duplicate" | "native24";
  timings?: MockClipTimingsName;
}

// ---------- what a planless photo offers ----------

/** engine/clips/motion.ts, `CODE_MOTIONS`, for a capture that is not known and a face that shows: the sheet's three. Held to the engine's table by mockEngine.clips.test.ts. */
export const MOCK_CLIP_MOTIONS: readonly ClipMotionChoice[] = Object.freeze([
  { id: "g-blink", source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
  { id: "g-tilt", source: "code", label: "Наклоняет голову", text: "she tilts her head a little to one side and smiles" },
  { id: "g-breath", source: "code", label: "Медленный вдох", text: "she slowly takes a breath and relaxes her shoulders" },
]);

/** engine/avatars/ageCheck.ts: a verdict that is not adult at this confidence is not enough. */
const AGE_MIN_CONFIDENCE = 0.75;

const fakeSha = (seed: string): string => {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i) ^ round, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
};

const iso = (ms: number): string => new Date(ms).toISOString();
const attemptIdOf = (clipId: string, n: 1 | 2): string => `${clipId}:video#${n}`;
const modelUsed = (model: AttemptModel, request: ClipRequest): ClipModelUsed => (model === "grok" ? "grok" : request.quality === "pro" ? "kling-pro" : "kling-std");

/** The file a clip request comes back as: Kling pro is 1080 x 1920, everything else 720 x 1280 (a Grok clip is 720p whatever was asked). */
function sizeOf(model: AttemptModel, quality: ClipQuality): { width: number; height: number } {
  return model === "kling" && quality === "pro" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}

/** What the facts of a planless photo make of it. */
interface Facts {
  bold: boolean;
  judged: boolean;
  ageRefused: boolean;
}

function factsOf(photo: PhotoSummary): Facts {
  const age = photo.qa?.age;
  return {
    bold: isBoldCategory(photo.category),
    judged: photo.qa?.faceCos !== undefined && photo.qa.faceMarked !== true,
    ageRefused: !(age === undefined || (age.adult === true && age.confidence >= AGE_MIN_CONFIDENCE)),
  };
}

type Refusal = "not-a-gallery-photo" | "age-unverified" | "photo-unreadable" | "not-vertical" | "bold-off" | "no-motion";

/** A photo as the clip rules read it: why it cannot be brought to life, or its facts and the motions it offers. */
type ItemRead = { kind: "refused"; reason: Refusal } | { kind: "suitable"; facts: Facts; motions: readonly ClipMotionChoice[] };

interface Script {
  first: MockClipAttempt;
  then: MockClipAttempt;
  face: MockClipFace | undefined;
}

// ---------- the recovery plan (engine/clips/recover.ts, `planRecovery`) ----------

type Plan =
  | { kind: "stale-journal" }
  | { kind: "fail"; reason: ClipFailReason; model: AttemptModel }
  | { kind: "poll"; attemptId: string; model: AttemptModel; providerJobId: string; submittedAtMs: number }
  | { kind: "download"; attemptId: string; model: AttemptModel; providerJobId: string; submittedAtMs: number; local: boolean };

interface JournalAttempt {
  attemptId: string;
  model?: AttemptModel;
  providerJobId?: string;
  submittedAt?: string;
  ended?: Extract<MockJournalLine, { type: "ended" }>;
}

function summarize(lines: readonly MockJournalLine[]) {
  const attempts: JournalAttempt[] = [];
  let requested: Extract<MockJournalLine, { type: "requested" }> | null = null;
  let downloaded = false;
  const of = (attemptId: string): JournalAttempt => {
    let found = attempts.find((a) => a.attemptId === attemptId);
    if (found === undefined) {
      found = { attemptId };
      attempts.push(found);
    }
    return found;
  };
  for (const line of lines) {
    if (line.type === "requested") requested ??= line;
    else if (line.type === "submitted") Object.assign(of(line.attemptId), { model: line.model, providerJobId: line.providerJobId, submittedAt: line.at });
    else if (line.type === "ended") of(line.attemptId).ended = line;
    else downloaded = true;
  }
  return { requested, attempts, downloaded };
}

function reasonOfEnded(ended: Extract<MockJournalLine, { type: "ended" }>): ClipFailReason {
  switch (ended.status) {
    case "refused":
      if (ended.costSource === "proof") return "refused-free";
      return ended.costSource === "generation" || ended.costSource === "usage" ? "refused-paid" : "refused-unknown";
    case "late":
      return "late";
    case "uncertain":
      return "submit-uncertain";
    default:
      return "provider-error";
  }
}

/** engine/clips/recover.ts `reasonOfAttempt`: an `ended` line with no `submitted` line is a POST the provider refused (settled 0), never `lost` and never «settled at worst». */
function reasonOfAttempt(attempt: JournalAttempt, ended: Extract<MockJournalLine, { type: "ended" }>): ClipFailReason {
  if (attempt.submittedAt !== undefined) return reasonOfEnded(ended);
  if (ended.status === "refused") return "refused-free";
  if (ended.status === "failed") return ended.failReason ?? "bad-request";
  return reasonOfEnded(ended);
}

function planOf(lines: readonly MockJournalLine[], reserved: ReadonlySet<string>, nowMs: number, t: MockClipTimings): Plan {
  const { requested, attempts, downloaded } = summarize(lines);
  if (requested === null) return { kind: "fail", reason: "lost", model: "kling" };
  const modelOf = (a: { attemptId: string; model?: AttemptModel }): AttemptModel => a.model ?? (a.attemptId.endsWith("#2") ? "grok" : requested.request.model);
  const completed = attempts.find((a) => a.ended?.status === "completed" && a.providerJobId !== undefined && a.submittedAt !== undefined);
  if (completed?.providerJobId !== undefined && completed.submittedAt !== undefined) {
    const submittedAtMs = Date.parse(completed.submittedAt);
    if (!downloaded && nowMs >= submittedAtMs + t.lateGiveUpMs) return { kind: "fail", reason: "download-expired", model: modelOf(completed) };
    return { kind: "download", attemptId: completed.attemptId, model: modelOf(completed), providerJobId: completed.providerJobId, submittedAtMs, local: downloaded };
  }
  const out = attempts.findLast((a) => a.submittedAt !== undefined && a.providerJobId !== undefined && a.ended === undefined);
  if (out?.providerJobId !== undefined && out.submittedAt !== undefined) {
    const submittedAtMs = Date.parse(out.submittedAt);
    if (nowMs >= submittedAtMs + t.lateGiveUpMs) return { kind: "fail", reason: "late", model: modelOf(out) };
    return { kind: "poll", attemptId: out.attemptId, model: modelOf(out), providerJobId: out.providerJobId, submittedAtMs };
  }
  const submittedIds = new Set(attempts.filter((a) => a.submittedAt !== undefined).map((a) => a.attemptId));
  const unsent = [...reserved].filter((id) => !submittedIds.has(id)).sort();
  const lastUnsent = unsent.at(-1);
  if (lastUnsent !== undefined) {
    const unsentAttempt = attempts.find((a) => a.attemptId === lastUnsent);
    if (unsentAttempt?.ended === undefined) return { kind: "fail", reason: "lost", model: modelOf({ attemptId: lastUnsent }) };
    return { kind: "fail", reason: reasonOfAttempt(unsentAttempt, unsentAttempt.ended), model: modelOf(unsentAttempt) };
  }
  const last = attempts.findLast((a) => a.ended !== undefined);
  if (last?.ended !== undefined) return { kind: "fail", reason: reasonOfAttempt(last, last.ended), model: modelOf(last) };
  return { kind: "fail", reason: "lost", model: requested.request.model };
}

/** The mock's recovery plan for a journal, as the engine would plan it: exposed so a test can ask the engine's `planRecovery` about the same lines. */
export { planOf as mockRecoveryPlan };

// ---------- the clips ----------

export class MockClips {
  readonly #host: MockClipsHost;
  readonly #t: MockClipTimings;
  #rates: ClipPrices = RATES;
  /** The list each clip was created by (the provider bills a recovered job by it). */
  readonly #clipRates = new Map<string, ClipPrices>();
  readonly #mode: "auto" | "offer";
  readonly #boldClips: BoldClipsMode;
  readonly #exportFps: "interpolate" | "duplicate" | "native24";

  #prices: MockVideoPrices = "live";
  readonly #pixels = new Map<string, "unreadable" | "not-vertical">();
  #script: Script | null = null;
  #retryResult: MockRetryResult | null = null;
  #exportResult: MockExportResult | null = null;
  #failDelete: "journal" | "record" | null = null;
  /** 5b.2 (S5.WA3): the clips an import of the montage copy holds, by clip id, with the avatar each belongs to: the clip's lock while `media.importClip` runs. */
  readonly #importing = new Map<string, string>();
  /** 5b.2: the clips whose file in Studio is no longer the one the record names (the sha256 check of `media.importClip`); a test says so, the mock holds no file. */
  readonly #damaged = new Set<string>();

  /** The committed records by clip id, in creation order. */
  readonly #records = new Map<string, MockClipRecord>();
  readonly #lines: Line[] = [];
  readonly #journals = new Map<string, MockJournalLine[]>();
  /** Every journal line ever written, per clip, kept after the record removes the journal: what a test compares to the engine's lines (engine/clips/attempt.ts). */
  readonly #journalWrites = new Map<string, MockJournalLine[]>();
  readonly #files = new Map<string, { journal: boolean; record: boolean; media: boolean }>();
  readonly #jobs = new Map<string, Job>();
  /** What each clip's attempts will do: the script of its create (kept for a restart's recovery, which polls the same provider). */
  readonly #fates = new Map<string, Script>();
  readonly #holds = new Map<string, { until: number; cancel: () => void }>();
  /** Attempts whose net-usage baseline was read while another reserve or hold was live (engine/clips/attempt.ts `baselineAlone`). */
  readonly #crowdedAtBaseline = new Set<string>();
  /** Held attempts that COMPLETED (engine/clips/holds.ts `markCompleted`): the mark goes with the hold. */
  readonly #completedHolds = new Set<string>();
  readonly #exportStates = new Map<string, FileState>();
  /** The folder-relative paths clip exports made, in order. */
  readonly #exported: string[] = [];
  readonly revealed: { avatarId: string; clipId: string; relPath: string }[] = [];
  readonly #posts: AttemptModel[] = [];
  /** The avatar each clip in flight belongs to (a recovery needs it before there is a record). */
  readonly #clipAvatars = new Map<string, string>();
  readonly #attemptsByClip = new Map<string, RecordAttempt[]>();

  /**
   * I5.50 / I5.61: the ONE clip money unit of the whole engine, from its dispatch until its money closes: a single clip (its create's job), or a batch (until its last member's money closes). A refusal of a
   * second `clips.create` or `clips.createBatch` names which of the two holds it.
   */
  #unit: { kind: "clip"; job: Job } | { kind: "batch"; batch: MockClipBatch<MemberPayload> } | null = null;
  /** 5b.2: the batches of this process, by id (a finished one stays, bounded, so a late `clips.cancelBatch` answers 0 and not NOT_FOUND). */
  readonly #batches = new Map<string, MockClipBatch<MemberPayload>>();
  /** 5b.2 (S5.WB2c): each batch's own summary, by batch id (the engine's `clips/batches/<batchId>.json`): it outlives a restart, as the records do, and a clip delete never touches it. */
  readonly #summaries = new Map<string, ClipBatchState>();
  /** 5b.2 (`Budget.tryHold`): the month's room held for the members still to reserve, by attempt id: in memory only, gone with the process. */
  readonly #monthHolds = new Map<string, number>();
  /** The live caps of the clips (engine `setCap`/`clearCap`), by clip id: a single clip's accepted worst case, a batch member's share; set at the create, gone when the money closes or the member never runs. */
  readonly #caps = new Map<string, number>();
  /** 5b.2: the price book a batch was priced by, and when it was read: a turn re-reads it only when it is older than the cache's life (engine/money/priceCache.ts). */
  #book: PriceBook | null = null;
  /** 5b.2: what the next batch's members play, one entry per member, taken when a member's first reserve is made (its POST is about to leave). */
  #batchScripts: Script[] | null = null;
  /** The scripts of the batch that is being played: taken from the armed ones when it starts, so what one batch left unused never reaches the next, and a restart drops them. */
  #batchPlay: Script[] = [];
  #lastWriteMs = Number.NEGATIVE_INFINITY;
  #restartedAtMs = Number.NEGATIVE_INFINITY;
  #exportQueue: Job[] = [];
  #exportRunning: Job | null = null;
  #seeded = 0;

  constructor(host: MockClipsHost, options: MockClipsOptions = {}) {
    this.#host = host;
    this.#t = MOCK_CLIP_TIMINGS[options.timings ?? "real"];
    this.#mode = options.mode ?? GROK_FALLBACK;
    this.#boldClips = options.boldClips ?? BOLD_CLIPS;
    this.#exportFps = options.exportFps ?? EXPORT_FPS;
  }

  // ---------- test and rig switches ----------

  nextClip(script: MockClipScript): void {
    const parts = typeof script === "string" ? { first: script } : script;
    this.#script = { first: parts.first ?? "ok", then: parts.then ?? "ok", face: parts.face };
  }

  /**
   * 5b.2: the NEXT batch plays `scripts`, one per member, in the order the members' first POSTs leave (a member requeued after a 429 takes the next one again); an entry the story did not give is `ok`.
   * Used once, by the next `clips.createBatch`.
   */
  nextBatch(scripts: readonly MockClipScript[]): void {
    this.#batchScripts = scripts.map((entry) => {
      const parts = typeof entry === "string" ? { first: entry } : entry;
      return { first: parts.first ?? "ok", then: parts.then ?? "ok", face: parts.face };
    });
  }

  setVideoPrices(mode: MockVideoPrices): void {
    this.#prices = mode;
  }

  /** The listing's per-second rates move: every estimate from now on is the new one, so a click accepted at the old worst gets PRICE_CHANGED, as the engine's does. */
  setRates(rates: ClipPrices): void {
    this.#rates = Object.freeze({ ...rates });
  }

  setPhotoPixels(photoId: string, pixels: "ok" | "unreadable" | "not-vertical"): void {
    if (pixels === "ok") this.#pixels.delete(photoId);
    else this.#pixels.set(photoId, pixels);
  }

  nextRetry(result: MockRetryResult): void {
    this.#retryResult = result;
  }

  nextExport(result: MockExportResult): void {
    this.#exportResult = result;
  }

  failNextDelete(at: "journal" | "record"): void {
    this.#failDelete = at;
  }

  /** A journal left beside a committed record (a crash between the commit and the journal's removal): the restart removes it. */
  leaveStaleJournal(clipId: string): void {
    const record = this.#records.get(clipId);
    if (record === undefined) return;
    this.#journals.set(clipId, [{ type: "requested", clipId, photoId: record.photoId, request: record.request, motion: record.motion, acceptedWorstMicros: 0, at: record.createdAt }]);
    const files = this.#files.get(clipId);
    if (files !== undefined) files.journal = true;
  }

  /** The state a clip's export reads in `clips.get` (the owner deleted the file, replaced it...). */
  tamperExport(clipId: string, index: number, state: FileState): void {
    this.#exportStates.set(`${clipId}:${index}`, state);
  }

  /** Test-only: the reserve of `attemptId` is settled, nothing else (no journal line, no record), as a process that stopped between the ledger's `settle` and the journal's `ended` leaves it. */
  settleBeforeCrash(attemptId: string, bill: { costMicros: number; estimated: boolean }): void {
    const line = this.#lines.find((l) => l.attemptId === attemptId && l.state === "open");
    if (line === undefined) throw new Error(`no open reserve for ${attemptId}`);
    this.#settle(line, bill.costMicros, bill.estimated);
  }

  passTime(ms: number): void {
    this.#host.setClockAtLeast(this.#host.clockMs() + ms);
    let changed = false;
    for (const [attemptId, hold] of [...this.#holds]) {
      if (hold.until > this.#host.clockMs()) continue;
      hold.cancel();
      this.#holds.delete(attemptId);
      changed = true;
    }
    if (changed) this.#host.emitMoney();
  }

  /** `count` ready clips of an avatar, as a library that has made many would list them (their money is long settled). */
  seed(avatarId: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const id = `clip-seed-${String(++this.#seeded).padStart(4, "0")}`;
      const createdAt = iso(Date.UTC(2026, 8, 1) + this.#seeded * 60_000);
      const motion: ClipMotion = { source: "code", label: MOCK_CLIP_MOTIONS[0]?.label ?? "", text: MOCK_CLIP_MOTIONS[0]?.text ?? "" };
      this.#records.set(id, {
        id,
        avatarId,
        photoId: `photo-seed-${this.#seeded}`,
        createdAt,
        seen: true,
        motion,
        request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
        model: "kling-std",
        attempts: [{ attemptId: attemptIdOf(id, 1), model: "kling", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }],
        recovered: false,
        exports: [],
        outcome: { status: "ready", width: 720, height: 1280, durationMs: 5_000, face: { verdict: "match", p75: 0.86, frames: 10 } },
      });
      this.#files.set(id, { journal: false, record: true, media: true });
      this.#lines.push({ attemptId: attemptIdOf(id, 1), clipId: id, model: "kling", worstMicros: 504_000, reserveAtMs: Date.parse(createdAt), state: "settled", costMicros: 420_000, estimated: false, own: false, inFlight: false });
    }
  }

  /** What the tests look at: the registry, the ledger lines, the POSTs that left, the journals and the files. */
  peek() {
    return {
      holds: new Map([...this.#holds].map(([id, h]) => [id, h.until])),
      /** 5b.2: the month's room held for batch members that have not reserved yet, by attempt id. */
      monthHolds: new Map(this.#monthHolds),
      /** 5b.2: who holds the one clip money unit. */
      unit: this.#unit === null ? null : this.#unit.kind,
      /** 5b.2: a clip job holds the library (a switch waits), and the avatars whose clip jobs are live (an avatar delete waits). */
      busy: this.busy(),
      liveAvatars: [...new Set([...this.#jobs.values()].filter((j) => j.status === "running").map((j) => j.avatarId))],
      /** 5b.2 (45b): what the quit question counts: the clips between `submitting` and `proving`, and the batch members still to be made (`queued` or `preparing`). */
      quit: this.quitCounts(),
      attempts: this.#lines.map((l) => ({ ...l })),
      posts: [...this.#posts],
      journals: Object.fromEntries([...this.#journals].map(([id, lines]) => [id, [...lines]])),
      journalWrites: Object.fromEntries([...this.#journalWrites].map(([id, lines]) => [id, [...lines]])),
      files: Object.fromEntries([...this.#files].filter(([, f]) => f.journal || f.record || f.media)),
      nowMs: this.#host.clockMs(),
      restartedAtMs: this.#restartedAtMs,
      exportedFiles: [...this.#exported],
    };
  }

  // ---------- money, as the engine's #moneyStatus and #reconcile read it ----------

  /** What the batches hold of the month for members that have not reserved yet (`Budget.status().heldMicros`): every other paid command counts it (spent + open + held). */
  heldMicros(): number {
    let held = 0;
    for (const micros of this.#monthHolds.values()) held += micros;
    return held;
  }

  /**
   * The live caps as the autopilot's room reads them (autopilot/room.ts `monthRoom`): each clip's cap and what its scope has committed (settled at cost, open at worst, held), so the room subtracts
   * `max(0, cap - committed)` for each.
   */
  liveCaps(): { capMicros: number; committedMicros: number }[] {
    return [...this.#caps].map(([clipId, capMicros]) => {
      let committedMicros = 0;
      for (const line of this.#lines) if (line.clipId === clipId) committedMicros += line.state === "open" ? line.worstMicros : line.costMicros;
      for (const [attemptId, micros] of this.#monthHolds) if (attemptId.startsWith(`${clipId}:`)) committedMicros += micros;
      return { capMicros, committedMicros };
    });
  }

  /** The one clip money unit is held (a single clip, or a batch with members still to be made): a reconcile is refused IN_FLIGHT, as the engine's paid-command count refuses it. */
  paidOpen(): boolean {
    return this.#unit !== null;
  }

  /** main/clipHost.ts (45, 45b): the clips between `submitting` and `proving` may bill; the batch members that are `queued` or `preparing` have cost nothing yet and will not be made if the app quits. */
  quitCounts(): { inFlight: number; queued: number } {
    let inFlight = 0;
    let queued = 0;
    for (const job of this.#jobs.values()) {
      if (job.status !== "running" || job.kind === "export") continue;
      if (job.phase === "submitting" || job.phase === "rendering" || job.phase === "proving") inFlight++;
      else if (job.batch !== undefined && (job.phase === "queued" || job.phase === "preparing")) queued++;
    }
    return { inFlight, queued };
  }

  /** A clip job (create, retry, export) holds the library: a switch waits. */
  busy(): boolean {
    return [...this.#jobs.values()].some((j) => j.status === "running" && j.kind !== "recovery");
  }

  /** An export is queued or running: a pick of another export folder waits. */
  exporting(): boolean {
    return [...this.#jobs.values()].some((j) => j.status === "running" && j.kind === "export");
  }

  /** A clip job of this avatar is live (recoveries included): an avatar delete waits. */
  liveFor(avatarId: string): boolean {
    return [...this.#jobs.values()].some((j) => j.status === "running" && j.avatarId === avatarId);
  }

  removeAvatar(avatarId: string): void {
    for (const [id, record] of [...this.#records]) {
      if (record.avatarId !== avatarId) continue;
      this.#records.delete(id);
      this.#files.delete(id);
      this.#journals.delete(id);
    }
    for (const [id, job] of [...this.#jobs]) if (job.avatarId === avatarId) this.#jobs.delete(id);
  }

  /**
   * An open reserve of a clip that is not a reconcile reason: this process's own, while it is in flight (engine.ts: `!budget.isInFlight`) or its hold lasts (the renderer's paidStop would stop every
   * paid action for nothing). Without the in-flight half the reserve showed as a reason for a moment before its hold was taken, and when the terminal hold ended in the proof settle's own tick.
   */
  #hidden(line: Line): boolean {
    return line.own && (line.inFlight || this.#holds.has(line.attemptId));
  }

  /** `open-reserves` is a reason for an open clip reserve that is not held. */
  openReserveReason(): boolean {
    return this.#lines.some((l) => l.state === "open" && !this.#hidden(l));
  }

  /** The earliest time the reconcile can run, or null when nothing delays it (engine.ts `#clips.reconcileAvailableAt`). */
  reconcileAvailableAt(): number | null {
    const now = this.#host.clockMs();
    let held: number | null = null;
    for (const hold of this.#holds.values()) if (hold.until > now) held = held === null ? hold.until : Math.max(held, hold.until);
    const earlier = this.#lines.some((l) => l.state === "open" && !l.own);
    const quiet = earlier && this.#restartedAtMs + RECONCILE_QUIET_MS + REQUEST_TIMEOUT_MS > now ? this.#restartedAtMs + RECONCILE_QUIET_MS + REQUEST_TIMEOUT_MS : null;
    return held === null ? quiet : quiet === null ? held : Math.max(held, quiet);
  }

  /** How long the reconcile has to wait now (the holds, and the budget's own quiet rule after a clip's ledger write); 0 when it need not. */
  reconcileWaitMs(): number {
    const now = this.#host.clockMs();
    const availableAt = this.reconcileAvailableAt();
    const quiet = this.#lastWriteMs + RECONCILE_QUIET_MS;
    const until = Math.max(availableAt ?? Number.NEGATIVE_INFINITY, quiet);
    return until > now ? Math.ceil(until - now) : 0;
  }

  /** The owner's reconcile settled every open reserve at its worst case (the mock closes the whole map). */
  onReconciled(): void {
    let closed = 0;
    for (const line of this.#lines) {
      if (line.state !== "open") continue;
      line.state = "settled";
      line.costMicros = line.worstMicros;
      line.estimated = true;
      closed++;
    }
    for (const hold of this.#holds.values()) hold.cancel();
    this.#holds.clear();
    // The reconcile writes its marker, and the budget's quiet rule counts from it: a clip's money is all this models (the photo paths never waited).
    if (closed > 0) this.#lastWriteMs = this.#host.clockMs();
  }

  tooEarly(): ReconcileResult | null {
    const wait = this.reconcileWaitMs();
    return wait > 0 ? { status: "too-early", retryAfterMs: wait, warnings: [] } : null;
  }

  // ---------- the hold registry (engine/clips/holds.ts) ----------

  #hold(attemptId: string, durationMs: number): void {
    this.#holds.get(attemptId)?.cancel();
    this.#completedHolds.delete(attemptId);
    const host = this.#host;
    const until = host.clockMs() + durationMs;
    const cancel = host.scheduler.schedule(durationMs, () => {
      const entry = this.#holds.get(attemptId);
      if (entry === undefined || entry.until !== until) return;
      host.setClockAtLeast(until);
      this.#holds.delete(attemptId);
      this.#completedHolds.delete(attemptId);
      host.emitMoney();
    });
    this.#holds.set(attemptId, { until, cancel });
    host.emitMoney();
  }

  /**
   * Foreign money can still move (engine/clips/attempt.ts `moneyIsAlone`, negated): another attempt's reserve is open, or its hold is live and its close is not exact (no close, or a settle at worst).
   * A live hold of a COMPLETED attempt settled exactly does not count (engine/clips/attempt.ts); any other live hold does.
   */
  #otherMoneyOpen(attemptId: string): boolean {
    return !this.#alone(attemptId);
  }

  /**
   * The engine's rule itself (shared/engine/clipAlone.ts), read by the engine's attempts and by its batch's alone-wait alike (5b.2, L6): no foreign money can still move on `/credits`. The ledger the engine
   * reads is the budget's, across every kind of job (photo runs, scenes, portraits, autopilot), not only the clips': the host's open reserves are that ledger. `attemptId` may be one that does not exist yet
   * (a batch member waiting for its turn), which excludes nothing.
   */
  #alone(attemptId: string): boolean {
    return clipAlone({
      ledger: {
        openReserves: () => [...this.#host.reserves.keys()].map((id) => ({ attemptId: id })),
        closeOf: (id) => {
          const line = this.#lines.find((l) => l.attemptId === id);
          return line === undefined || line.state === "open" ? undefined : { type: "settle", estimated: line.estimated };
        },
      },
      holds: { entries: () => new Map([...this.#holds].map(([id, hold]) => [id, hold.until])), isCompleted: (id) => this.#completedHolds.has(id) },
      attemptId,
      nowMs: this.#host.clockMs(),
    });
  }

  #release(attemptId: string): void {
    const entry = this.#holds.get(attemptId);
    if (entry === undefined) return;
    entry.cancel();
    this.#holds.delete(attemptId);
    this.#completedHolds.delete(attemptId);
    this.#host.emitMoney();
  }

  // ---------- the ledger lines ----------

  #reserve(clipId: string, n: 1 | 2, model: AttemptModel, worstMicros: number): Line {
    const line: Line = { attemptId: attemptIdOf(clipId, n), clipId, model, worstMicros, reserveAtMs: this.#host.clockMs(), state: "open", costMicros: 0, estimated: false, own: true, inFlight: true };
    this.#lines.push(line);
    // A batch member's first reserve takes the place of its hold (`Budget.tryReserve`: «the attempt's own hold is what this reserve replaces»).
    this.#monthHolds.delete(line.attemptId);
    this.#host.reserves.set(line.attemptId, worstMicros);
    this.#lastWriteMs = line.reserveAtMs;
    this.#host.emitMoney();
    return line;
  }

  #settle(line: Line, costMicros: number, estimated: boolean): void {
    line.state = "settled";
    line.inFlight = false;
    line.costMicros = costMicros;
    line.estimated = estimated;
    this.#host.reserves.delete(line.attemptId);
    this.#lastWriteMs = this.#host.clockMs();
    this.#host.spend(costMicros);
  }

  /** What a clip cost, read from the ledger lines as the engine's `clipCostsOf` reads its ledger (I5.49). */
  #costOf(clipId: string): ClipCost {
    let total = 0;
    let open = 0;
    let estimated = false;
    for (const line of this.#lines) {
      if (line.clipId !== clipId) continue;
      if (line.state === "open") {
        total += line.worstMicros;
        open += line.worstMicros;
      } else {
        total += line.costMicros;
        if (line.estimated && line.costMicros > 0) estimated = true;
      }
    }
    if (open > 0) return { micros: total, kind: "open" };
    if (total === 0) return { micros: 0, kind: "free" };
    return { micros: total, kind: estimated ? "estimated" : "billed" };
  }

  // ---------- reading a photo ----------

  #photoOf(avatarId: string, photoId: string): Out<{ photo: PhotoSummary | null }> {
    const avatar = this.#host.avatar(avatarId);
    if (avatar === undefined || !avatar.active || this.#host.deletePending(avatarId)) return bad({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });
    if (photoId === avatar.masterPhotoId) return good({ photo: null });
    const photo = this.#host.photo(avatarId, photoId);
    if (photo === undefined) return bad({ code: "NOT_FOUND", detail: `avatar ${avatarId} has no photo ${photoId}` });
    return good({ photo });
  }

  /** The engine's `#facts`, in its order: not a gallery photo, its age, its pixels, «Смелая» off, no motion. */
  #read(photo: PhotoSummary | null): ItemRead {
    if (photo === null) return { kind: "refused", reason: "not-a-gallery-photo" };
    const facts = factsOf(photo);
    if (facts.ageRefused) return { kind: "refused", reason: "age-unverified" };
    const pixels = this.#pixels.get(photo.photoId);
    if (pixels === "unreadable") return { kind: "refused", reason: "photo-unreadable" };
    if (pixels === "not-vertical") return { kind: "refused", reason: "not-vertical" };
    if (facts.bold && this.#boldClips === "off") return { kind: "refused", reason: "bold-off" };
    if (!facts.judged) return { kind: "refused", reason: "no-motion" };
    return { kind: "suitable", facts, motions: MOCK_CLIP_MOTIONS };
  }

  #fallbackOf(facts: Facts): "auto" | "offer" | "none" {
    return facts.bold && this.#boldClips !== "with-fallback" ? "none" : this.#mode;
  }

  /** An estimate from a price book already read: the rates, and where they came from and the day (the book's own, not the listing's mode now). */
  #estimate(parts: Omit<ClipPriceParts, "prices" | "mode" | "boldClips">, book: PriceBook): Estimate {
    const full: ClipPriceParts = { ...parts, mode: this.#mode, boldClips: this.#boldClips, prices: book.rates };
    return { expectedMicros: clipExpectedMicros(full), worstMicros: clipWorstMicros(full), prices: book.source, pricesAsOf: book.asOf };
  }

  /**
   * The video price book, from the ONE cache every clip command reads (engine.ts `#prices`, a `PriceCache`: 10 minutes for a live listing, a minute for the dated table). A listing that moved, or lost a
   * price, a moment ago is not seen yet; once the cache is older than its life the listing is read again, and `null` is a listing that reads and lacks a price (PRICE_UNAVAILABLE `video`).
   */
  #readBook(): PriceBook | null {
    const now = this.#host.clockMs();
    const cached = this.#book;
    if (cached !== null && now - cached.readAtMs < (cached.source === "live" ? 10 * MINUTE : MINUTE)) return cached;
    if (this.#prices === "missing") return null;
    const source = this.#prices === "live" ? "live" : "fallback";
    this.#book = { rates: this.#rates, readAtMs: now, source, asOf: source === "fallback" ? FALLBACK_DATE : this.#host.pricesAsOf() };
    return this.#book;
  }

  /** What the month has committed: spent, open at worst, and (5b.2) held for the members of a batch that have not reserved yet, less `exceptHold`'s own hold, which its reserve replaces (`Budget.tryReserve`). */
  #committed(exceptHold?: string): number {
    let open = 0;
    for (const worst of this.#host.reserves.values()) open += worst;
    let held = 0;
    for (const [id, micros] of this.#monthHolds) if (id !== exceptHold) held += micros;
    return this.#host.spentMicros() + open + held;
  }

  #fits(worstMicros: number, exceptHold?: string): boolean {
    return this.#committed(exceptHold) + worstMicros <= this.#host.monthlyBudgetMicros();
  }

  /** `max(0, monthlyBudget - (spent + open + held))`: the model `#fits` and the hold refuse by (engine.ts `#monthRoomMicros`). */
  #monthRoom(): number {
    return Math.max(0, this.#host.monthlyBudgetMicros() - this.#committed());
  }

  #unavailable(): EngineError {
    return { code: "PRICE_UNAVAILABLE", priceScope: "video", detail: "the video listing reads but holds no price for a needed model" };
  }

  // ---------- clips.options ----------

  options(payload: CommandPayload<"clips.options">): Out<ClipOptions> {
    const found = this.#photoOf(payload.avatarId, payload.photoId);
    if (!found.ok) return found;
    const read = this.#read(found.result.photo);
    if (read.kind === "refused") return good({ suitable: false, photoId: payload.photoId, reason: read.reason });
    const book = this.#readBook();
    if (book === null) return bad(this.#unavailable());
    return good(this.#suitableOptions(payload.photoId, read.facts, read.motions, (worstMicros) => this.#fits(worstMicros), book));
  }

  /** The sheet of one suitable photo (`ClipOptions`): its prices from one book, and whether the month (`fits`, one yes-or-no on a worst case) takes each option. */
  #suitableOptions(photoId: string, facts: Facts, motions: readonly ClipMotionChoice[], fits: (worstMicros: number) => boolean, book: PriceBook): Extract<ClipOptions, { suitable: true }> {
    const fallback = this.#fallbackOf(facts);
    const kling = (quality: ClipQuality, seconds: ClipSeconds, withFallback: "auto" | "none"): Estimate => this.#estimate({ model: "kling", quality, seconds, fallback: withFallback, bold: facts.bold }, book);
    const grok = (seconds: ClipSeconds): Estimate => this.#estimate({ model: "grok", quality: "std", seconds, fallback: "none", bold: facts.bold }, book);
    const set = (withFallback: "auto" | "none") => ({ std5: kling("std", 5, withFallback), pro5: kling("pro", 5, withFallback), std10: kling("std", 10, withFallback), pro10: kling("pro", 10, withFallback) });
    const prices = set("auto");
    const noFallbackPrices = set("none");
    const fit = (key: keyof typeof prices) => {
      if (fallback === "auto" && fits(prices[key].worstMicros)) return "with-fallback" as const;
      return fits(noFallbackPrices[key].worstMicros) ? ("without-fallback" as const) : ("none" as const);
    };
    return {
      suitable: true,
      photoId,
      motions: motions.map((m) => ({ ...m })),
      prices: { ...prices, grok5: grok(5), grok10: grok(10) },
      fallback,
      bold: facts.bold,
      noFallbackPrices,
      monthFits: { std5: fit("std5"), pro5: fit("pro5"), std10: fit("std10"), pro10: fit("pro10") },
    };
  }

  // ---------- clips.batchOptions (5b.2, S5.WB3) ----------

  /** One photo as a batch reads it, in the engine's order: a photo that is not in the gallery of the avatar (missing, another avatar's, the master) is `not-a-gallery-photo` (an item's own answer, never NOT_FOUND). */
  #readItem(avatarId: string, photoId: string): ItemRead {
    const avatar = this.#host.avatar(avatarId);
    if (photoId === avatar?.masterPhotoId) return { kind: "refused", reason: "not-a-gallery-photo" };
    const photo = this.#host.photo(avatarId, photoId);
    return this.#read(photo === undefined ? null : photo);
  }

  /** The avatar, active and not being deleted: NOT_FOUND otherwise. */
  #activeAvatar(avatarId: string): Out<true> {
    const avatar = this.#host.avatar(avatarId);
    if (avatar === undefined || !avatar.active || this.#host.deletePending(avatarId)) return bad({ code: "NOT_FOUND", detail: `no active avatar ${avatarId} in the open library` });
    return good(true);
  }

  /**
   * The sheet of a batch, free: each photo's own `ClipOptions` in the order asked, the four sums over the photos that can be made, the month's room and what fits. The month is read ONCE and every
   * `monthFits` (a photo's and the batch's) is derived from that one figure, so the answer never disagrees with itself.
   */
  batchOptions(payload: CommandPayload<"clips.batchOptions">): Out<ClipBatchOptions> {
    const active = this.#activeAvatar(payload.avatarId);
    if (!active.ok) return active;
    const reads = payload.photoIds.map((photoId) => this.#readItem(payload.avatarId, photoId));
    // The price goes through the cache, as the engine's does (10 minutes for a live listing): a listing that lost a price a minute ago is not seen yet.
    const priced = this.#readBook();
    if (priced === null) return bad(this.#unavailable());
    const book = priced.rates;
    // A ledger that cannot be read has no month to count by: no room, nothing fits (the engine's `budget === null`).
    const room = this.#host.ledgerReadable() ? this.#monthRoom() : 0;
    const fits = (worstMicros: number): boolean => this.#host.ledgerReadable() && worstMicros <= room;
    const items = reads.map((read, i): ClipOptions => {
      const photoId = payload.photoIds[i] ?? "";
      if (read.kind === "refused") return { suitable: false, photoId, reason: read.reason };
      return this.#suitableOptions(photoId, read.facts, read.motions, fits, priced);
    });
    const members = reads.flatMap((read) => (read.kind === "suitable" ? [{ bold: read.facts.bold }] : []));
    const anyFallback = items.some((item) => item.suitable && item.fallback === "auto");
    const sum = (quality: ClipQuality, seconds: ClipSeconds) => {
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
    return good({ items, sums, monthRoomMicros: room, monthFits });
  }

  // ---------- clips.create ----------

  /**
   * Why a new clip money unit cannot start now, or null (5b.2, I5.61). The ONE place the in-flight refusal of `clips.create` and `clips.createBatch` is decided (engine/clips/service.ts `unitRefusal`): a single clip
   * holding the unit is `one-at-a-time`, a batch holding it is `batch-running`.
   */
  unitRefusal(): EngineError | null {
    if (this.#unit === null) return null;
    if (this.#unit.kind === "batch") return { code: "IN_FLIGHT", clipReason: "batch-running", detail: "a batch of clips is being made; wait for it to end or cancel the rest" };
    return { code: "IN_FLIGHT", clipReason: "one-at-a-time", detail: "another clip is being made; one paid clip runs at a time" };
  }

  create(payload: CommandPayload<"clips.create">): Out<{ jobId: string }> {
    // The unit is the FIRST check (I5.50, I5.61).
    const held = this.unitRefusal();
    if (held !== null) return bad(held);
    const gated = this.#host.gate();
    if (gated !== null) return bad(gated);
    const found = this.#photoOf(payload.avatarId, payload.photoId);
    if (!found.ok) return found;
    const read = this.#read(found.result.photo);
    if (read.kind === "refused") return bad({ code: "VALIDATION", clipReason: read.reason, detail: `photo ${payload.photoId} cannot be brought to life (${read.reason})` });
    const motion = read.motions.find((m) => m.id === payload.motionId);
    if (motion === undefined) return bad({ code: "VALIDATION", clipReason: "unknown-motion", detail: `the motion ${payload.motionId} is not one this photo offers` });
    const photoFallback = this.#fallbackOf(read.facts);
    if (payload.model === "grok" && (this.#mode !== "offer" || photoFallback === "none")) return bad({ code: "VALIDATION", clipReason: "grok-not-offered", detail: "Grok is not offered for this clip" });
    const request: ClipRequest = { model: payload.model, quality: payload.quality, seconds: payload.seconds, fallback: payload.model === "grok" || photoFallback === "none" ? "none" : payload.fallback };
    const book = this.#readBook();
    if (book === null) return bad(this.#unavailable());
    const estimate = this.#estimate({ ...request, bold: read.facts.bold }, book);
    if (estimate.worstMicros > payload.acceptedWorstMicros) return bad({ code: "PRICE_CHANGED", detail: `the worst case is now ${estimate.worstMicros} µ$, above the accepted ${payload.acceptedWorstMicros} µ$` });
    if (!this.#fits(estimate.worstMicros)) return bad({ code: "BUDGET_EXCEEDED", detail: `committed ${this.#committed()} µ$ + this job's worst case ${estimate.worstMicros} µ$ > the monthly budget ${this.#host.monthlyBudgetMicros()} µ$` });

    const script = this.#script ?? { first: "ok" as const, then: "ok" as const, face: undefined };
    this.#script = null;
    const job = this.#newJob(payload.avatarId, "create");
    job.facts = { photoId: payload.photoId, request, motion: { source: "code", label: motion.label }, acceptedWorstMicros: payload.acceptedWorstMicros };
    this.#unit = { kind: "clip", job };
    this.#caps.set(job.clipId, Math.min(payload.acceptedWorstMicros, estimate.worstMicros));
    this.#fates.set(job.clipId, script);
    this.#clipAvatars.set(job.clipId, payload.avatarId);
    const createdAt = this.#host.nowIso();
    const run: CreateRun = { job, photoId: payload.photoId, request, motion: { source: "code", label: motion.label, text: motion.text }, accepted: payload.acceptedWorstMicros, facts: read.facts, script, createdAt, mode: this.#mode, rates: book.rates };
    this.#clipRates.set(job.clipId, book.rates);
    this.#progress(job, { phase: "preparing" });
    this.#after(job, this.#host.stepMs, () => this.#attempt(run, 1, request.model));
    return good({ jobId: job.jobId });
  }

  // ---------- clips.createBatch (5b.2, S5.WB3) ----------

  /**
   * The batch «Оживить выбранные» (plan s5b2 §5.2.2, I5.61-I5.63), refusal for refusal as the engine's `createBatch`: the unit first, then the key and the ledger, the avatar, each item in the pick order (its own
   * reason with its path), the price, the sum the owner accepted, and the month hold. Every refusal is free and leaves nothing behind: no hold, no job, no unit.
   */
  createBatch(payload: CommandPayload<"clips.createBatch">): Out<{ batchId: string; jobIds: string[] }> {
    const held = this.unitRefusal();
    if (held !== null) return bad(held);
    const gated = this.#host.gate();
    if (gated !== null) return bad(gated);
    const { avatarId } = payload;
    const active = this.#activeAvatar(avatarId);
    if (!active.ok) return active;

    // The items in the pick order; the lowest refused item is the one told, with its own reason and its path (one `clipReason` per error).
    const chosen: { photoId: string; facts: Facts; motion: ClipMotionChoice }[] = [];
    for (const [i, item] of payload.items.entries()) {
      const read = this.#readItem(avatarId, item.photoId);
      if (read.kind === "refused") return bad({ code: "VALIDATION", clipReason: read.reason, path: ["items", i], detail: `item ${i} (photo ${item.photoId}) cannot be brought to life (${read.reason})` });
      const motion = read.motions.find((choice) => choice.id === item.motionId);
      if (motion === undefined) return bad({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", i], detail: `item ${i}: the motion ${item.motionId} is not one this photo offers` });
      chosen.push({ photoId: item.photoId, facts: read.facts, motion });
    }

    // The price book of the batch, and each member's share: its worst case under it (Kling-only for «Смелая», max(Kling, Grok) in `auto` with a fallback allowed).
    const priced = this.#readBook();
    if (priced === null) return bad(this.#unavailable());
    const book = priced.rates;
    const drafts = chosen.map((member) => {
      const fallback = this.#fallbackOf(member.facts) === "none" ? ("none" as const) : payload.fallback;
      const request: ClipRequest = { model: "kling", quality: payload.quality, seconds: payload.seconds, fallback };
      const share = clipWorstMicros({ ...request, mode: this.#mode, bold: member.facts.bold, boldClips: this.#boldClips, prices: book });
      return { ...member, request, share };
    });
    const total = clipBatchWorstMicros(
      chosen.map((member) => ({ bold: member.facts.bold })),
      { quality: payload.quality, seconds: payload.seconds, mode: this.#mode, fallback: payload.fallback, boldClips: this.#boldClips, prices: book },
    );
    if (drafts.reduce((sum, d) => sum + d.share, 0) !== total) return bad({ code: "INTERNAL", detail: "the members' shares do not add up to the batch's worst case" });
    if (total > payload.acceptedWorstMicros) return bad({ code: "PRICE_CHANGED", detail: `the worst case is now ${total} µ$, above the accepted ${payload.acceptedWorstMicros} µ$` });
    // The month is held for every member at once (`Budget.tryHold`): all or nothing.
    if (!this.#fits(total)) return bad({ code: "BUDGET_EXCEEDED", detail: `committed ${this.#committed()} µ$ + the batch's ${total} µ$ > the limit ${this.#host.monthlyBudgetMicros()} µ$; nothing was held` });

    const batchId = this.#host.nextId("batch");
    const size = drafts.length;
    const members: BatchMember<MemberPayload>[] = drafts.map((d, i) => {
      const job = this.#newJob(avatarId, "create", "queued");
      job.facts = { photoId: d.photoId, request: d.request, motion: { source: "code", label: d.motion.label }, acceptedWorstMicros: d.share };
      job.batch = { batchId, batchIndex: i + 1, batchSize: size };
      this.#monthHolds.set(attemptIdOf(job.clipId, 1), d.share);
      this.#caps.set(job.clipId, d.share);
      return {
        index: i + 1,
        photoId: d.photoId,
        bold: d.facts.bold,
        share: d.share,
        jobId: job.jobId,
        clipId: job.clipId,
        held: true,
        retried: false,
        payload: { request: d.request, motion: { source: "code", label: d.motion.label, text: d.motion.text }, facts: d.facts },
        state: "queued",
        wake: null,
      };
    });
    for (const member of members) this.#progress(this.#jobs.get(member.jobId) ?? this.#absent(member.jobId), { phase: "queued", waitReason: "turn" });
    // The armed scripts are this batch's alone (used once): whatever an earlier batch left unplayed is gone.
    this.#batchPlay = this.#batchScripts ?? [];
    this.#batchScripts = null;
    // 5b.2 (S5.WB2c): the batch's summary, every member queued, before its first turn; then the avatar's oldest summaries past the kept ones go.
    this.#summaries.set(batchId, startBatchState({ batchId, avatarId, createdAt: this.#host.nowIso(), clipIds: members.map((member) => member.clipId) }));
    this.#forgetOldBatches(avatarId);
    const batch = new MockClipBatch<MemberPayload>(this.#batchPorts(avatarId, batchId, size), { id: batchId, avatarId, members });
    for (const member of members) {
      const job = this.#jobs.get(member.jobId);
      if (job !== undefined) job.member = { batch, ref: member };
    }
    this.#remember(batch);
    this.#unit = { kind: "batch", batch };
    batch.start();
    return good({ batchId, jobIds: members.map((member) => member.jobId) });
  }

  #absent(jobId: string): never {
    throw new Error(`no clip job ${jobId}`);
  }

  /** The batches kept: the running ones, and the last few that ended (the engine keeps 50). */
  #remember(batch: MockClipBatch<MemberPayload>): void {
    this.#batches.set(batch.id, batch);
    const finished = [...this.#batches.values()].filter((candidate) => candidate.over);
    for (const old of finished.slice(0, Math.max(0, finished.length - 50))) this.#batches.delete(old.id);
  }

  /** `clips.cancelBatch` (I5.63): every member still queued is cancelled, free; a member already sent is never cancelled. The count of those cancelled. NOT_FOUND for a batch this avatar does not have. */
  cancelBatch(payload: CommandPayload<"clips.cancelBatch">): Out<{ cancelled: number }> {
    const batch = this.#batches.get(payload.batchId);
    if (batch === undefined || batch.avatarId !== payload.avatarId) return bad({ code: "NOT_FOUND", detail: `avatar ${payload.avatarId} has no batch ${payload.batchId}` });
    return good({ cancelled: batch.cancelQueued() });
  }

  /** A timer of the mock's scheduler that moves the mock's clock as it fires, without a job to own it (a batch's own waits). */
  #later(ms: number, fn: () => void): () => void {
    const due = this.#host.clockMs() + ms;
    return this.#host.scheduler.schedule(ms, () => {
      this.#host.setClockAtLeast(due);
      fn();
    });
  }

  /** A member's photo at its turn: still in the gallery of its avatar, and its file still usable as a first frame. */
  #recheck(avatarId: string, photoId: string): "ok" | "gone" | "unreadable" {
    const avatar = this.#host.avatar(avatarId);
    if (avatar === undefined || this.#host.deletePending(avatarId) || this.#host.photo(avatarId, photoId) === undefined) return "gone";
    return this.#pixels.has(photoId) ? "unreadable" : "ok";
  }

  /** What a batch needs of the mock: its clock, its ledger, its jobs, and the clip of one member. */
  #batchPorts(avatarId: string, batchId: string, size: number): MockBatchPorts<MemberPayload> {
    const host = this.#host;
    const jobOf = (member: BatchMember<MemberPayload>): Job => this.#jobs.get(member.jobId) ?? this.#absent(member.jobId);
    return {
      clock: () => host.clockMs(),
      later: (ms, fn) => this.#later(ms, fn),
      timings: this.#t,
      readKey: () => host.keyGate(),
      readPrices: () => this.#readBook()?.rates ?? null,
      worstOf: (member, prices) => clipWorstMicros({ ...member.payload.request, mode: this.#mode, bold: member.bold, boldClips: this.#boldClips, prices }),
      recheck: (member) => this.#recheck(avatarId, member.photoId),
      alone: (member) => this.#alone(attemptIdOf(member.clipId, 1)),
      told: (member, reason) => this.#progress(jobOf(member), { phase: "queued", waitReason: reason }),
      cancelJob: (member, detail) => {
        const job = jobOf(member);
        this.#caps.delete(job.clipId);
        this.#finish(job, detail === undefined ? { status: "cancelled" } : { status: "cancelled", detail });
        host.emitMoney();
      },
      failJob: (member, error) => {
        this.#caps.delete(member.clipId);
        this.#finish(jobOf(member), { status: "failed", error });
        host.emitMoney();
      },
      requeue: (member) => {
        const first = jobOf(member);
        const job = this.#newJob(avatarId, "create", "queued");
        job.facts = first.facts === undefined ? undefined : { ...first.facts };
        job.batch = { batchId, batchIndex: member.index, batchSize: size };
        // It waits for its turn at the tail (engine/clips/batch.ts, S5.WB2c): the pause is told only if its own turn comes inside it.
        this.#progress(job, { phase: "queued", waitReason: "turn" });
        this.#caps.set(job.clipId, member.share);
        const next: BatchMember<MemberPayload> = { ...member, jobId: job.jobId, clipId: job.clipId, held: false, retried: true, state: "queued", wake: null };
        job.member = { batch: first.member?.batch ?? this.#absent(member.jobId), ref: next };
        return next;
      },
      runMember: (member, prices) => this.#startMember(member, prices, avatarId),
      releaseHold: (member) => void this.#monthHolds.delete(attemptIdOf(member.clipId, 1)),
      finished: () => {
        this.#unit = null;
        host.emitMoney();
      },
      log: () => undefined,
      note: (change) => this.#noteBatch(batchId, change),
    };
  }

  // ---------- the batch summaries (5b.2, S5.WB2c; engine/clips/batchSummary.ts) ----------

  /** The ledger's cost of each clip a summary names (`#costOf`, the engine's `clipCostsOf`). */
  #costsOf(state: ClipBatchState): Map<string, ClipCost> {
    return new Map(state.members.flatMap((member) => member.clipIds).map((clipId) => [clipId, this.#costOf(clipId)]));
  }

  /** A transition of a batch, applied to its summary with the ledger's money now. */
  #noteBatch(batchId: string, change: BatchChange): void {
    const state = this.#summaries.get(batchId);
    if (state === undefined) return;
    const next = applyBatchChange(state, change);
    this.#summaries.set(batchId, withCosts(next, this.#costsOf(next)));
  }

  /** A batch member's record was committed (a recovery's, or a download fetched again): its member ends as the record says. */
  #noteMemberRecord(record: MockClipRecord): void {
    if (record.batch === undefined) return;
    this.#noteBatch(record.batch.batchId, { kind: "ended", index: record.batch.batchIndex, clipId: record.id, outcome: clipBatchOutcomeOf(record.outcome) });
  }

  /** Past the kept ones, an avatar's summaries whose queue ended and whose money is closed go. */
  #forgetOldBatches(avatarId: string): void {
    const mine = [...this.#summaries.values()].filter((state) => state.avatarId === avatarId);
    for (const batchId of toForget(mine, (state) => moneyOpen(state, this.#costsOf(state)))) this.#summaries.delete(batchId);
  }

  /** The restart's pass (engine `#endBatchesAfterRestart`): a batch the summaries still have running ends; a member at work is looked up by its journal, its record, its reserve. */
  #endBatchesAfterRestart(): void {
    const at = this.#host.nowIso();
    const look = (clipId: string): MemberLook => {
      if (this.#journals.has(clipId)) return { kind: "journal" };
      const record = this.#records.get(clipId);
      if (record !== undefined) return { kind: "record", outcome: clipBatchOutcomeOf(record.outcome) };
      return this.#lines.some((line) => line.clipId === clipId) ? { kind: "reserved" } : { kind: "nothing" };
    };
    for (const [batchId, state] of this.#summaries) {
      if (state.endedAt !== undefined && runningClipIds(state).length === 0) continue;
      const next = afterRestart(state, new Map(runningClipIds(state).map((clipId) => [clipId, look(clipId)])), at);
      this.#summaries.set(batchId, withCosts(next, this.#costsOf(next)));
    }
  }

  /** A member's turn has come: the clip of a single create, under the member's own job, share and price book. */
  #startMember(member: BatchMember<MemberPayload>, prices: ClipPrices, avatarId: string): void {
    const job = this.#jobs.get(member.jobId);
    if (job === undefined) return;
    const { payload } = member;
    const run: CreateRun = {
      job,
      photoId: member.photoId,
      request: payload.request,
      motion: payload.motion,
      accepted: member.share,
      facts: payload.facts,
      // The member plays the batch's next script when its first reserve is made, when its POST is about to leave (`#attempt`).
      script: { first: "ok", then: "ok", face: undefined },
      takesBatchScript: true,
      createdAt: this.#host.nowIso(),
      mode: this.#mode,
      rates: prices,
    };
    this.#clipAvatars.set(job.clipId, avatarId);
    this.#clipRates.set(job.clipId, prices);
    job.ran = true;
    this.#progress(job, { phase: "preparing" });
    this.#after(job, this.#host.stepMs, () => this.#attempt(run, 1, "kling"));
  }

  #newJob(avatarId: string, kind: Job["kind"], phase: ClipPhase = "preparing", total: number = CLIP_JOB_STEPS, clipId?: string): Job {
    const jobId = this.#host.nextId("job");
    const job: Job = { jobId, avatarId, clipId: clipId ?? jobId, kind, status: "running", phase, done: 0, total, timers: [], moneyClosed: false, queued: false, claimed: null };
    this.#jobs.set(jobId, job);
    return job;
  }

  #after(job: Job | null, ms: number, fn: () => void): void {
    const due = this.#host.clockMs() + ms;
    const cancel = this.#host.scheduler.schedule(ms, () => {
      this.#host.setClockAtLeast(due);
      fn();
    });
    job?.timers.push(cancel);
  }

  #progress(job: Job, update: { phase: ClipPhase; model?: AttemptModel; submittedAt?: string; proveUntil?: string; done?: number; waitReason?: WaitReason }): void {
    if (job.status !== "running") return;
    job.phase = update.phase;
    job.model = update.model;
    job.submittedAt = update.submittedAt;
    job.proveUntil = update.phase === "proving" ? update.proveUntil : undefined;
    // What a batch member waits for is replaced by each update, like the model (engine/jobs.ts `clipPhase`); a member in the proof window waits for the strict proof (engine/clips/job.ts `attemptPhase`).
    job.waitReason = update.waitReason ?? (job.batch !== undefined && update.phase === "proving" ? "proof" : undefined);
    if (job.facts !== undefined) {
      const open = this.#lines.filter((l) => l.clipId === job.clipId && l.state === "open").reduce((sum, l) => sum + l.worstMicros, 0);
      job.openReserveMicros = open > 0 ? open : undefined;
    }
    job.done = Math.min(job.total, Math.max(job.done, update.done ?? job.done));
    this.#host.emit({ v: PROTOCOL_VERSION, id: this.#host.nextId("evt"), kind: "event", type: "job.progress", payload: this.#progressOf(job) });
  }

  #progressOf(job: Job): JobProgress {
    return {
      kind: "clip",
      jobId: job.jobId,
      avatarId: job.avatarId,
      clipId: job.clipId,
      done: job.done,
      total: job.total,
      phase: job.phase,
      ...jobFactsOf(job),
      ...jobBatchOf(job),
      ...(job.model === undefined ? {} : { model: job.model }),
      ...(job.submittedAt === undefined ? {} : { submittedAt: job.submittedAt }),
      ...(job.proveUntil === undefined ? {} : { proveUntil: job.proveUntil }),
    };
  }

  /** Ends a job and tells the windows. A done job is at its full count and carries its clip. A cancelled batch member says why (`detail`). */
  #finish(job: Job, end: { status: "done"; exported?: { relPath: string } } | { status: "failed"; error: EngineError } | { status: "cancelled"; detail?: ClipCancelDetail }): void {
    if (job.status !== "running") return;
    // 5b.2 (S5.WB2c): a member whose turn came tells its summary how it ended, before its end is announced (engine `#runJob`): as its record says, failed with no record, cancelled by the owner before
    // its POST. A stop of the process tells nothing (a restart's pass decides).
    if (job.member !== undefined && job.ran === true && job.batch !== undefined) {
      const at = { index: job.batch.batchIndex, clipId: job.clipId };
      const record = this.#records.get(job.clipId);
      if (end.status === "done") this.#noteBatch(job.batch.batchId, { kind: "ended", ...at, outcome: record === undefined ? "failed" : clipBatchOutcomeOf(record.outcome) });
      else if (end.status === "failed") this.#noteBatch(job.batch.batchId, { kind: "ended", ...at, outcome: "failed" });
      else if (end.detail !== undefined) this.#noteBatch(job.batch.batchId, { kind: "cancelled", ...at, detail: end.detail });
    }
    for (const cancel of job.timers) cancel();
    job.timers = [];
    const ref = { kind: "clip" as const, jobId: job.jobId, avatarId: job.avatarId, clipId: job.clipId };
    const v = PROTOCOL_VERSION;
    if (end.status === "done") {
      job.status = "done";
      job.done = job.total;
      job.result = { kind: "clip", avatarId: job.avatarId, clipId: job.clipId, ...(end.exported === undefined ? {} : { exported: { relPath: end.exported.relPath } }) };
      this.#host.emit({ v, id: this.#host.nextId("evt"), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: job.result } });
    } else if (end.status === "failed") {
      job.status = "failed";
      job.error = end.error;
      this.#host.emit({ v, id: this.#host.nextId("evt"), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
    } else {
      job.status = "cancelled";
      if (end.detail !== undefined) job.detail = end.detail;
      this.#host.emit({ v, id: this.#host.nextId("evt"), kind: "event", type: "job.cancelled", payload: end.detail === undefined ? ref : { ...ref, detail: end.detail } });
    }
  }

  /**
   * Every reserve of the clip is settled or abandoned (or none was made): a single clip gives the unit back, once; a batch member then tells its batch how its money ended (`end`; absent when the machine never
   * ran), which decides the next turn and the stops. Synchronous, so a stop or a requeue exists before the member's own `job.done` is announced.
   */
  #closeMoney(job: Job, end?: MockMoneyEnd): void {
    if (job.moneyClosed) return;
    job.moneyClosed = true;
    this.#caps.delete(job.clipId);
    if (this.#unit?.kind === "clip" && this.#unit.job === job) this.#unit = null;
    this.#host.emitMoney();
    job.member?.batch.closed(job.member.ref, end);
  }

  // ---------- the money state machine of one attempt (engine/clips/attempt.ts) ----------

  #attempt(run: CreateRun, n: 1 | 2, model: AttemptModel): void {
    const { job, request } = run;
    if (job.status !== "running") return;
    const host = this.#host;
    const tier = model === "grok" ? "grok" : request.quality;
    const reserveMicros = clipReserveMicros(run.rates[tier], request.seconds);
    const clipId = job.clipId;
    // The budget's `blocked` comes before its limits (engine/money/budget.ts): a halted ledger, or reserves that wait for a reconcile, refuse the reserve with nothing sent.
    const blocked = host.reserveRefusal();
    if (blocked !== null) {
      this.#closeMoney(job, { kind: "not-reserved", reason: blocked.code === "RECONCILE_REQUIRED" ? "RECONCILE_REQUIRED" : "HALTED" });
      if (n === 2) {
        // engine/clips/job.ts `not-reserved` after a free refusal: Kling settled 0 and Grok could not even be reserved (for a reason that is not room): the clip ends free as Kling's refusal, and the money status tells.
        host.emitMoney();
        this.#fail(run, request.model, "refused-free");
        return;
      }
      this.#dropJournal(clipId);
      this.#finish(job, { status: "failed", error: blocked });
      return;
    }
    // A batch member plays the batch's next script from its first reserve on: its POST is about to leave (a member that fails before it takes none, as the real provider is asked for none).
    if (n === 1 && run.takesBatchScript === true && !this.#fates.has(clipId)) {
      run.script = this.#batchPlay.shift() ?? { first: "ok", then: "ok", face: undefined };
      this.#fates.set(clipId, run.script);
    }
    const scripted = n === 1 ? run.script.first : run.script.then;
    // The attempt's own month hold, if it has one, is what this reserve replaces: it is not counted twice (`Budget.tryReserve`).
    const refusedByMonth = (n === 2 && scripted === "no-room") || !this.#fits(reserveMicros, attemptIdOf(clipId, n));
    if (refusedByMonth) {
      if (n === 2) {
        this.#closeMoney(job, { kind: "failed", reason: "grok-no-room", aboveWorst: false });
        this.#commit(run, { model: "grok", attempts: this.#attemptsOf(clipId), outcome: { status: "failed", reason: "grok-no-room" } });
        return;
      }
      this.#closeMoney(job, { kind: "not-reserved", reason: "BUDGET_EXCEEDED" });
      this.#dropJournal(clipId);
      this.#finish(job, { status: "failed", error: { code: "BUDGET_EXCEEDED", detail: `committed ${this.#committed()} µ$ + the clip's ${reserveMicros} µ$ > the limit ${host.monthlyBudgetMicros()} µ$; nothing was sent` } });
      return;
    }
    if (n === 1) {
      this.#journal(clipId, { type: "requested", clipId, photoId: run.photoId, request, motion: run.motion, acceptedWorstMicros: run.accepted, ...(job.batch === undefined ? {} : { batch: { ...job.batch } }), at: run.createdAt });
      this.#files.set(clipId, { journal: true, record: false, media: false });
    }
    const line = this.#reserve(clipId, n, model, reserveMicros);
    this.#hold(line.attemptId, this.#t.holdUncertainMs);
    if (this.#otherMoneyOpen(line.attemptId)) this.#crowdedAtBaseline.add(line.attemptId);
    this.#progress(job, { phase: "submitting", model });
    // The money state machine throws after the reserve: whether anything is open is not known (the journal stays, the reserve is left to the reconcile).
    if (scripted === "fault") {
      this.#after(job, host.stepMs, () => {
        line.inFlight = false;
        this.#closeMoney(job, { kind: "fault" });
        this.#finish(job, { status: "failed", error: { code: "INTERNAL", detail: "the clip's money path failed" } });
      });
      return;
    }
    // An unreadable `/credits` (`refused-uncounted`) is read three times, 5 s apart, for the net-usage baseline BEFORE the POST (engine/clips/attempt.ts): the send leaves 10 s later.
    const baselinePauses = scripted === "refused-uncounted" ? (PROOF_READ_TRIES - 1) * this.#t.proofRetryMs : 0;
    this.#after(job, host.stepMs + baselinePauses, () => this.#post(run, n, model, line, scripted));
  }

  #post(run: CreateRun, n: 1 | 2, model: AttemptModel, line: Line, scripted: MockClipAttempt): void {
    const { job, request } = run;
    const host = this.#host;
    const seconds = request.seconds;
    const tier = model === "grok" ? "grok" : request.quality;
    const billed = clipBilledMicros(run.rates[tier], seconds);
    const attemptId = line.attemptId;
    const ended = (status: Extract<MockJournalLine, { type: "ended" }>["status"], costSource: Extract<MockJournalLine, { type: "ended" }>["costSource"], providerCostMicros?: number): void =>
      this.#journal(job.clipId, { type: "ended", attemptId, status, costSource, ...(providerCostMicros === undefined ? {} : { providerCostMicros }), at: iso(host.clockMs()) });

    // ----- refused at the POST: no job exists, nothing is billed -----
    const submitFailures: Partial<Record<MockClipAttempt, "rate-limited" | "key-invalid" | "no-credits" | "bad-request">> = { "rate-limited": "rate-limited", "bad-request": "bad-request", "key-invalid": "key-invalid", "no-credits": "no-credits" };
    if (scripted === "refused-submit" || submitFailures[scripted] !== undefined) {
      this.#posts.push(model);
      this.#settle(line, 0, false);
      this.#release(attemptId);
      const content = scripted === "refused-submit";
      this.#journal(job.clipId, { type: "ended", attemptId, status: content ? "refused" : "failed", costSource: "none", ...(content ? {} : { failReason: submitFailures[scripted] ?? "bad-request" }), at: iso(host.clockMs()) });
      this.#attemptsDone(job.clipId, { attemptId, model, outcome: content ? "refused" : "failed", costSource: "none" });
      if (content) return this.#afterFreeRefusal(run, n);
      if (scripted === "key-invalid") host.markKeyRejected();
      return this.#fail(run, model, submitFailures[scripted] ?? "bad-request");
    }
    if (scripted === "uncertain") {
      this.#posts.push(model);
      // Abandoned: the reserve stays open at worst, held by its hold. The journal gets NO `ended` line, as the engine's (attempt.ts): a restart would read one as «ended: held 2 min».
      line.inFlight = false;
      this.#attemptsDone(job.clipId, { attemptId, model, outcome: "uncertain", costSource: "none" });
      return this.#fail(run, model, "submit-uncertain");
    }

    // ----- accepted -----
    this.#posts.push(model);
    const providerJobId = `prov-${job.clipId}-${n}`;
    const submittedMs = host.clockMs();
    this.#journal(job.clipId, { type: "submitted", attemptId, model, providerJobId, at: iso(submittedMs) });
    this.#hold(attemptId, this.#t.holdSubmittedMs);
    this.#progress(job, { phase: "rendering", model, submittedAt: iso(submittedMs) });

    if (scripted === "late" || scripted === "late-ok") {
      this.#after(job, this.#t.lifetimeMs, () => this.#late(run, model, line, scripted, providerJobId, submittedMs, billed));
      return;
    }
    this.#after(job, this.#t.pollMs * 3, () => this.#terminal(run, n, model, line, scripted, providerJobId, billed));
  }

  #terminal(run: CreateRun, n: 1 | 2, model: AttemptModel, line: Line, scripted: MockClipAttempt, providerJobId: string, billed: number): void {
    const { job } = run;
    const host = this.#host;
    const attemptId = line.attemptId;
    const ended = (status: Extract<MockJournalLine, { type: "ended" }>["status"], costSource: Extract<MockJournalLine, { type: "ended" }>["costSource"], providerCostMicros?: number): void =>
      this.#journal(job.clipId, { type: "ended", attemptId, status, costSource, ...(providerCostMicros === undefined ? {} : { providerCostMicros }), at: iso(host.clockMs()) });
    this.#hold(attemptId, this.#t.holdTerminalMs);

    // ----- completed -----
    const completes: MockClipAttempt[] = ["ok", "ok-uncosted", "ok-above-worst", "download-failed", "invalid-file", "disk-full"];
    if (completes.includes(scripted)) {
      const uncosted = scripted === "ok-uncosted";
      // 5b.2: a bill above the reserve is recorded, and the ledger halts (`SETTLE_ABOVE_WORST`); the clip is still delivered (engine/clips/attempt.ts, `aboveWorst`).
      const above = scripted === "ok-above-worst";
      const cost = above ? line.worstMicros + 1 : billed;
      const settleAndDeliver = (): void => {
        this.#settle(line, uncosted ? line.worstMicros : cost, uncosted);
        ended("completed", uncosted ? "worst" : "usage", uncosted ? undefined : cost);
        this.#attemptsDone(job.clipId, { attemptId, model, providerJobId, outcome: "completed", ...(uncosted ? {} : { providerCostMicros: cost }), costSource: uncosted ? "worst" : "usage" });
        this.#completedHolds.add(attemptId);
        if (above) host.haltLedger();
        this.#closeMoney(job, { kind: "completed", aboveWorst: above });
        this.#deliver(run, model, scripted);
      };
      // engine/clips/attempt.ts `settleCompleted`: a poll with no usage asks `/generation` 15 s after the status, and a record not there yet is read again (three reads, 5 s apart): only then is the worst booked.
      if (uncosted) this.#after(job, this.#t.proofFirstReadMs + (PROOF_READ_TRIES - 1) * this.#t.proofRetryMs, settleAndDeliver);
      else settleAndDeliver();
      return;
    }

    // ----- failed: the proof window -----
    const content = scripted === "refused-free" || scripted === "refused-paid" || scripted === "refused-unknown" || scripted === "refused-uncounted";
    const proveUntil = iso(host.clockMs() + this.#t.proofSecondReadMs);
    this.#progress(job, { phase: "proving", model, proveUntil });
    const freeScripted = scripted === "refused-free" || scripted === "provider-error";
    const paid = scripted === "refused-paid" || scripted === "provider-error-paid";
    // engine/clips/attempt.ts `prove`: a `/generation` record that bills ends the proof at its FIRST reading (15 s); every other proof goes through the second (2 min) and the net-usage check.
    // ...and the same three reads after the second `/generation` one: the check that cannot count settles 10 s after it.
    const checkPauses = scripted === "refused-uncounted" ? (PROOF_READ_TRIES - 1) * this.#t.proofRetryMs : 0;
    this.#after(job, paid ? this.#t.proofFirstReadMs : this.#t.proofSecondReadMs + checkPauses, () => {
      // engine/clips/attempt.ts `prove`: the check counts only if nothing but this attempt was open or held at the baseline AND is at the second read; else the refusal is not proven free.
      const free = freeScripted && !this.#crowdedAtBaseline.has(attemptId) && !this.#otherMoneyOpen(attemptId);
      if (free) this.#settle(line, 0, false);
      else if (paid) this.#settle(line, billed, false);
      else this.#settle(line, line.worstMicros, true);
      const outcome = content ? "refused" : "failed";
      const costSource = free ? "proof" : paid ? "generation" : "worst";
      ended(outcome, costSource, paid ? billed : undefined);
      this.#attemptsDone(job.clipId, { attemptId, model, providerJobId, outcome, ...(paid ? { providerCostMicros: billed } : {}), costSource });
      if (content && free) return this.#afterFreeRefusal(run, n);
      const reason: ClipFailReason = content ? (paid ? "refused-paid" : "refused-unknown") : "provider-error";
      this.#fail(run, model, reason);
    });
  }

  #late(run: CreateRun, model: AttemptModel, line: Line, scripted: MockClipAttempt, providerJobId: string, submittedMs: number, billed: number): void {
    const { job } = run;
    const host = this.#host;
    // I5.48: no terminal status 20 min after the submit. The reserve stays open at worst (abandoned); a late `completed` writes no ledger line.
    line.inFlight = false;
    this.#attemptsDone(job.clipId, { attemptId: line.attemptId, model, providerJobId, outcome: "late", costSource: "none" });
    this.#progress(job, { phase: "late", model, submittedAt: iso(submittedMs) });
    this.#closeMoney(job, { kind: "late" });
    const t = this.#t;
    if (scripted === "late-ok") {
      this.#after(job, t.latePollMs * 2, () => {
        this.#journal(job.clipId, { type: "ended", attemptId: line.attemptId, status: "completed", costSource: "none", providerCostMicros: billed, at: iso(host.clockMs()) });
        this.#hold(line.attemptId, t.holdTerminalMs);
        const attempt = this.#attemptList(job.clipId).find((a) => a.attemptId === line.attemptId);
        if (attempt !== undefined) Object.assign(attempt, { outcome: "completed", costSource: "none", providerCostMicros: billed });
        this.#deliver(run, model, "ok");
      });
      return;
    }
    this.#after(job, t.lateGiveUpMs - t.lifetimeMs, () => {
      this.#journal(job.clipId, { type: "ended", attemptId: line.attemptId, status: "late", costSource: "none", at: iso(host.clockMs()) });
      this.#commit(run, { model, attempts: this.#attemptsOf(job.clipId), outcome: { status: "failed", reason: "late" } });
    });
  }

  /** A content refusal settled 0 (I5.47): Grok by itself (mode auto), the offer (mode offer, a second click) or nothing. */
  #afterFreeRefusal(run: CreateRun, n: 1 | 2): void {
    const { request, facts } = run;
    if (n === 2) return this.#fail(run, "grok", "refused-both");
    const parts = { model: request.model, mode: run.mode, fallback: request.fallback, bold: facts.bold, boldClips: this.#boldClips };
    if (clipAllowsAutoGrok(parts)) {
      this.#attempt(run, 2, "grok");
      return;
    }
    this.#fail(run, request.model, "refused-free");
  }

  /** The clip ends here with a failure the record says: the money is closed first, and nothing more is sent. */
  #fail(run: CreateRun, model: AttemptModel, reason: ClipFailReason): void {
    this.#closeMoney(run.job, { kind: "failed", reason, aboveWorst: false });
    this.#commit(run, { model, attempts: this.#attemptsOf(run.job.clipId), outcome: { status: "failed", reason } });
  }

  // ---------- the file: download, check, save ----------

  #deliver(run: CreateRun, model: AttemptModel, scripted: MockClipAttempt): void {
    const { job, request } = run;
    const step = this.#host.stepMs;
    this.#progress(job, { phase: "downloading", model, done: 1 });
    const failure = DOWNLOAD_FAILURES[scripted];
    if (failure !== undefined) {
      this.#after(job, step, () => {
        const submitted = this.#submittedAt(job.clipId, model);
        this.#commit(run, { model, attempts: this.#attemptsOf(job.clipId), outcome: { status: "failed", reason: failure, ...(submitted === null ? {} : { retryDownloadUntil: iso(Date.parse(submitted) + this.#t.lateGiveUpMs) }) } });
      });
      return;
    }
    this.#after(job, step, () => {
      const size = sizeOf(model, request.quality);
      this.#journal(job.clipId, { type: "downloaded", sha256: fakeSha(job.clipId), bytes: 1_000_000 * request.seconds, at: iso(this.#host.clockMs()) });
      this.#progress(job, { phase: "checking", model, done: 2 });
      this.#after(job, step, () => {
        this.#progress(job, { phase: "saving", model, done: 3 });
        this.#after(job, step, () => {
          const face = this.#faceOf(run.facts, run.script.face, request.seconds);
          this.#commit(run, { model, attempts: this.#attemptsOf(job.clipId), outcome: { status: "ready", ...size, durationMs: request.seconds * 1_000, face } });
        });
      });
    });
  }

  #faceOf(facts: Facts, script: MockClipFace | undefined, seconds: ClipSeconds): ClipFace {
    if (!facts.judged) return { verdict: "skipped", frames: 0, why: "hidden" };
    const frames = seconds * 2;
    switch (script ?? "match") {
      case "match":
        return { verdict: "match", p75: 0.86, frames };
      case "mismatch":
        return { verdict: "mismatch", p75: 0.41, frames };
      case "few-faces":
        return { verdict: "skipped", frames: 2, why: "few-faces" };
      case "worker":
        return { verdict: "skipped", frames: 0, why: "worker" };
    }
  }

  #submittedAt(clipId: string, model: AttemptModel): string | null {
    const submitted = (this.#journals.get(clipId) ?? []).findLast((l) => l.type === "submitted" && l.model === model);
    return submitted?.type === "submitted" ? submitted.at : null;
  }

  // ---------- the attempts a record keeps ----------

  #attemptList(clipId: string): RecordAttempt[] {
    let list = this.#attemptsByClip.get(clipId);
    if (list === undefined) {
      list = [];
      this.#attemptsByClip.set(clipId, list);
    }
    return list;
  }

  #attemptsDone(clipId: string, attempt: RecordAttempt): void {
    const list = this.#attemptList(clipId);
    const at = list.findIndex((a) => a.attemptId === attempt.attemptId);
    if (at >= 0) list[at] = attempt;
    else list.push(attempt);
  }

  #attemptsOf(clipId: string): RecordAttempt[] {
    return this.#attemptList(clipId).map((a) => ({ ...a }));
  }

  // ---------- the journal and the record ----------

  #journal(clipId: string, line: MockJournalLine): void {
    const lines = this.#journals.get(clipId) ?? [];
    this.#journals.set(clipId, [...lines, line]);
    this.#journalWrites.set(clipId, [...(this.#journalWrites.get(clipId) ?? []), line]);
  }

  #dropJournal(clipId: string): void {
    this.#journals.delete(clipId);
    this.#files.delete(clipId);
  }

  /** The record is the commit (I5.53); the journal goes once it stands. Then the job ends and the clip is an ordinary record. */
  #commit(run: CreateRun, parts: { model: AttemptModel; attempts: RecordAttempt[]; outcome: ClipOutcome }): void {
    const { job, request } = run;
    const record: MockClipRecord = {
      id: job.clipId,
      avatarId: job.avatarId,
      photoId: run.photoId,
      createdAt: run.createdAt,
      seen: false,
      motion: run.motion,
      request,
      model: modelUsed(parts.model, request),
      attempts: parts.attempts,
      recovered: false,
      exports: [],
      outcome: parts.outcome,
      ...(job.batch === undefined ? {} : { batch: { ...job.batch } }),
    };
    this.#records.set(record.id, record);
    this.#journals.delete(record.id);
    this.#files.set(record.id, { journal: false, record: true, media: parts.outcome.status === "ready" });
    this.#closeMoney(job);
    this.#finish(job, { status: "done" });
  }

  // ---------- summaries ----------

  #summary(record: MockClipRecord, withStates: boolean): ClipSummary {
    const cost = this.#costOf(record.id);
    const providerCosts = record.attempts.flatMap((a) => (a.providerCostMicros === undefined ? [] : [a.providerCostMicros]));
    const common = {
      clipId: record.id,
      avatarId: record.avatarId,
      photoId: record.photoId,
      createdAt: record.createdAt,
      seen: record.seen,
      motion: record.motion,
      request: record.request,
      model: record.model,
      fallback: record.attempts.some((a) => a.attemptId.endsWith("#2")),
      recovered: record.recovered,
      cost,
      // 5b.2 (L9): a batch member tells its trio, all three or none, so the header survives `KEEP_FINISHED` and a restart.
      ...(record.batch === undefined ? {} : { batchId: record.batch.batchId, batchIndex: record.batch.batchIndex, batchSize: record.batch.batchSize }),
      ...(providerCosts.length === 0 ? {} : { providerCostMicros: providerCosts.reduce((sum, micros) => sum + micros, 0) }),
      exports: record.exports.map((line, i): ClipExport => (withStates ? { ...line, fileState: this.#fileStateOf(record.id, i, line) } : { ...line })),
    };
    const { outcome } = record;
    if (outcome.status === "ready") {
      // 5b.2 (Q-F = 1): what uses a ready clip; a clip nothing uses has none.
      const use = this.#host.use(record.avatarId, record.id, record.photoId);
      return { ...common, status: "ready", width: outcome.width, height: outcome.height, durationMs: outcome.durationMs, face: outcome.face, ...(use === undefined ? {} : { use }) };
    }
    const offer = this.#grokOffer(record);
    return { ...common, status: "failed", failure: { reason: outcome.reason, ...(offer === null ? {} : { grokOffer: offer }) }, ...(outcome.retryDownloadUntil === undefined ? {} : { retryDownloadUntil: outcome.retryDownloadUntil }) };
  }

  /** The tile's «Снять на Grok · до $0.85» (I5.47): mode `offer` only, on a Kling clip refused for free whose request kept its fallback. */
  #grokOffer(record: MockClipRecord): Estimate | null {
    if (this.#mode !== "offer" || record.outcome.status !== "failed" || record.outcome.reason !== "refused-free" || record.request.model !== "kling" || record.request.fallback !== "auto") return null;
    const book = this.#readBook();
    return book === null ? null : this.#estimate({ model: "grok", quality: "std", seconds: record.request.seconds, fallback: "none", bold: false }, book);
  }

  #fileStateOf(clipId: string, index: number, line: ClipExportLine): FileState {
    const tampered = this.#exportStates.get(`${clipId}:${index}`);
    if (tampered !== undefined) return tampered;
    const host = this.#host;
    if (!host.exportOk() || line.rootId !== host.exportRootId()) return "elsewhere";
    return "present";
  }

  // ---------- clips.list, get, markSeen, delete ----------

  #recordOf(avatarId: string, clipId: string): Out<MockClipRecord> {
    const avatar = this.#host.avatar(avatarId);
    if (avatar === undefined || this.#host.deletePending(avatarId)) return bad({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    const record = this.#records.get(clipId);
    if (record === undefined || record.avatarId !== avatarId) return bad({ code: "NOT_FOUND", detail: `no clip ${clipId} in this avatar's clips` });
    return good(record);
  }

  list(payload: CommandPayload<"clips.list">): Out<{ clips: ClipSummary[]; notListedTotal?: number; batches?: ClipBatchSummary[] }> {
    const avatar = this.#host.avatar(payload.avatarId);
    if (avatar === undefined || this.#host.deletePending(payload.avatarId)) return bad({ code: "NOT_FOUND", detail: `no avatar ${payload.avatarId} in the open library` });
    const mine = [...this.#records.values()].filter((r) => r.avatarId === payload.avatarId);
    mine.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const shown = mine.slice(0, MAX_LISTED_CLIPS);
    const clips = shown.map((r) => this.#summary(r, false));
    // A journal beside a committed record is a leftover of a clip that finished: removed unless a job still works on that clip.
    for (const record of shown) {
      const files = this.#files.get(record.id);
      if (files?.journal === true && !this.#busyClip(record.id)) {
        files.journal = false;
        this.#journals.delete(record.id);
      }
    }
    const left = mine.length - shown.length;
    // 5b.2 (S5.WB2c): the avatar's batch summaries, newest first, each member with the ledger's money now and the batch's one total.
    const batches = newestFirst([...this.#summaries.values()].filter((state) => state.avatarId === payload.avatarId))
      .slice(0, MAX_LISTED_BATCHES)
      .map((state) => batchSummaryOf(state, this.#costsOf(state)));
    return good({ clips, ...(left === 0 ? {} : { notListedTotal: left }), ...(batches.length === 0 ? {} : { batches }) });
  }

  get(payload: CommandPayload<"clips.get">): Out<{ clip: ClipSummary }> {
    const found = this.#recordOf(payload.avatarId, payload.clipId);
    if (!found.ok) return found;
    return good({ clip: this.#summary(found.result, true) });
  }

  markSeen(payload: CommandPayload<"clips.markSeen">): Out<{ clipId: string }> {
    const found = this.#recordOf(payload.avatarId, payload.clipId);
    if (!found.ok) return found;
    found.result.seen = true;
    return good({ clipId: payload.clipId });
  }

  /** An import holds the clip, or a job works on it. A batch member still waiting for its turn is not working on anything yet (engine/clips/service.ts: its clip id enters the active set when its turn comes). */
  #busyClip(clipId: string): boolean {
    return this.#importing.has(clipId) || [...this.#jobs.values()].some((j) => j.status === "running" && j.clipId === clipId && !(j.member !== undefined && j.phase === "queued"));
  }

  delete(payload: CommandPayload<"clips.delete">): Out<{ clipId: string }> {
    const { clipId } = payload;
    const avatar = this.#host.avatar(payload.avatarId);
    if (avatar === undefined || this.#host.deletePending(payload.avatarId)) return bad({ code: "NOT_FOUND", detail: `no avatar ${payload.avatarId} in the open library` });
    if (this.#busyClip(clipId)) return bad({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
    const found = this.#recordOf(payload.avatarId, clipId);
    if (!found.ok) return found;
    const fault = this.#failDelete;
    this.#failDelete = null;
    // The journal first, then the record (the commit), then the media: a record-less journal would be recovered as a live clip, so the journal never outlives the record.
    // 5b.2 (I5.59): the clip's montage copy goes FIRST; a render that holds it refuses the whole delete with nothing removed.
    if (this.#host.removeCopies(payload.avatarId, clipId) === "in-use") return bad({ code: "IN_FLIGHT", clipReason: "in-use", detail: `a render holds the montage copy of clip ${clipId}` });
    if (fault === "journal") return bad({ code: "INTERNAL", detail: "the clip's journal could not be removed" });
    this.#journals.delete(clipId);
    const files = this.#files.get(clipId);
    if (files !== undefined) files.journal = false;
    if (fault === "record") return bad({ code: "INTERNAL", detail: "the clip's record could not be removed" });
    this.#records.delete(clipId);
    this.#files.delete(clipId);
    return good({ clipId });
  }

  // ---------- the clip as the montage copies need it (5b.2, S5.WA3; append-only block) ----------

  /** What `media.importClip` reads of the clip's committed record: NOT_FOUND for an avatar that is not in the library or is being deleted, and for a clip the avatar does not have. */
  copySource(avatarId: string, clipId: string): Out<{ photoId: string; createdAt: string; ready: { width: number; height: number; durationMs: number } | null }> {
    const found = this.#recordOf(avatarId, clipId);
    if (!found.ok) return found;
    const { photoId, createdAt, outcome } = found.result;
    return good({ photoId, createdAt, ready: outcome.status === "ready" ? { width: outcome.width, height: outcome.height, durationMs: outcome.durationMs } : null });
  }

  /** Whether the file of a clip is no longer the one its record names. */
  fileDamaged(clipId: string): boolean {
    return this.#damaged.has(clipId);
  }

  /** A test says the clip's file in Studio was replaced by another (the next `media.importClip` meets `file-damaged`). */
  damageFile(clipId: string): void {
    this.#damaged.add(clipId);
  }

  /** The clip's lock for an import: busy (a delete, an export and a second import answer `job-running`) until the returned release is called. */
  holdForImport(avatarId: string, clipId: string): () => void {
    this.#importing.set(clipId, avatarId);
    return () => void this.#importing.delete(clipId);
  }

  /** Whether the clip is held by an import, or by any job of the clip (an import is refused as `job-running` for either). */
  busyForImport(clipId: string): boolean {
    return this.#busyClip(clipId);
  }

  /** A clip import of this avatar runs: its delete waits (the import job has no avatar of its own in the job list). */
  importingFor(avatarId: string): boolean {
    return [...this.#importing.values()].includes(avatarId);
  }

  // ---------- clips.retryDownload ----------

  retryDownload(payload: CommandPayload<"clips.retryDownload">): Out<{ jobId: string }> {
    const { avatarId, clipId } = payload;
    const avatar = this.#host.avatar(avatarId);
    if (avatar === undefined || this.#host.deletePending(avatarId)) return bad({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    if (this.#busyClip(clipId)) return bad({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
    const found = this.#recordOf(avatarId, clipId);
    if (!found.ok) return found;
    const record = found.result;
    const { outcome } = record;
    if (outcome.status !== "failed") return bad({ code: "VALIDATION", detail: "only a clip whose download failed can be fetched again" });
    if (outcome.reason === "download-expired") return bad({ code: "VALIDATION", clipReason: "download-expired", detail: "the file is no longer at the provider" });
    if (!CLIP_RETRYABLE_FAILURES.includes(outcome.reason)) return bad({ code: "VALIDATION", detail: `a clip that ended ${outcome.reason} has no file to fetch again` });
    const until = outcome.retryDownloadUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(outcome.retryDownloadUntil);
    if (!(this.#host.clockMs() <= until)) {
      record.outcome = { status: "failed", reason: "download-expired" };
      return bad({ code: "VALIDATION", clipReason: "download-expired", detail: "the file is no longer at the provider" });
    }
    // The key is looked up after the record is judged and before a job exists (`usableKey("fetch a finished clip again")`); the fetch is free, so the ledger is not asked.
    const keyless = this.#host.keyGate();
    if (keyless !== null) return bad(keyless);
    const model: AttemptModel = record.model === "grok" ? "grok" : "kling";
    const job = this.#newJob(avatarId, "retry", "downloading", CLIP_JOB_STEPS, clipId);
    const result = this.#retryResult ?? "ok";
    this.#retryResult = null;
    const step = this.#host.stepMs;
    this.#progress(job, { phase: "downloading", model, done: 1 });
    {
      this.#after(job, step, () => {
        if (result === "gone") {
          record.outcome = { status: "failed", reason: "download-expired" };
          this.#finish(job, { status: "done" });
          return;
        }
        if (result === "failed") {
          this.#finish(job, { status: "failed", error: { code: "NETWORK", detail: "the clip's file could not be fetched" } });
          return;
        }
        this.#progress(job, { phase: "checking", model, done: 2 });
        this.#after(job, step, () => {
          this.#progress(job, { phase: "saving", model, done: 3 });
          this.#after(job, step, () => {
            const size = sizeOf(model, record.request.quality);
            record.outcome = { status: "ready", ...size, durationMs: record.request.seconds * 1_000, face: this.#faceOf({ bold: false, judged: true, ageRefused: false }, undefined, record.request.seconds) };
            this.#files.set(clipId, { journal: false, record: true, media: true });
            this.#noteMemberRecord(record);
            this.#finish(job, { status: "done" });
          });
        });
      });
    }
    return good({ jobId: job.jobId });
  }

  // ---------- cancel (avatars.cancel) ----------

  owns(jobId: string): boolean {
    return this.#jobs.has(jobId);
  }

  cancel(jobId: string): Out<{ jobId: string }> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return bad({ code: "NOT_FOUND", detail: `no clip job ${jobId} in this engine` });
    if (job.status !== "running") return good({ jobId });
    if (job.kind === "export") {
      this.#cancelExport(job);
      return good({ jobId });
    }
    if (job.kind === "recovery") return bad({ code: "IN_FLIGHT", clipReason: "job-running", detail: "the clip is being recovered after a restart; it cannot be cancelled" });
    // 5b.2 (I5.63): a batch member still waiting for its turn is cancelled alone, free; the rest of the batch goes on.
    if (job.phase === "queued" && job.member?.batch.cancelMember(jobId) === true) return good({ jobId });
    if (job.phase !== "preparing") return bad({ code: "IN_FLIGHT", clipReason: "submitted", detail: "the clip has already been sent; it cannot be cancelled" });
    // A batch member the owner cancelled before its POST says so (engine/clips/service.ts `#endOf`).
    this.#finish(job, job.member === undefined ? { status: "cancelled" } : { status: "cancelled", detail: "cancelled" });
    this.#closeMoney(job);
    return good({ jobId });
  }

  // ---------- clips.export (engine/clips/export.ts) ----------

  export(payload: CommandPayload<"clips.export">): Out<{ jobId: string }> {
    const { avatarId, clipId } = payload;
    const found = this.#recordOf(avatarId, clipId);
    if (!found.ok) return found;
    const record = found.result;
    if (record.outcome.status !== "ready") return bad({ code: "VALIDATION", clipReason: "not-ready", detail: `clip ${clipId} has no file to save` });
    if (this.#busyClip(clipId)) return bad({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
    const durationMs = record.outcome.durationMs;
    const reason = this.#host.checkExport(Math.ceil(((durationMs / 1000) * 12_000_000 * 1.25) / 8) + 64 * 1024 * 1024);
    if (reason !== null) return bad({ code: "EXPORT_UNAVAILABLE", exportReason: reason, detail: "the export folder cannot take the clip" });
    const total = Math.max(1, Math.round((durationMs / 1000) * (this.#exportFps === "native24" ? 24 : 30)));
    const job = this.#newJob(avatarId, "export", "exporting", total, clipId);
    job.queued = true;
    this.#exportQueue.push(job);
    if (this.#exportRunning === null) this.#nextExport();
    return good({ jobId: job.jobId });
  }

  #nextExport(): void {
    const job = this.#exportQueue.shift();
    if (job === undefined) {
      this.#exportRunning = null;
      return;
    }
    this.#exportRunning = job;
    job.queued = false;
    this.#progress(job, { phase: "exporting", done: 0 });
    const result = this.#exportResult ?? "ok";
    this.#exportResult = null;
    const step = this.#host.stepMs;
    const marks = [0.25, 0.5, 0.75];
    marks.forEach((mark, i) => {
      this.#after(job, step * (i + 1), () => {
        // The damaged file stops the job at its first step, after the 0 and before any frame (engine/clips/export.ts, step 2 before the encode); a failed encode is halfway.
        const stop = result === "damaged" && i === 0 ? CLIP_FILE_DAMAGED_DETAIL : result === "fail" && i === 1 ? "the clip could not be encoded" : null;
        if (stop !== null) {
          this.#finish(job, { status: "failed", error: { code: "INTERNAL", detail: stop } });
          this.#exportRunning = null;
          this.#nextExport();
          return;
        }
        this.#progress(job, { phase: "exporting", done: Math.floor(job.total * mark) });
      });
    });
    this.#after(job, step * (marks.length + 1), () => this.#claimExport(job));
  }

  /** The claim of the copy's name (engine/clips/export.ts, the root lock): the point of no return. A cancel before it ends the export; from it on the export runs to its record. */
  #claimExport(job: Job): void {
    const record = this.#records.get(job.clipId);
    const avatar = this.#host.avatar(job.avatarId);
    if (record === undefined || avatar === undefined || record.outcome.status !== "ready") {
      this.#finish(job, { status: "failed", error: { code: "INTERNAL", detail: "the clip is no longer ready" } });
      this.#exportRunning = null;
      this.#nextExport();
      return;
    }
    const host = this.#host;
    const at = host.nowIso();
    const named = [...this.#records.values()].flatMap((r) => r.exports.map((e) => e.relPath));
    const relPath = host.exportRelPath(avatar.name, job.avatarId, localDateOf(new Date(at)), named);
    host.exportFiles().add(relPath);
    this.#exported.push(relPath);
    job.claimed = relPath;
    this.#after(job, 1, () => this.#recordExport(job, relPath, at));
  }

  /** The export line of the claimed copy (the I5.53 rewrite), and the end of the job. */
  #recordExport(job: Job, relPath: string, at: string): void {
    const record = this.#records.get(job.clipId);
    if (record !== undefined && record.outcome.status === "ready") {
      const host = this.#host;
      const profile: ClipExportProfile = this.#exportFps === "interpolate" ? "1080p30-interp" : this.#exportFps === "duplicate" ? "1080p30-dup" : "1080p24";
      const line: ClipExportLine = { rootId: host.exportRootId(), relPath, profile, at, bytes: Math.round(record.outcome.durationMs * 1_500), sha256: fakeSha(`${job.clipId}:${relPath}`) };
      record.exports = [...record.exports, line];
    }
    this.#finish(job, { status: "done", exported: { relPath } });
    this.#exportRunning = null;
    this.#nextExport();
  }

  #cancelExport(job: Job): void {
    if (job.claimed !== null) return;
    this.#exportQueue = this.#exportQueue.filter((j) => j !== job);
    const running = this.#exportRunning === job;
    this.#finish(job, { status: "cancelled" });
    if (running) {
      this.#exportRunning = null;
      this.#nextExport();
    }
  }

  // ---------- clips.reveal (main's; answered the way main answers it) ----------

  reveal(payload: CommandPayload<"clips.reveal">): Out<{ clipId: string }> {
    const found = this.#recordOf(payload.avatarId, payload.clipId);
    if (!found.ok) return found;
    this.#host.checkExport();
    const lines = found.result.exports;
    const index = lines.findLastIndex((line, i) => this.#fileStateOf(payload.clipId, i, line) === "present");
    const present = lines[index];
    if (present === undefined) return bad({ code: "VALIDATION", clipReason: "not-exported", detail: "the clip has no copy in the export folder" });
    this.revealed.push({ avatarId: payload.avatarId, clipId: payload.clipId, relPath: present.relPath });
    return good({ clipId: payload.clipId });
  }

  // ---------- snapshots ----------

  jobStates(): JobState[] {
    return [...this.#jobs.values()].map((job): JobState => {
      const base = {
        kind: "clip" as const,
        jobId: job.jobId,
        avatarId: job.avatarId,
        clipId: job.clipId,
        status: job.status,
        done: job.status === "done" ? job.total : job.done,
        total: job.total,
        phase: job.phase,
        ...jobFactsOf(job),
        ...jobBatchOf(job),
        ...(job.model === undefined ? {} : { model: job.model }),
        ...(job.submittedAt === undefined ? {} : { submittedAt: job.submittedAt }),
        ...(job.proveUntil === undefined ? {} : { proveUntil: job.proveUntil }),
      };
      if (job.status === "done" && job.result !== undefined) return { ...base, result: job.result };
      if (job.status === "failed" && job.error !== undefined) return { ...base, error: job.error };
      if (job.status === "cancelled" && job.detail !== undefined) return { ...base, detail: job.detail };
      return base;
    });
  }

  // ---------- restart (engine/clips/recover.ts) ----------

  /**
   * The engine process restarts: every clip job of the old process is gone (its timers with it), and a clip that has a journal and no record is recovered by a free job (§5.12). Nothing is written
   * to the ledger: every open reserve is now an earlier process's, waiting for the owner's reconcile, and the holds are taken up again from the journals and the reserve lines.
   */
  restart(): void {
    const host = this.#host;
    const t = this.#t;
    for (const job of this.#jobs.values()) for (const cancel of job.timers) cancel();
    for (const hold of this.#holds.values()) hold.cancel();
    this.#holds.clear();
    this.#jobs.clear();
    // 5b.2 (I5.63): the queued members of a batch are memory-only and die with the process, for free: no reserve, no journal, no record, and the month holds with them. No batch resumes after a restart.
    for (const batch of this.#batches.values()) batch.drop();
    this.#batches.clear();
    this.#monthHolds.clear();
    this.#caps.clear();
    this.#batchScripts = null;
    this.#batchPlay = [];
    this.#book = null;
    this.#unit = null;
    this.#exportQueue = [];
    this.#exportRunning = null;
    this.#restartedAtMs = host.clockMs();
    for (const line of this.#lines) {
      line.own = false;
      line.inFlight = false;
    }

    // engine/clips/recover.ts: a clip whose journal is in view is held by the journal's rules; an open reserve of a clip with none in view (its record went first, and took the journal) is held 60 min from its `at`.
    const journalInView = new Set(this.#journals.keys());
    const reservedBy = (clipId: string): Set<string> => new Set(this.#lines.filter((l) => l.clipId === clipId).map((l) => l.attemptId));
    const recoveries: { clipId: string; avatarId: string; plan: Plan; lines: MockJournalLine[]; fate: Script }[] = [];
    for (const [clipId, lines] of [...this.#journals]) {
      const requested = lines.find((l) => l.type === "requested");
      const record = this.#records.get(clipId);
      if (record !== undefined) {
        // A record with a journal beside it: the journal is stale, and goes.
        this.#journals.delete(clipId);
        const files = this.#files.get(clipId);
        if (files !== undefined) files.journal = false;
        continue;
      }
      if (requested?.type !== "requested") continue;
      const avatarId = this.#clipAvatars.get(clipId) ?? null;
      if (avatarId === null) continue;
      const fate = this.#fates.get(clipId) ?? { first: "ok" as const, then: "ok" as const, face: undefined };
      recoveries.push({ clipId, avatarId, plan: planOf(lines, reservedBy(clipId), host.clockMs(), t), lines, fate });
    }
    // The holds of a restart (engine/clips/holds.ts, `holdsAfterRestart`): per attempt the latest fact wins.
    // Per attempt the latest fact wins (an open reserve with its journal in view: 20 min from its line, with none in view 60 min; a `submitted` line: 60 min from it; an `ended` line: 2 min from it), and a journal's lines count whether or not the
    // earlier process settled the reserve (`holdsAfterRestart`: the ledger gives only the reserves that are still open).
    const nowMs = host.clockMs();
    const until = new Map<string, { rank: number; untilMs: number }>();
    const put = (attemptId: string, rank: number, untilMs: number): void => {
      if ((until.get(attemptId)?.rank ?? 0) <= rank) until.set(attemptId, { rank, untilMs });
    };
    for (const line of this.#lines) if (line.state === "open") put(line.attemptId, 1, line.reserveAtMs + (journalInView.has(line.clipId) ? t.holdUncertainMs : t.holdSubmittedMs));
    for (const lines of this.#journals.values()) {
      for (const line of lines) {
        if (line.type === "submitted") put(line.attemptId, 2, Date.parse(line.at) + t.holdSubmittedMs);
        else if (line.type === "ended") put(line.attemptId, 3, Date.parse(line.at) + t.holdTerminalMs);
      }
    }
    for (const [attemptId, { untilMs }] of until) if (untilMs > nowMs) this.#hold(attemptId, untilMs - nowMs);
    // 5b.2 (S5.WB2c, I5.63): no batch resumes after a restart: every batch the summaries still have running ends now.
    this.#endBatchesAfterRestart();
    for (const recovery of recoveries) this.#recover(recovery);
  }

  #recover(r: { clipId: string; avatarId: string; plan: Plan; lines: MockJournalLine[]; fate: Script }): void {
    const { clipId, avatarId, plan, lines, fate } = r;
    const host = this.#host;
    const t = this.#t;
    const step = host.stepMs;
    const job = this.#newJob(avatarId, "recovery", "recovering", CLIP_JOB_STEPS, clipId);
    const summary = summarize(lines);
    const requested = summary.requested;
    // As the engine's recovery job: the facts come from the journal's `requested` line, and a journal without one has none.
    if (requested !== null) job.facts = { photoId: requested.photoId, request: requested.request, motion: { source: requested.motion.source, label: requested.motion.label }, acceptedWorstMicros: requested.acceptedWorstMicros };
    // 5b.2 (I5.63): a batch member sent before the restart recovers as a single clip does, and keeps its place in the batch (the journal's `requested` line carries it), so the «Клипы» header counts it.
    if (requested?.batch !== undefined) job.batch = { ...requested.batch };
    this.#progress(job, { phase: "recovering" });
    if (requested === null || plan.kind === "stale-journal") {
      this.#finish(job, { status: "done" });
      return;
    }
    const request = requested.request;
    const commit = (model: AttemptModel, outcome: ClipOutcome, attempts: RecordAttempt[]): void => {
      this.#records.set(clipId, {
        id: clipId,
        avatarId,
        photoId: requested.photoId,
        createdAt: requested.at,
        seen: false,
        motion: requested.motion,
        request,
        model: modelUsed(model, request),
        attempts,
        recovered: true,
        exports: [],
        outcome,
        ...(requested.batch === undefined ? {} : { batch: { ...requested.batch } }),
      });
      const recorded = this.#records.get(clipId);
      if (recorded !== undefined) this.#noteMemberRecord(recorded);
      this.#journals.delete(clipId);
      this.#files.set(clipId, { journal: false, record: true, media: outcome.status === "ready" });
      this.#finish(job, { status: "done" });
    };
    const attemptsOf = (decided?: { attemptId: string; outcome: RecordAttempt["outcome"]; providerCostMicros?: number }): RecordAttempt[] => {
      const named = summary.attempts.map((a): RecordAttempt => {
        const base: RecordAttempt = {
          attemptId: a.attemptId,
          model: a.model ?? (a.attemptId.endsWith("#2") ? "grok" : request.model),
          ...(a.providerJobId === undefined ? {} : { providerJobId: a.providerJobId }),
          outcome: a.ended?.status ?? "late",
          ...(a.ended?.providerCostMicros === undefined ? {} : { providerCostMicros: a.ended.providerCostMicros }),
          costSource: a.ended?.costSource ?? "none",
        };
        return decided?.attemptId === a.attemptId ? { ...base, outcome: decided.outcome, ...(decided.providerCostMicros === undefined ? {} : { providerCostMicros: decided.providerCostMicros }) } : base;
      });
      const known = new Set(named.map((a) => a.attemptId));
      const unsent = this.#lines.filter((l) => l.clipId === clipId && !known.has(l.attemptId)).map((l): RecordAttempt => ({ attemptId: l.attemptId, model: l.model, outcome: "uncertain", costSource: "none" }));
      return [...named, ...unsent].slice(0, 2);
    };

    if (plan.kind === "fail") {
      this.#after(job, step, () => commit(plan.model, { status: "failed", reason: plan.reason, ...(plan.reason === "download-expired" ? {} : {}) }, attemptsOf()));
      return;
    }
    const ready = (model: AttemptModel, decided: { attemptId: string; outcome: RecordAttempt["outcome"]; providerCostMicros?: number }): void => {
      const size = sizeOf(model, request.quality);
      commit(model, { status: "ready", ...size, durationMs: request.seconds * 1_000, face: this.#faceOf({ bold: false, judged: true, ageRefused: false }, fate.face, request.seconds) }, attemptsOf(decided));
    };
    const fetchAndRecord = (p: Extract<Plan, { kind: "poll" | "download" }>, providerCostMicros: number | undefined, local: boolean): void => {
      const decided = { attemptId: p.attemptId, outcome: "completed" as const, ...(providerCostMicros === undefined ? {} : { providerCostMicros }) };
      const checking = (): void => {
        this.#progress(job, { phase: "checking", model: p.model, done: 2 });
        this.#after(job, step, () => {
          this.#progress(job, { phase: "saving", model: p.model, done: 3 });
          this.#after(job, step, () => ready(p.model, decided));
        });
      };
      if (local) {
        this.#after(job, step, checking);
        return;
      }
      this.#progress(job, { phase: "downloading", model: p.model, submittedAt: iso(p.submittedAtMs), done: 1 });
      this.#after(job, step, () => {
        // The provider's file cannot be stored (engine/clips/recover.ts `fetchAndRecord`): the clip is recorded failed, and fetched again until 60 min after its submit.
        const failure = DOWNLOAD_FAILURES[(p.attemptId.endsWith("#2") ? fate.then : fate.first)];
        if (failure !== undefined) {
          commit(p.model, { status: "failed", reason: failure, retryDownloadUntil: iso(p.submittedAtMs + t.lateGiveUpMs) }, attemptsOf(decided));
          return;
        }
        this.#journal(clipId, { type: "downloaded", sha256: fakeSha(clipId), bytes: 1_000_000 * request.seconds, at: iso(host.clockMs()) });
        checking();
      });
    };
    if (plan.kind === "download") {
      const cost = summary.attempts.find((a) => a.attemptId === plan.attemptId)?.ended?.providerCostMicros;
      fetchAndRecord(plan, cost, plan.local);
      return;
    }
    // poll: the provider's job is asked what became of it.
    const attemptFate = plan.attemptId.endsWith("#2") ? fate.then : fate.first;
    this.#progress(job, { phase: "recovering", model: plan.model, submittedAt: iso(plan.submittedAtMs) });
    const tier = plan.model === "grok" ? "grok" : request.quality;
    // The provider bills by the list the clip was reserved by; the engine settles a recovered job from the provider's own figure, which the mock stands in for here.
    const billed = clipBilledMicros((this.#clipRates.get(clipId) ?? this.#rates)[tier], request.seconds);
    const giveUpAt = plan.submittedAtMs + t.lateGiveUpMs;
    const completes: MockClipAttempt[] = ["ok", "ok-uncosted", "download-failed", "invalid-file", "disk-full", "late-ok"];
    if (attemptFate === "late" || attemptFate === "uncertain") {
      this.#after(job, Math.max(step, giveUpAt - host.clockMs()), () => {
        this.#journal(clipId, { type: "ended", attemptId: plan.attemptId, status: "late", costSource: "none", at: iso(host.clockMs()) });
        commit(plan.model, { status: "failed", reason: "late" }, attemptsOf({ attemptId: plan.attemptId, outcome: "late" }));
      });
      return;
    }
    this.#after(job, step, () => {
      this.#hold(plan.attemptId, t.holdTerminalMs);
      if (completes.includes(attemptFate)) {
        // `providerCost`: the poll's usage, else one /generation read of the job's own record; a poll with neither (`ok-uncosted`) gives the journal and the record no number at all.
        const provider = attemptFate === "ok-uncosted" ? undefined : billed;
        this.#journal(clipId, { type: "ended", attemptId: plan.attemptId, status: "completed", costSource: "none", ...(provider === undefined ? {} : { providerCostMicros: provider }), at: iso(host.clockMs()) });
        fetchAndRecord(plan, provider, false);
        return;
      }
      const content = attemptFate === "refused-free" || attemptFate === "refused-paid" || attemptFate === "refused-unknown" || attemptFate === "refused-uncounted";
      this.#journal(clipId, { type: "ended", attemptId: plan.attemptId, status: content ? "refused" : "failed", costSource: "none", at: iso(host.clockMs()) });
      // engine/clips/recover.ts `refusalReason`: a refusal the old process had already settled takes its reason from that settle; an open reserve is for the reconcile to settle at worst.
      const settled = this.#lines.find((l) => l.attemptId === plan.attemptId && l.state === "settled");
      const refusal: ClipFailReason = settled === undefined || settled.estimated ? "refused-unknown" : settled.costMicros === 0 ? "refused-free" : "refused-paid";
      commit(plan.model, { status: "failed", reason: content ? refusal : "provider-error" }, attemptsOf({ attemptId: plan.attemptId, outcome: content ? "refused" : "failed" }));
    });
  }
}

/** The local calendar date as `YYYY-MM-DD`: what the owner reads in an export's name (engine/exportName.ts `formatExportDate`, which the mock cannot import). */
function localDateOf(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The scripted attempts whose file is completed and billed but cannot be stored: the same reasons on a create and in a recovery. */
const DOWNLOAD_FAILURES: Partial<Record<MockClipAttempt, ClipFailReason>> = { "download-failed": "download-failed", "invalid-file": "invalid-file", "disk-full": "disk-full" };

interface CreateRun {
  job: Job;
  photoId: string;
  request: ClipRequest;
  motion: ClipMotion;
  accepted: number;
  facts: Facts;
  script: Script;
  /** 5b.2: a batch member's script is the batch's next, taken when its first reserve is made. */
  takesBatchScript?: true;
  createdAt: string;
  mode: "auto" | "offer";
  /** The price list this create was priced by: the reserve and the charge use it, as `runClipJob({ prices: job.prices })` does. */
  rates: ClipPrices;
}

