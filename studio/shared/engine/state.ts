import { z } from "zod";
import { AvatarDescriptor, AvatarName, AvatarStatus, AvatarTraits } from "./avatar";
import { EngineError } from "./errors";
import { AbsolutePath, Count, Id, Micros, ModelId, SafeText } from "./primitives";

const IsoDateTime = z.iso.datetime();
const IsoDate = z.iso.date();

/** A calendar month in UTC, `YYYY-MM`: the global budget's window. */
export const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM");

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

// ---------- settings ----------

/**
 * What the renderer may know about the API key: whether one is stored, its
 * last four chars, and whether OpenRouter rejected it (401). Never the key
 * itself (invariant 10) — strict, so a `key` field fails validation.
 */
export const ApiKeyStatus = z
  .strictObject({
    stored: z.boolean(),
    last4: z.string().regex(/^[\x21-\x7e]{4}$/, "must be four visible chars").nullable(),
    encryptionAvailable: z.boolean(),
    rejected: z.boolean(),
  })
  .refine((s) => s.stored === (s.last4 !== null), {
    message: "last4 must be present exactly when a key is stored",
    path: ["last4"],
  })
  .refine((s) => s.stored || !s.rejected, {
    message: "only a stored key can be rejected",
    path: ["rejected"],
  });

/** Parallel network requests; the queue shrinks it on 429. */
export const NetworkConcurrency = z.number().int().min(1).max(16);

export const Settings = z.strictObject({
  apiKey: ApiKeyStatus,
  monthlyBudgetMicros: Micros,
  libraryPath: AbsolutePath,
  imageModel: ModelId,
  textModel: ModelId,
  concurrency: z.strictObject({ network: NetworkConcurrency }),
});

// ---------- money ----------

/**
 * Why paid calls wait for a user reconcile:
 * - `open-reserves`: reserves left unsettled by a crash or restart (invariant 4);
 * - `torn-ledger-line`: the ledger's last line is truncated.
 */
export const ReconcileReason = z.enum(["open-reserves", "torn-ledger-line"]);

/** A set of reasons: each at most once. */
export const ReconcileReasons = z
  .array(ReconcileReason)
  .max(ReconcileReason.options.length)
  .refine(unique, "reasons must not repeat");

/**
 * An attempt id as the ledger records it (e.g. `slot-3#2`). The engine makes
 * them, so they are never user text; visible ASCII keeps them safe to show.
 */
export const AttemptId = z.string().regex(/^[\x21-\x7e]{1,128}$/, "must be 1-128 visible ASCII chars");

/**
 * Why paid calls are stopped on a ledger that was read, beyond the reconcile
 * reasons (a halt and reconcile reasons can both be present):
 * - SETTLE_ABOVE_WORST: `attemptIds` were billed above their reserved worst
 *   case, so the price table is wrong. A reconcile acknowledges them and lifts
 *   the halt; it also survives a restart until then.
 * - LEDGER_WRITE_FAILED: a ledger write failed, so the file state is unknown;
 *   nothing more is written until the app restarts.
 * `detail` is diagnostics, never user text.
 */
export const MoneyHalt = z.discriminatedUnion("cause", [
  z.strictObject({ cause: z.literal("SETTLE_ABOVE_WORST"), detail: SafeText, attemptIds: z.array(AttemptId).min(1) }),
  z.strictObject({ cause: z.literal("LEDGER_WRITE_FAILED"), detail: SafeText }),
]);

/**
 * Why the ledger could not be opened when the engine started: its content is
 * broken (LEDGER_CORRUPT: a line before the last one cannot be read) or the
 * file itself could not be read (LEDGER_UNREADABLE). Paid calls are stopped
 * and the amounts are unknown until the app restarts with a readable ledger;
 * a reconcile cannot help, since it needs the ledger.
 */
export const LedgerUnavailable = z.strictObject({
  cause: z.enum(["LEDGER_CORRUPT", "LEDGER_UNREADABLE"]),
  detail: SafeText,
});

const moneyCommon = {
  month: YearMonth,
  monthlyBudgetMicros: Micros,
};

/**
 * The money state for the UI. `ledger: "open"` carries this month's amounts;
 * `ledger: "unavailable"` says only why there are none. On both, `halt` is
 * the one place that says why paid calls are stopped beyond a reconcile:
 * null when nothing but the reconcile reasons (if any) stops them.
 */
