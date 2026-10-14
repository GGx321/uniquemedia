import { z } from "zod";
import { AttemptId, CLIP_RETRYABLE_FAILURES, ClipAttemptModel, ClipExportLine, ClipFace, ClipFailReason, ClipModelUsed, ClipMotion, ClipRequest, Id, Micros, Sha256Hex } from "../../shared/engine";
import { CLIP_RECORD_SCHEMA_VERSION } from "../library/layout";

// Stage 5, 5b.1, S5.V1 (plan s5b1 §5.3): what a clip writes to disk, as pure zod. Both are READ from disk, so both are strict: a file that does not parse is not a record.
//
// `<clipId>.json` is the record and the commit (I5.53): it exists only for a playable validated file or a terminal failure, and is rewritten only for the `seen` flag, an appended
// export, and a failed download that becomes ready. It has no money field: a clip's cost is read from the ledger when the clip is listed (I5.49).
// `<clipId>.journal.jsonl` is append-only, one fsynced line per event while the clip is in flight (I5.45); a line of a kind this build does not know is skipped, never fatal.

const At = z.iso.datetime();

/** The provider's job id: an opaque token. It never holds a URL or a path, because it is the one id of the provider's that reaches a file. */
const ProviderJobId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "must be an opaque token of at most 128 characters");

/** How one attempt ended. `refused` is a content refusal, `uncertain` a submit whose outcome is not known, `late` an attempt that passed its lifetime. */
export const ClipAttemptOutcome = z.enum(["completed", "failed", "cancelled", "expired", "refused", "uncertain", "late"]);
export type ClipAttemptOutcome = z.infer<typeof ClipAttemptOutcome>;

/** Where an attempt's settled cost came from, in the order of I5.46: `usage.cost` on the poll, `/generation`'s `total_cost`, the proof of a free refusal, the worst case, or nothing. */
export const ClipCostSource = z.enum(["usage", "generation", "proof", "worst", "none"]);
export type ClipCostSource = z.infer<typeof ClipCostSource>;

const RecordAttempt = z.strictObject({
  attemptId: AttemptId,
  providerJobId: ProviderJobId.optional(),
  outcome: ClipAttemptOutcome,
  providerCostMicros: Micros.optional(),
  costSource: ClipCostSource,
});

const ReadyOutcome = z.strictObject({
  status: z.literal("ready"),
  /** `<clipId>.mp4`: the provider's bytes, unmodified (I5.54). The record names its files so a hand-edited record cannot point outside the clips folder. */
  file: z.string(),
  /** `<clipId>.poster.jpg`: the frame at 0.5 s. */
  posterFile: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  fps: z.number().positive().max(240),
  bytes: z.number().int().positive(),
  sha256: Sha256Hex,
  face: ClipFace,
});

const FailedOutcome = z
  .strictObject({
    status: z.literal("failed"),
    reason: ClipFailReason,
    /** The time a failed download can still be retried free (the submit + 60 min). */
    retryDownloadUntil: At.optional(),
  })
  .refine((o) => o.retryDownloadUntil === undefined || CLIP_RETRYABLE_FAILURES.includes(o.reason), {
    message: "only a failed download can be retried",
    path: ["retryDownloadUntil"],
  });

export const ClipRecord = z
  .strictObject({
    schemaVersion: z.literal(CLIP_RECORD_SCHEMA_VERSION),
    id: Id,
    avatarId: Id,
    sourcePhotoId: Id,
    createdAt: At,
    seen: z.boolean(),
    motion: ClipMotion,
    request: ClipRequest,
    provider: z.strictObject({
      /** The model that made the file, or that tried last. */
      model: ClipModelUsed,
      /** Kling, then Grok when it fell back: at most two. */
      attempts: z.array(RecordAttempt).max(2),
    }),
    recovered: z.boolean(),
    /** Written once per export, never rewritten; the computed `fileState` is not stored. */
    exports: z.array(ClipExportLine).max(200),
    outcome: z.discriminatedUnion("status", [ReadyOutcome, FailedOutcome]),
  })
  .refine((r) => r.outcome.status !== "ready" || (r.outcome.file === `${r.id}.mp4` && r.outcome.posterFile === `${r.id}.poster.jpg`), {
    message: "a clip's files are named after the clip",
    path: ["outcome"],
  })
  .refine((r) => r.outcome.status === "ready" || r.exports.length === 0, { message: "a clip that failed has nothing exported", path: ["exports"] });
export type ClipRecord = z.infer<typeof ClipRecord>;

/** `requested`: the first line, fsynced before the clip's first reserve (I5.45). */
const RequestedLine = z.strictObject({
  type: z.literal("requested"),
  clipId: Id,
  photoId: Id,
  request: ClipRequest,
  motion: ClipMotion,
  acceptedWorstMicros: Micros,
  at: At,
});

/** `submitted`: after the 2xx and before the first poll or any other line (I5.45). */
const SubmittedLine = z.strictObject({
  type: z.literal("submitted"),
  attemptId: AttemptId,
  model: ClipAttemptModel,
  providerJobId: ProviderJobId,
  at: At,
});

/** The reasons a POST the provider refused with a 4xx that is not moderation can carry (`attempt.ts` `reasonOfKind` emits exactly these). */
export const PostRefusalReason = z.enum(["rate-limited", "key-invalid", "no-credits", "bad-request"]);
export type PostRefusalReason = z.infer<typeof PostRefusalReason>;

const EndedLine = z.strictObject({
  type: z.literal("ended"),
  attemptId: AttemptId,
  status: ClipAttemptOutcome,
  providerCostMicros: Micros.optional(),
  costSource: ClipCostSource,
  /** A POST the provider refused with a 4xx that is not moderation: why, so a restart records the reason the live path did (VR item 2). The ledger already holds 0 for it. */
  failReason: PostRefusalReason.optional(),
  /** Required: after a restart the «terminal + 2 min» hold of a late `completed` (I5.48) is read from it. */
  at: At,
});

const DownloadedLine = z.strictObject({
  type: z.literal("downloaded"),
  sha256: Sha256Hex,
  bytes: z.number().int().positive(),
  at: At.optional(),
});

export const ClipJournalLine = z.discriminatedUnion("type", [RequestedLine, SubmittedLine, EndedLine, DownloadedLine]);
export type ClipJournalLine = z.infer<typeof ClipJournalLine>;

/** One parsed journal line, or null for a line this build does not know or that does not fit: skipped, never fatal, never thrown. */
export function parseClipJournalLine(raw: unknown): ClipJournalLine | null {
  const parsed = ClipJournalLine.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
