import { z } from "zod";
import { AvatarDescriptor, AvatarName, AvatarStatus, AvatarTraits } from "./avatar";
import { EngineError } from "./errors";
import { AbsolutePath, Count, Id, Micros, ModelId } from "./primitives";

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

export const MoneyStatus = z
  .strictObject({
    month: YearMonth,
    spentMicros: Micros,
    monthlyBudgetMicros: Micros,
    /** Worst case of every reserve without a settle or release. */
    unsettledMicros: Micros,
    unsettledCount: Count,
    reconcileNeeded: z.boolean(),
    reconcileReasons: ReconcileReasons,
  })
  .refine((s) => s.reconcileNeeded === s.reconcileReasons.length > 0, {
    message: "reconcileReasons must be non-empty exactly when reconcileNeeded is true",
    path: ["reconcileReasons"],
  });

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

/** Result of `money.reconcile`: both totals for the window, or how long to wait for `/credits` to catch up. */
export const ReconcileResult = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("done"),
    creditsDeltaMicros: Micros,
    ledgerDeltaMicros: Micros,
    closedReserves: Count,
    tornLineMoved: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("too-early"),
    retryAfterMs: z.number().int().positive(),
  }),
]);

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
    /** The avatar job's estimate: descriptor + candidates + age checks (its cap). */
    estimate: Estimate,
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

export const CandidatesResult = z
  .strictObject({
    kind: z.literal("avatar.candidates"),
    avatarId: Id,
    candidates: z.array(Candidate).max(4),
    rejectedByAgeCheck: Count,
  })
  .refine((r) => r.candidates.every((c) => c.avatarId === r.avatarId), {
    message: "every candidate must belong to the job's avatar",
    path: ["candidates"],
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
export type MoneyStatus = z.infer<typeof MoneyStatus>;
export type Estimate = z.infer<typeof Estimate>;
export type ReconcileResult = z.infer<typeof ReconcileResult>;
export type Candidate = z.infer<typeof Candidate>;
export type Draft = z.infer<typeof Draft>;
export type AvatarSummary = z.infer<typeof AvatarSummary>;
export type JobState = z.infer<typeof JobState>;
export type JobResult = z.infer<typeof JobResult>;
export type RunRequest = z.infer<typeof RunRequest>;
export type PhotoSummary = z.infer<typeof PhotoSummary>;