export const MoneyStatus = z.discriminatedUnion("ledger", [
  z
    .strictObject({
      ledger: z.literal("open"),
      ...moneyCommon,
      spentMicros: Micros,
      /** Worst case of every reserve without a settle or release. */
      unsettledMicros: Micros,
      unsettledCount: Count,
      reconcileNeeded: z.boolean(),
      reconcileReasons: ReconcileReasons,
      halt: MoneyHalt.nullable(),
    })
    .refine((s) => s.reconcileNeeded === s.reconcileReasons.length > 0, {
      message: "reconcileReasons must be non-empty exactly when reconcileNeeded is true",
      path: ["reconcileReasons"],
    }),
  z.strictObject({
    ledger: z.literal("unavailable"),
    ...moneyCommon,
    reconcileNeeded: z.literal(false),
    reconcileReasons: z.tuple([]),
    halt: LedgerUnavailable,
  }),
]);

/** Where prices came from: the live OpenRouter endpoints or the dated fallback table. */
export const PriceSource = z.enum(["live", "fallback"]);

/** A cost shown before anything is spent: expected and worst case, both in micro-dollars. */
export const Estimate = z
  .strictObject({
    expectedMicros: Micros,
    worstMicros: Micros,
    prices: PriceSource,
    pricesAsOf: IsoDate,
  })
  .refine((e) => e.expectedMicros <= e.worstMicros, {
    message: "expected cost must not exceed the worst case",
    path: ["expectedMicros"],
  });

/**
 * CLOCK_SKEW as T2 reports it: the ledger holds a time later than the wall
 * clock, so the reconcile wait was measured on the monotonic clock.
 */
export const ReconcileWarning = z.enum(["clock-skew"]);
export const ReconcileWarnings = z
  .array(ReconcileWarning)
  .max(ReconcileWarning.options.length)
  .refine(unique, "warnings must not repeat");

/**
 * Result of `money.reconcile`: both totals for the window since the previous
 * reconcile, or how long to wait for `/credits` to catch up. Paid requests
 * still in flight are refused with the IN_FLIGHT error instead.
 *
 * - `creditsDeltaMicros`: `/credits` usage since the previous reconcile; null
 *   when `deltaUnavailable` says why (`no-baseline`: the first reconcile;
 *   `negative-delta`: the account-wide usage went down).
 * - `ledgerDeltaMicros`: the ledger total for the same window, open reserves
 *   at their worst case.
 * - `mismatch`: the two differ by more than $0.01; null without a delta.
 * - `closedReserves`: open reserves settled at their worst case.
 * - `aboveWorstAttempts`: attempts billed above their worst case in this
 *   window, now acknowledged; the halt they caused is lifted.
 */
export const ReconcileResult = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("done"),
      creditsDeltaMicros: Micros.nullable(),
      deltaUnavailable: z.enum(["no-baseline", "negative-delta"]).nullable(),
      ledgerDeltaMicros: Micros,
      mismatch: z.boolean().nullable(),
      closedReserves: Count,
      aboveWorstAttempts: z.array(AttemptId),
      tornLineMoved: z.boolean(),
      warnings: ReconcileWarnings,
    })
    .refine((r) => (r.creditsDeltaMicros === null) === (r.deltaUnavailable !== null), {
      message: "deltaUnavailable must say why exactly when creditsDeltaMicros is null",
      path: ["deltaUnavailable"],
    })
    .refine((r) => (r.creditsDeltaMicros === null) === (r.mismatch === null), {
      message: "mismatch must be null exactly when there is no delta to compare",
      path: ["mismatch"],
    }),
  z.strictObject({
    status: z.literal("too-early"),
    retryAfterMs: z.number().int().positive(),
    warnings: ReconcileWarnings,
  }),
]);

// ---------- notices ----------

/**
 * Something the windows must be told that is not an error of any command:
 * - `engine-restarted`: the engine crashed and was restarted (work in flight was lost);
 * - `settings-reset`: settings.json could not be read and the defaults are in use.
 * Pending notices are part of the snapshot, so a window opened later still
 * shows them. A notice that happens again replaces the earlier one of its
 * kind: `count` says how often it happened this session, and the id, the
 * time and `detail` (diagnostics, never user text) are the latest one's.
 */
export const NoticeCode = z.enum(["engine-restarted", "settings-reset"]);

export const EngineNotice = z.strictObject({
  noticeId: Id,
  code: NoticeCode,
  detail: SafeText.optional(),
  at: IsoDateTime,
  count: z.number().int().positive(),
});

// ---------- avatars ----------

/**
 * A candidate portrait. Drafts are avatars with status `draft`, so a candidate
 * is an ordinary photo of that avatar and the UI addresses it as
 * `studio-media://photo/<avatarId>/<photoId>` before any candidate is picked.
 */
export const Candidate = z.strictObject({ avatarId: Id, photoId: Id });

