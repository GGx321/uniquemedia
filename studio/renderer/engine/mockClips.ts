import {
  BOLD_CLIPS,
  CLIP_JOB_STEPS,
  CLIP_RETRYABLE_FAILURES,
  EXPORT_FPS,
  GROK_FALLBACK,
  isBoldCategory,
  MAX_LISTED_CLIPS,
  PROTOCOL_VERSION,
  clipAllowsAutoGrok,
  clipBilledMicros,
  clipExpectedMicros,
  clipReserveMicros,
  clipWorstMicros,
  type BoldClipsMode,
  type ClipCost,
  type ClipExport,
  type ClipExportLine,
  type ClipExportProfile,
  type ClipFace,
  type ClipFailReason,
  type ClipModelUsed,
  type ClipMotion,
  type ClipMotionChoice,
  type ClipOptions,
  type ClipPhase,
  type ClipPriceParts,
  type ClipPrices,
  type ClipQuality,
  type ClipRequest,
  type ClipSeconds,
  type ClipSummary,
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
import type { UnsequencedEvent } from "../../shared/engine/events";
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
 * - `ok`: completed with `usage.cost`. `ok-uncosted`: completed with no usage and no `/generation` record, settled at the worst.
 * - `refused-submit`: a moderation 4xx at the POST (free, no job). `refused-free`: a content failure at the poll, proven free. `refused-paid`: `/generation` bills it. `refused-unknown`: the net-usage
 *   check rose. `refused-uncounted`: the check could not count (the STRICT proof: not free).
 * - `provider-error` / `-paid` / `-unknown`: a failure that is not a content refusal, through the same proof.
 * - `rate-limited`, `bad-request`, `key-invalid`, `no-credits`: a refusal at the POST that is not a moderation one. `uncertain`: a 5xx or a timeout at the POST.
 * - `late`: no terminal status for the lifetime and never one. `late-ok`: one that comes in after the lifetime.
 * - `download-failed`, `invalid-file`, `disk-full`: completed and billed, the file not stored.
 * - `no-room` (Grok only): the month has no room for Grok's reserve.
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
  | "no-room";

export type MockClipFace = "match" | "mismatch" | "few-faces" | "worker";

/** The next `clips.create`: the first attempt, the Grok attempt behind a free refusal (default `ok`), and the face check's verdict (default a match). */
export type MockClipScript = MockClipAttempt | { first?: MockClipAttempt; then?: MockClipAttempt; face?: MockClipFace };

export type MockRetryResult = "ok" | "failed" | "gone";
export type MockExportResult = "ok" | "fail";

// ---------- the journal, as the engine writes it ----------

/** The lines of a clip's journal (engine/clips/schemas.ts): the same shapes, so the engine's own recovery plan can read the mock's. */
export type MockJournalLine =
  | { type: "requested"; clipId: string; photoId: string; request: ClipRequest; motion: ClipMotion; acceptedWorstMicros: number; at: string }
  | { type: "submitted"; attemptId: string; model: "kling" | "grok"; providerJobId: string; at: string }
  | {
      type: "ended";
      attemptId: string;
      status: "completed" | "failed" | "cancelled" | "expired" | "refused" | "uncertain" | "late";
      providerCostMicros?: number;
      costSource: "usage" | "generation" | "proof" | "worst" | "none";
      at: string;
    }
  | { type: "downloaded"; sha256: string; bytes: number; at: string };

type AttemptModel = "kling" | "grok";

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
  if (lastUnsent !== undefined) return { kind: "fail", reason: "lost", model: modelOf({ attemptId: lastUnsent }) };
  const last = attempts.findLast((a) => a.ended !== undefined);
  if (last?.ended !== undefined) return { kind: "fail", reason: reasonOfEnded(last.ended), model: modelOf(last) };
  return { kind: "fail", reason: "lost", model: requested.request.model };
}

/** The mock's recovery plan for a journal, as the engine would plan it: exposed so a test can ask the engine's `planRecovery` about the same lines. */
export { planOf as mockRecoveryPlan };

// ---------- the clips ----------

