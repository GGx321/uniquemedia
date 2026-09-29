import { z } from "zod";
import { MAX_MONTAGE_ISSUES, MontageIssue } from "./montage";
import { Count, SafeText } from "./primitives";

/**
 * The closed set of error codes the engine and main can report.
 * User-facing text is kept apart, in `errorMessagesRu.ts`.
 *
 * - AUTH_INVALID: OpenRouter 401; the run stops and is never retried.
 * - INSUFFICIENT_CREDITS: OpenRouter 402.
 * - BUDGET_EXCEEDED: the monthly budget from Settings would be exceeded.
 * - RUN_CAP_EXCEEDED: the run's (or avatar job's) own cap would be exceeded.
 * - MODERATION_REFUSED: the provider refused the prompt or reference.
 * - RATE_LIMITED: 429 after transport retries; may carry `retryAfterMs`.
 * - NETWORK / TIMEOUT: transport failures (a timeout costs the worst case until reconciled).
 * - RECONCILE_REQUIRED: paid calls are blocked until the user reconciles.
 * - ENCRYPTION_UNAVAILABLE: `safeStorage` cannot encrypt, so the key is not stored.
 * - VALIDATION: a message or payload failed the contract.
 * - NOT_FOUND: an id did not resolve.
 * - INTERNAL: anything else.
 *
 * Fatal money codes (paid calls stop until the cause is dealt with):
 * - LEDGER_CORRUPT: a ledger line other than the last one cannot be read.
 * - LEDGER_UNREADABLE: the ledger file itself could not be read (permissions, I/O).
 * - SETTLE_ABOVE_WORST: a settle reported more than its reserve's worst case.
 * - LEDGER_WRITE_FAILED: a reserve or settle could not be written and fsynced.
 * - PRICE_UNAVAILABLE: neither live prices nor the fallback table cover the model.
 * - PRICE_CHANGED: the current worst case exceeds the `acceptedWorstMicros` the user agreed to.
 * - IN_FLIGHT: refused while paid requests are still in flight (e.g. reconcile, library move).
 * - LIBRARY_UNAVAILABLE: no library is open (its folder is missing or unreadable), so nothing that
 *   stores results is started and nothing is spent.
 * - DESCRIPTOR_INVALID: the avatar's stored descriptor fails today's adult-text rules, so no prompt
 *   is built from it and nothing is spent; the descriptor has to be rewritten.
 * - AGE_CHECK_FAILED: importing an avatar's one-time image age check did not clearly confirm an
 *   adult (T6c); the import is refused and nothing is stored.
 * - IMPORT_SUBJECT_INVALID: the imported photo's vision describe call did not recognise exactly
 *   one woman (T6c, review round 2, M5) — a group photo, an empty one, or a person who is not a
 *   woman; never retried (the photo does not change between attempts), nothing is stored.
 * - QA_REJECTED: a photo run's slot ended without a photo because a QA gate (face, near-duplicate,
 *   age) rejected its image, or asked for another attempt after the slot's last one (T6).
 * - AGE_GATE_UNAVAILABLE: the image age check is on, but the engine has no age gate among its QA
 *   gates (a wiring defect of the build: production always registers it), so a run would store
 *   photos no age check has seen (invariant 8); nothing is started or spent.
 * - FACE_GATE_UNAVAILABLE: no face gate is wired into photo runs (T7b, e.g. the face models or
 *   onnxruntime-web failed to load at engine startup), so a run would store photos no identity
 *   check has seen; nothing is started or spent. Unlike the age gate this is never a Settings
 *   toggle — the face gate is always required, so this only ever means the gate itself is broken.
 * - MASTER_FACE_UNUSABLE: money review H1 — a gate's `prepare()` (runs/qa.ts) failed before any
 *   paid work of the job (the writer phase, an image request), specifically because the face gate
 *   found no detectable face in the avatar's master photo (re-review N3: `NoFaceInReferenceError`
 *   only — a decode/library/ORT failure in `prepare()` is systemic instead, INTERNAL, never this
 *   code, since it does not mean the master itself is unusable). The job ends failed right there,
 *   before a single request is sent.
 *
 * Stage 3 (the montage renders; they never spend money):
 * - MONTAGE_INVALID: the montage cannot be rendered (or is not yet supported): `issues` lists why.
 * - PHOTO_UNAVAILABLE: a scene photo in the spec is not an eligible one (a candidate, the master, an
 *   import, an age-failed or rejected photo, another avatar's, or a missing one); refused before ffmpeg starts.
 *   `issues` names the cells (`photo-unavailable` at each path).
 * - EXPORT_UNAVAILABLE: the «Готовые видео» folder cannot take the video (invariant 35); `exportReason` says why.
 *   Refused before a job is queued, or fails the job when the folder vanishes mid-render.
 * - RENDER_FAILED: ffmpeg or the render pipeline failed; the stderr tail goes to `detail`.
 * - RENDER_VERIFY_FAILED: the finished file did not pass the output verifier (metadata allowlist, frame count); it is not kept.
 */