/** The avatar wizard's state, enough to restore it from a snapshot. */
export const Draft = z
  .strictObject({
    avatarId: Id,
    traits: AvatarTraits,
    descriptor: AvatarDescriptor,
    candidates: z.array(Candidate),
    /**
     * What the draft's next batch costs (`avatars.estimateCandidates`: the
     * candidates and their age checks, no descriptor call), at the prices the
     * engine had when it built the draft; null when it could not price it.
     * Prices move, so the UI asks again before a paid command.
     */
    estimate: Estimate.nullable(),
  })
  .refine((d) => d.descriptor.age === d.traits.age, {
    message: "descriptor age must match the traits",
    path: ["descriptor", "age"],
  })
  .refine((d) => d.candidates.every((c) => c.avatarId === d.avatarId), {
    message: "every candidate must belong to this draft",
    path: ["candidates"],
  });

/**
 * A saved avatar as listed in the grid; drafts are listed separately. No
 * language field: on-video text is English only.
 */
export const AvatarSummary = z.strictObject({
  avatarId: Id,
  name: AvatarName,
  descriptor: AvatarDescriptor,
  masterPhotoId: Id,
  createdAt: IsoDateTime,
  status: AvatarStatus.exclude(["draft"]),
  photoCount: Count,
});

/**
 * Why a stored avatar record could not be listed as a draft or a saved
 * avatar:
 * - `manifest-unreadable`: its manifest file could not be read or parsed.
 * - `descriptor-invalid`: its stored descriptor no longer fits today's rules
 *   (ageText.ts, AvatarDescriptor); `avatars.rewriteDescriptor` can fix it.
 * - `contract-mismatch`: anything else the contract refuses (e.g. traits
 *   stored before typed traits existed).
 */
export const UnreadableReason = z.enum(["manifest-unreadable", "descriptor-invalid", "contract-mismatch"]);

/**
 * The fixed, short English sentence each reason gets — enumerated, not
 * `SafeText`, so a `detail` outside this closed set (a bug, or an attempt to
 * sneak the descriptor or the vibe through it) fails validation, not only review.
 */
export const UnreadableDetail = z.enum([
  "its manifest file could not be read or parsed",
  "its stored descriptor no longer fits today's rules",
  "its stored record no longer fits the contract",
]);

/**
 * At most `MAX_UNREADABLE_AVATARS` bounded elsewhere: an avatar the engine
 * could not list normally. `avatarId` is null only when it cannot be
 * recovered from the folder or the manifest; `detail` is one of
 * `UnreadableDetail`'s fixed sentences, the one its `reason` names — never
 * the descriptor or the vibe.
 */
export const UnreadableAvatar = z.strictObject({
  avatarId: Id.nullable(),
  reason: UnreadableReason,
  detail: UnreadableDetail,
});

// ---------- jobs ----------

export const JobKind = z.enum(["avatar.candidates", "run"]);
export const JobStatus = z.enum(["queued", "running", "done", "failed", "cancelled"]);

const doneWithinTotal = {
  check: (p: { done: number; total: number }) => p.done <= p.total,
  params: { message: "done must not exceed total", path: ["done"] },
};

export const JobProgress = z
  .strictObject({
    jobId: Id,
    done: Count,
    total: Count,
  })
  .refine(doneWithinTotal.check, doneWithinTotal.params);

/** A batch's slot, 1 to 4. */
const CandidateSlot = z.number().int().min(1).max(4);

/**
 * A slot of a finished batch that gave no candidate:
 * - `age-rejected`: the age check did not say a clear yes; the image was dropped.
 * - `failed`: the slot could not finish; `error` says why (MODERATION_REFUSED,
 *   TIMEOUT, NETWORK, BUDGET_EXCEEDED, ...). `reserveLeftOpen`: its request may
 *   have been billed (a timeout, a network error), so it counts at its worst
 *   case until the user reconciles.
 */
export const FailedCandidateSlot = z.discriminatedUnion("reason", [
  z.strictObject({ slot: CandidateSlot, reason: z.literal("age-rejected") }),
  z.strictObject({ slot: CandidateSlot, reason: z.literal("failed"), error: EngineError, reserveLeftOpen: z.boolean() }),
]);