export class MockClips {
  readonly #host: MockClipsHost;
  readonly #t: MockClipTimings;
  #rates: ClipPrices = RATES;
  readonly #mode: "auto" | "offer";
  readonly #boldClips: BoldClipsMode;
  readonly #exportFps: "interpolate" | "duplicate" | "native24";

  #prices: MockVideoPrices = "live";
  readonly #pixels = new Map<string, "unreadable" | "not-vertical">();
  #script: Script | null = null;
  #retryResult: MockRetryResult | null = null;
  #exportResult: MockExportResult | null = null;
  #failDelete: "journal" | "record" | null = null;

  /** The committed records by clip id, in creation order. */
  readonly #records = new Map<string, MockClipRecord>();
  readonly #lines: Line[] = [];
  readonly #journals = new Map<string, MockJournalLine[]>();
  readonly #files = new Map<string, { journal: boolean; record: boolean; media: boolean }>();
  readonly #jobs = new Map<string, Job>();
  /** What each clip's attempts will do: the script of its create (kept for a restart's recovery, which polls the same provider). */
  readonly #fates = new Map<string, Script>();
  readonly #holds = new Map<string, { until: number; cancel: () => void }>();
  readonly #exportStates = new Map<string, FileState>();
  /** The folder-relative paths clip exports made, in order. */
  readonly #exported: string[] = [];
  readonly revealed: { avatarId: string; clipId: string; relPath: string }[] = [];
  readonly #posts: AttemptModel[] = [];
  /** The avatar each clip in flight belongs to (a recovery needs it before there is a record). */
  readonly #clipAvatars = new Map<string, string>();
  readonly #attemptsByClip = new Map<string, RecordAttempt[]>();