export const ERROR_CODES = [
  "AUTH_INVALID",
  "INSUFFICIENT_CREDITS",
  "BUDGET_EXCEEDED",
  "RUN_CAP_EXCEEDED",
  "MODERATION_REFUSED",
  "RATE_LIMITED",
  "NETWORK",
  "TIMEOUT",
  "RECONCILE_REQUIRED",
  "ENCRYPTION_UNAVAILABLE",
  "VALIDATION",
  "NOT_FOUND",
  "INTERNAL",
  "LEDGER_CORRUPT",
  "LEDGER_UNREADABLE",
  "SETTLE_ABOVE_WORST",
  "LEDGER_WRITE_FAILED",
  "PRICE_UNAVAILABLE",
  "PRICE_CHANGED",
  "IN_FLIGHT",
  "LIBRARY_UNAVAILABLE",
  "DESCRIPTOR_INVALID",
  "AGE_CHECK_FAILED",
  "IMPORT_SUBJECT_INVALID",
  "QA_REJECTED",
  "AGE_GATE_UNAVAILABLE",
  "FACE_GATE_UNAVAILABLE",
  "MASTER_FACE_UNUSABLE",
  "MONTAGE_INVALID",
  "PHOTO_UNAVAILABLE",
  "EXPORT_UNAVAILABLE",
  "RENDER_FAILED",
  "RENDER_VERIFY_FAILED",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);

/** Why the export folder cannot take a video (invariant 35): it is gone, it is a file, it is read-only, or it is full. */
export const EXPORT_UNAVAILABLE_REASONS = ["missing", "not-a-directory", "not-writable", "not-enough-space"] as const;
export const ExportUnavailableReason = z.enum(EXPORT_UNAVAILABLE_REASONS);
export type ExportUnavailableReason = z.infer<typeof ExportUnavailableReason>;

/**
 * An error as it travels between processes: a code plus optional diagnostics,
 * never user text. Three codes must say more than their name: MONTAGE_INVALID
 * carries the `issues` (a closed list of codes and paths, never values),
 * PHOTO_UNAVAILABLE the same list with only `photo-unavailable` issues (which
 * cells), and EXPORT_UNAVAILABLE its `exportReason`; no other code carries any.
 */
export const EngineError = z
  .strictObject({
    code: ErrorCode,
    detail: SafeText.optional(),
    retryAfterMs: Count.optional(),
    issues: z.array(MontageIssue).min(1).max(MAX_MONTAGE_ISSUES).optional(),
    exportReason: ExportUnavailableReason.optional(),
  })
  .refine((e) => (e.code === "MONTAGE_INVALID" || e.code === "PHOTO_UNAVAILABLE") === (e.issues !== undefined), {
    message: "issues must be present exactly on MONTAGE_INVALID and PHOTO_UNAVAILABLE",
    path: ["issues"],
  })
  .refine((e) => e.code !== "PHOTO_UNAVAILABLE" || (e.issues ?? []).every((i) => i.code === "photo-unavailable"), {
    message: "PHOTO_UNAVAILABLE lists photo-unavailable issues only",
    path: ["issues"],
  })
  .refine((e) => (e.code === "EXPORT_UNAVAILABLE") === (e.exportReason !== undefined), {
    message: "exportReason must be present exactly on EXPORT_UNAVAILABLE",
    path: ["exportReason"],
  });

export type ErrorCode = z.infer<typeof ErrorCode>;
export type EngineError = z.infer<typeof EngineError>;

/**
 * `EngineError.detail` for the one case the renderer must tell apart from
 * every other INTERNAL: the engine is dead for good (it crashed too many
 * times and main gave up restarting it), not merely unreachable for a
 * moment. main's `EngineHost` uses this on every answer once it gives up,
 * and the renderer matches on it to show a message that does not offer a
 * retry that can never succeed (studio/renderer/ui/EngineOffline.tsx). A
 * plain string, not a new `ErrorCode`: the code stays INTERNAL either way,
 * this only distinguishes the detail.
 */
export const ENGINE_GONE_DETAIL = "the engine crashed too many times and will not be restarted";

/**
 * `EngineError.detail` for the one AGE_CHECK_FAILED case the renderer must
 * tell apart from every other one (T6c review H2, M2): re-picking a photo
 * the mandatory one-time age check already refused is refused again for
 * free, before anything is downscaled or paid for — unlike the ordinary
 * AGE_CHECK_FAILED, nothing is charged this time. A plain string, not a new
 * `ErrorCode`: the code stays AGE_CHECK_FAILED either way, this only
 * distinguishes the detail (studio/renderer/lib/errors.ts).
 */
export const AGE_CHECK_ALREADY_REFUSED_DETAIL = "this exact photo was already refused by the one-time image age check; nothing was charged this time";