export const CandidatesResult = z
  .strictObject({
    kind: z.literal("avatar.candidates"),
    avatarId: Id,
    candidates: z.array(Candidate).max(4),
    rejectedByAgeCheck: Count,
    /** Every slot that gave no candidate, so a batch of fewer than four explains itself. */
    failedSlots: z.array(FailedCandidateSlot).max(4),
  })
  .refine((r) => r.candidates.every((c) => c.avatarId === r.avatarId), {
    message: "every candidate must belong to the job's avatar",
    path: ["candidates"],
  })
  .refine((r) => r.candidates.length + r.failedSlots.length <= 4, {
    message: "candidates and failed slots are at most the four slots of a batch",
    path: ["failedSlots"],
  })
  .refine((r) => unique(r.failedSlots.map((f) => f.slot)), { message: "a slot must not repeat", path: ["failedSlots"] })
  .refine((r) => r.rejectedByAgeCheck === r.failedSlots.filter((f) => f.reason === "age-rejected").length, {
    message: "rejectedByAgeCheck must be the number of age-rejected slots",
    path: ["rejectedByAgeCheck"],
  });

export const RunResult = z.strictObject({
  kind: z.literal("run"),
  runId: Id,
  photoIds: z.array(Id),
  failedSlots: Count,
});

export const JobResult = z.discriminatedUnion("kind", [CandidatesResult, RunResult]);

const jobCommon = {
  jobId: Id,
  status: JobStatus,
  done: Count,
  total: Count,
  error: EngineError.optional(),
};

/** A job as a snapshot restores it: what it works on, how far it got, and how it ended. */
export const JobState = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("avatar.candidates"),
      avatarId: Id,
      ...jobCommon,
      result: CandidatesResult.optional(),
    }),
    z.strictObject({
      kind: z.literal("run"),
      runId: Id,
      ...jobCommon,
      result: RunResult.optional(),
    }),
  ])
  .refine(doneWithinTotal.check, doneWithinTotal.params)
  .refine((j) => (j.status === "done") === (j.result !== undefined), {
    message: "result must be present exactly when the job is done",
    path: ["result"],
  })
  .refine((j) => (j.status === "failed") === (j.error !== undefined), {
    message: "error must be present exactly when the job failed",
    path: ["error"],
  })
  .refine(
    (j) => {
      if (j.kind === "avatar.candidates") return j.result === undefined || j.result.avatarId === j.avatarId;
      return j.result === undefined || j.result.runId === j.runId;
    },
    { message: "result must belong to this job", path: ["result"] },
  );

// ---------- photos (2b placeholders) ----------

/** Scene categories from the Photos mockup; revealing outfits are out of Stage 2. */
export const SceneCategory = z.enum(["home", "travel", "shoot", "glam", "fit"]);
export const Resolution = z.enum(["1k", "2k"]);

export const RunRequest = z.strictObject({
  avatarId: Id,
  count: z.number().int().min(1).max(100),
  categories: z.array(SceneCategory).min(1).refine(unique, "categories must not repeat"),
  resolution: Resolution,
});

export const PhotoSummary = z.strictObject({
  photoId: Id,
  avatarId: Id,
  runId: Id.nullable(),
  category: SceneCategory,
  resolution: Resolution,
  createdAt: IsoDateTime,
});

export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>;
export type Settings = z.infer<typeof Settings>;
export type ReconcileReason = z.infer<typeof ReconcileReason>;
export type MoneyHalt = z.infer<typeof MoneyHalt>;
export type LedgerUnavailable = z.infer<typeof LedgerUnavailable>;
export type MoneyStatus = z.infer<typeof MoneyStatus>;
export type OpenMoneyStatus = Extract<MoneyStatus, { ledger: "open" }>;
export type ReconcileWarning = z.infer<typeof ReconcileWarning>;
export type NoticeCode = z.infer<typeof NoticeCode>;
export type EngineNotice = z.infer<typeof EngineNotice>;
export type Estimate = z.infer<typeof Estimate>;
export type ReconcileResult = z.infer<typeof ReconcileResult>;
export type Candidate = z.infer<typeof Candidate>;
export type Draft = z.infer<typeof Draft>;
export type AvatarSummary = z.infer<typeof AvatarSummary>;
export type UnreadableReason = z.infer<typeof UnreadableReason>;
export type UnreadableDetail = z.infer<typeof UnreadableDetail>;
export type UnreadableAvatar = z.infer<typeof UnreadableAvatar>;

/** The fixed, short English detail of each reason: never the descriptor or the vibe, whatever the manifest held. */
export const UNREADABLE_REASON_DETAIL: Record<UnreadableReason, UnreadableDetail> = {
  "manifest-unreadable": "its manifest file could not be read or parsed",
  "descriptor-invalid": "its stored descriptor no longer fits today's rules",
  "contract-mismatch": "its stored record no longer fits the contract",
};
export type JobState = z.infer<typeof JobState>;
export type JobResult = z.infer<typeof JobResult>;
export type FailedCandidateSlot = z.infer<typeof FailedCandidateSlot>;
export type RunRequest = z.infer<typeof RunRequest>;
export type PhotoSummary = z.infer<typeof PhotoSummary>;