  /** The create that holds the one paid slot, from its dispatch until its money closes. */
  #slot: Job | null = null;
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
      attempts: this.#lines.map((l) => ({ ...l })),
      posts: [...this.#posts],
      journals: Object.fromEntries([...this.#journals].map(([id, lines]) => [id, [...lines]])),
      files: Object.fromEntries([...this.#files].filter(([, f]) => f.journal || f.record || f.media)),
      nowMs: this.#host.clockMs(),
      restartedAtMs: this.#restartedAtMs,
      exportedFiles: [...this.#exported],
    };
  }

  // ---------- money, as the engine's #moneyStatus and #reconcile read it ----------

  /** The paid slot is held: a reconcile is refused IN_FLIGHT, as the engine's paid-command count refuses it. */
  paidOpen(): boolean {
    return this.#slot !== null;
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
    const host = this.#host;
    const until = host.clockMs() + durationMs;
    const cancel = host.scheduler.schedule(durationMs, () => {
      const entry = this.#holds.get(attemptId);
      if (entry === undefined || entry.until !== until) return;
      host.setClockAtLeast(until);
      this.#holds.delete(attemptId);
      host.emitMoney();
    });
    this.#holds.set(attemptId, { until, cancel });
    host.emitMoney();
  }

  #release(attemptId: string): void {
    const entry = this.#holds.get(attemptId);
    if (entry === undefined) return;
    entry.cancel();
    this.#holds.delete(attemptId);
    this.#host.emitMoney();
  }

  // ---------- the ledger lines ----------

  #reserve(clipId: string, n: 1 | 2, model: AttemptModel, worstMicros: number): Line {
    const line: Line = { attemptId: attemptIdOf(clipId, n), clipId, model, worstMicros, reserveAtMs: this.#host.clockMs(), state: "open", costMicros: 0, estimated: false, own: true, inFlight: true };
    this.#lines.push(line);
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
  #read(photo: PhotoSummary | null): { kind: "refused"; reason: Refusal } | { kind: "suitable"; facts: Facts; motions: readonly ClipMotionChoice[] } {
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

  #estimate(parts: Omit<ClipPriceParts, "prices" | "mode" | "boldClips">): Estimate | null {
    if (this.#prices === "missing") return null;
    const full: ClipPriceParts = { ...parts, mode: this.#mode, boldClips: this.#boldClips, prices: this.#rates };
    return {
      expectedMicros: clipExpectedMicros(full),
      worstMicros: clipWorstMicros(full),
      prices: this.#prices,
      pricesAsOf: this.#prices === "fallback" ? FALLBACK_DATE : this.#host.pricesAsOf(),
    };
  }

  #committed(): number {
    let open = 0;
    for (const worst of this.#host.reserves.values()) open += worst;
    return this.#host.spentMicros() + open;
  }

  #fits(worstMicros: number): boolean {
    return this.#committed() + worstMicros <= this.#host.monthlyBudgetMicros();
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
    if (this.#prices === "missing") return bad(this.#unavailable());
    const { facts } = read;
    const fallback = this.#fallbackOf(facts);
    const kling = (quality: ClipQuality, seconds: ClipSeconds, withFallback: "auto" | "none"): Estimate => {
      const estimate = this.#estimate({ model: "kling", quality, seconds, fallback: withFallback, bold: facts.bold });
      if (estimate === null) throw new Error("unreachable");
      return estimate;
    };
    const grok = (seconds: ClipSeconds): Estimate => {
      const estimate = this.#estimate({ model: "grok", quality: "std", seconds, fallback: "none", bold: facts.bold });
      if (estimate === null) throw new Error("unreachable");
      return estimate;
    };
    const set = (withFallback: "auto" | "none") => ({ std5: kling("std", 5, withFallback), pro5: kling("pro", 5, withFallback), std10: kling("std", 10, withFallback), pro10: kling("pro", 10, withFallback) });
    const prices = set("auto");
    const noFallbackPrices = set("none");
    const fit = (key: keyof typeof prices) => {
      if (fallback === "auto" && this.#fits(prices[key].worstMicros)) return "with-fallback" as const;
      return this.#fits(noFallbackPrices[key].worstMicros) ? ("without-fallback" as const) : ("none" as const);
    };
    return good({
      suitable: true,
      photoId: payload.photoId,
      motions: read.motions.map((m) => ({ ...m })),
      prices: { ...prices, grok5: grok(5), grok10: grok(10) },
      fallback,
      bold: facts.bold,
      noFallbackPrices,
      monthFits: { std5: fit("std5"), pro5: fit("pro5"), std10: fit("std10"), pro10: fit("pro10") },
    });
  }

  // ---------- clips.create ----------

  create(payload: CommandPayload<"clips.create">): Out<{ jobId: string }> {
    // The slot is the FIRST check (I5.50).
    if (this.#slot !== null) return bad({ code: "IN_FLIGHT", clipReason: "one-at-a-time", detail: "another clip is being made; one paid clip runs at a time" });
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
    const estimate = this.#estimate({ ...request, bold: read.facts.bold });
    if (estimate === null) return bad(this.#unavailable());
    if (estimate.worstMicros > payload.acceptedWorstMicros) return bad({ code: "PRICE_CHANGED", detail: `the worst case is now ${estimate.worstMicros} µ$, above the accepted ${payload.acceptedWorstMicros} µ$` });
    if (!this.#fits(estimate.worstMicros)) return bad({ code: "BUDGET_EXCEEDED", detail: `committed ${this.#committed()} µ$ + this job's worst case ${estimate.worstMicros} µ$ > the monthly budget ${this.#host.monthlyBudgetMicros()} µ$` });

    const script = this.#script ?? { first: "ok" as const, then: "ok" as const, face: undefined };
    this.#script = null;
    const job = this.#newJob(payload.avatarId, "create");
    this.#slot = job;
    this.#fates.set(job.clipId, script);
    this.#clipAvatars.set(job.clipId, payload.avatarId);
    const createdAt = this.#host.nowIso();
    const run: CreateRun = { job, photoId: payload.photoId, request, motion: { source: "code", label: motion.label, text: motion.text }, accepted: payload.acceptedWorstMicros, facts: read.facts, script, createdAt, mode: this.#mode };
    this.#progress(job, { phase: "preparing" });
    this.#after(job, this.#host.stepMs, () => this.#attempt(run, 1, request.model));
    return good({ jobId: job.jobId });
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

  #progress(job: Job, update: { phase: ClipPhase; model?: AttemptModel; submittedAt?: string; proveUntil?: string; done?: number }): void {
    if (job.status !== "running") return;
    job.phase = update.phase;
    job.model = update.model;
    job.submittedAt = update.submittedAt;
    job.proveUntil = update.phase === "proving" ? update.proveUntil : undefined;
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
      ...(job.model === undefined ? {} : { model: job.model }),
      ...(job.submittedAt === undefined ? {} : { submittedAt: job.submittedAt }),
      ...(job.proveUntil === undefined ? {} : { proveUntil: job.proveUntil }),
    };
  }

  /** Ends a job and tells the windows. A done job is at its full count and carries its clip. */
  #finish(job: Job, end: { status: "done"; exported?: { relPath: string } } | { status: "failed"; error: EngineError } | { status: "cancelled" }): void {
    if (job.status !== "running") return;
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
      this.#host.emit({ v, id: this.#host.nextId("evt"), kind: "event", type: "job.cancelled", payload: ref });
    }
  }

  /** Every reserve of the clip is settled or abandoned (or none was made): the slot goes, once. */
  #closeMoney(job: Job): void {
    if (job.moneyClosed) return;
    job.moneyClosed = true;
    if (this.#slot === job) this.#slot = null;
    this.#host.emitMoney();
  }

  // ---------- the money state machine of one attempt (engine/clips/attempt.ts) ----------

  #attempt(run: CreateRun, n: 1 | 2, model: AttemptModel): void {
    const { job, request } = run;
    if (job.status !== "running") return;
    const host = this.#host;
    const tier = model === "grok" ? "grok" : request.quality;
    const reserveMicros = clipReserveMicros(RATES[tier], request.seconds);
    const scripted = n === 1 ? run.script.first : run.script.then;
    const clipId = job.clipId;
    // The budget's `blocked` comes before its limits (engine/money/budget.ts): a halted ledger, or reserves that wait for a reconcile, refuse the reserve with nothing sent.
    const blocked = host.reserveRefusal();
    if (blocked !== null) {
      this.#closeMoney(job);
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
    const refusedByMonth = (n === 2 && scripted === "no-room") || !this.#fits(reserveMicros);
    if (refusedByMonth) {
      this.#closeMoney(job);
      if (n === 2) {
        this.#commit(run, { model: "grok", attempts: this.#attemptsOf(clipId), outcome: { status: "failed", reason: "grok-no-room" } });
        return;
      }
      this.#dropJournal(clipId);
      this.#finish(job, { status: "failed", error: { code: "BUDGET_EXCEEDED", detail: `committed ${this.#committed()} µ$ + the clip's ${reserveMicros} µ$ > the limit ${host.monthlyBudgetMicros()} µ$; nothing was sent` } });
      return;
    }
    if (n === 1) {
      this.#journal(clipId, { type: "requested", clipId, photoId: run.photoId, request, motion: run.motion, acceptedWorstMicros: run.accepted, at: run.createdAt });
      this.#files.set(clipId, { journal: true, record: false, media: false });
    }
    const line = this.#reserve(clipId, n, model, reserveMicros);
    this.#hold(line.attemptId, this.#t.holdUncertainMs);
    this.#progress(job, { phase: "submitting", model });
    // An unreadable `/credits` (`refused-uncounted`) is read three times, 5 s apart, for the net-usage baseline BEFORE the POST (engine/clips/attempt.ts): the send leaves 10 s later.
    const baselinePauses = scripted === "refused-uncounted" ? (PROOF_READ_TRIES - 1) * this.#t.proofRetryMs : 0;
    this.#after(job, host.stepMs + baselinePauses, () => this.#post(run, n, model, line, scripted));
  }

  #post(run: CreateRun, n: 1 | 2, model: AttemptModel, line: Line, scripted: MockClipAttempt): void {
    const { job, request } = run;
    const host = this.#host;
    const seconds = request.seconds;
    const tier = model === "grok" ? "grok" : request.quality;
    const billed = clipBilledMicros(RATES[tier], seconds);
    const attemptId = line.attemptId;
    const ended = (status: Extract<MockJournalLine, { type: "ended" }>["status"], costSource: Extract<MockJournalLine, { type: "ended" }>["costSource"], providerCostMicros?: number): void =>
      this.#journal(job.clipId, { type: "ended", attemptId, status, costSource, ...(providerCostMicros === undefined ? {} : { providerCostMicros }), at: iso(host.clockMs()) });

    // ----- refused at the POST: no job exists, nothing is billed -----
    const submitFailures: Partial<Record<MockClipAttempt, ClipFailReason>> = { "rate-limited": "rate-limited", "bad-request": "bad-request", "key-invalid": "key-invalid", "no-credits": "no-credits" };
    if (scripted === "refused-submit" || submitFailures[scripted] !== undefined) {
      this.#posts.push(model);
      this.#settle(line, 0, false);
      this.#release(attemptId);
      const content = scripted === "refused-submit";
      ended(content ? "refused" : "failed", "none");
      this.#attemptsDone(job.clipId, { attemptId, model, outcome: content ? "refused" : "failed", costSource: "none" });
      if (content) return this.#afterFreeRefusal(run, n);
      if (scripted === "key-invalid") host.markKeyRejected();
      return this.#fail(run, model, submitFailures[scripted] ?? "bad-request");
    }
    if (scripted === "uncertain") {
      this.#posts.push(model);
      line.inFlight = false; // abandoned: the reserve stays open at worst, held by its hold
      ended("uncertain", "none");
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
    const completes: MockClipAttempt[] = ["ok", "ok-uncosted", "download-failed", "invalid-file", "disk-full"];
    if (completes.includes(scripted)) {
      const uncosted = scripted === "ok-uncosted";
      const settleAndDeliver = (): void => {
        this.#settle(line, uncosted ? line.worstMicros : billed, uncosted);
        ended("completed", uncosted ? "worst" : "usage", uncosted ? undefined : billed);
        this.#attemptsDone(job.clipId, { attemptId, model, providerJobId, outcome: "completed", ...(uncosted ? {} : { providerCostMicros: billed }), costSource: uncosted ? "worst" : "usage" });
        this.#closeMoney(job);
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
    const free = scripted === "refused-free" || scripted === "provider-error";
    const paid = scripted === "refused-paid" || scripted === "provider-error-paid";
    // engine/clips/attempt.ts `prove`: a `/generation` record that bills ends the proof at its FIRST reading (15 s); every other proof goes through the second (2 min) and the net-usage check.
    // ...and the same three reads after the second `/generation` one: the check that cannot count settles 10 s after it.
    const checkPauses = scripted === "refused-uncounted" ? (PROOF_READ_TRIES - 1) * this.#t.proofRetryMs : 0;
    this.#after(job, paid ? this.#t.proofFirstReadMs : this.#t.proofSecondReadMs + checkPauses, () => {
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
    this.#closeMoney(job);
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
    this.#closeMoney(run.job);
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
      ...(providerCosts.length === 0 ? {} : { providerCostMicros: providerCosts.reduce((sum, micros) => sum + micros, 0) }),
      exports: record.exports.map((line, i): ClipExport => (withStates ? { ...line, fileState: this.#fileStateOf(record.id, i, line) } : { ...line })),
    };
    const { outcome } = record;
    if (outcome.status === "ready") return { ...common, status: "ready", width: outcome.width, height: outcome.height, durationMs: outcome.durationMs, face: outcome.face };
    const offer = this.#grokOffer(record);
    return { ...common, status: "failed", failure: { reason: outcome.reason, ...(offer === null ? {} : { grokOffer: offer }) }, ...(outcome.retryDownloadUntil === undefined ? {} : { retryDownloadUntil: outcome.retryDownloadUntil }) };
  }

  /** The tile's «Снять на Grok · до $0.85» (I5.47): mode `offer` only, on a Kling clip refused for free whose request kept its fallback. */
  #grokOffer(record: MockClipRecord): Estimate | null {
    if (this.#mode !== "offer" || record.outcome.status !== "failed" || record.outcome.reason !== "refused-free" || record.request.model !== "kling" || record.request.fallback !== "auto") return null;
    return this.#estimate({ model: "grok", quality: "std", seconds: record.request.seconds, fallback: "none", bold: false });
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

  list(payload: CommandPayload<"clips.list">): Out<{ clips: ClipSummary[]; notListedTotal?: number }> {
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
    return good(left === 0 ? { clips } : { clips, notListedTotal: left });
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

  #busyClip(clipId: string): boolean {
    return [...this.#jobs.values()].some((j) => j.status === "running" && j.clipId === clipId);
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
    if (fault === "journal") return bad({ code: "INTERNAL", detail: "the clip's journal could not be removed" });
    this.#journals.delete(clipId);
    const files = this.#files.get(clipId);
    if (files !== undefined) files.journal = false;
    if (fault === "record") return bad({ code: "INTERNAL", detail: "the clip's record could not be removed" });
    this.#records.delete(clipId);
    this.#files.delete(clipId);
    return good({ clipId });
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
    if (job.phase !== "preparing") return bad({ code: "IN_FLIGHT", clipReason: "submitted", detail: "the clip has already been sent; it cannot be cancelled" });
    this.#finish(job, { status: "cancelled" });
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
        if (result === "fail" && i === 1) {
          this.#finish(job, { status: "failed", error: { code: "INTERNAL", detail: "the clip could not be encoded" } });
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
        ...(job.model === undefined ? {} : { model: job.model }),
        ...(job.submittedAt === undefined ? {} : { submittedAt: job.submittedAt }),
        ...(job.proveUntil === undefined ? {} : { proveUntil: job.proveUntil }),
      };
      if (job.status === "done" && job.result !== undefined) return { ...base, result: job.result };
      if (job.status === "failed" && job.error !== undefined) return { ...base, error: job.error };
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
    this.#slot = null;
    this.#exportQueue = [];
    this.#exportRunning = null;
    this.#restartedAtMs = host.clockMs();
    for (const line of this.#lines) {
      line.own = false;
      line.inFlight = false;
    }

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
    // Per attempt the latest fact wins (an open reserve alone: 20 min from its line; a `submitted` line: 60 min from it; an `ended` line: 2 min from it), and a journal's lines count whether or not the
    // earlier process settled the reserve (`holdsAfterRestart`: the ledger gives only the reserves that are still open).
    const nowMs = host.clockMs();
    const until = new Map<string, { rank: number; untilMs: number }>();
    const put = (attemptId: string, rank: number, untilMs: number): void => {
      if ((until.get(attemptId)?.rank ?? 0) <= rank) until.set(attemptId, { rank, untilMs });
    };
    for (const line of this.#lines) if (line.state === "open") put(line.attemptId, 1, line.reserveAtMs + t.holdUncertainMs);
    for (const lines of this.#journals.values()) {
      for (const line of lines) {
        if (line.type === "submitted") put(line.attemptId, 2, Date.parse(line.at) + t.holdSubmittedMs);
        else if (line.type === "ended") put(line.attemptId, 3, Date.parse(line.at) + t.holdTerminalMs);
      }
    }
    for (const [attemptId, { untilMs }] of until) if (untilMs > nowMs) this.#hold(attemptId, untilMs - nowMs);
    for (const recovery of recoveries) this.#recover(recovery);
  }

  #recover(r: { clipId: string; avatarId: string; plan: Plan; lines: MockJournalLine[]; fate: Script }): void {
    const { clipId, avatarId, plan, lines, fate } = r;
    const host = this.#host;
    const t = this.#t;
    const step = host.stepMs;
    const job = this.#newJob(avatarId, "recovery", "recovering", CLIP_JOB_STEPS, clipId);
    this.#progress(job, { phase: "recovering" });
    const summary = summarize(lines);
    const requested = summary.requested;
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
      });
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
    const billed = clipBilledMicros(RATES[tier], request.seconds);
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
      commit(plan.model, { status: "failed", reason: content ? "refused-unknown" : "provider-error" }, attemptsOf({ attemptId: plan.attemptId, outcome: content ? "refused" : "failed" }));
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
  createdAt: string;
  mode: "auto" | "offer";
}

