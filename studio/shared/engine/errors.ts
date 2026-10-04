import { z } from "zod";
import { MAX_MONTAGE_ISSUES, MontageIssue } from "./montage";
import { MediaUnsupportedReason } from "./media";
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
 *   `montages.textPreview` uses it too, for a text render that ran out of time (`detail` ends with the hint to shrink the caption
 *   or change the style; the window shows that hint itself, since this code's fixed message speaks of a video) or that resvg, the
 *   template or the text worker failed. The engine never retries it.
 * - RENDER_VERIFY_FAILED: the finished file did not pass the output verifier (metadata allowlist, frame count); it is not kept.
 * - RENDER_QUEUE_FULL: `videos.render` was refused up front because the render queue already holds its most (queued and
 *   running together); `detail` carries the limit. Nothing was reserved or written; retry once some renders end.
 * - TEXT_INVALID: a caption breaks the caption rules (3b.3), so nothing is drawn: `captionIssue` says which rule, the
 *   first that fails in `CAPTION_ISSUES` order. Never retried; the text has to change. A rasteriser timeout is
 *   RENDER_FAILED, not this.
 * - TEXT_PREVIEW_SUPERSEDED: a `montages.textPreview` that was still waiting its turn was dropped because a newer preview of the
 *   same layer arrived. Nothing was drawn and nothing is wrong; the window already asked for the newer one and ignores this.
 *   A preview that is already being drawn is never cancelled: it is answered.
 * - LIBRARY_TOO_NEW: a video record was written by a newer Studio. What follows is per record and per avatar:
 *   `videos.render` refuses for an avatar that has such a record (its usage cannot be trusted), `videos.delete` refuses
 *   that record, and `videos.list` leaves it out. The owner updates the app.
 *
 * Stage 3 own media (3f.1b, K30):
 * - MEDIA_UNSUPPORTED: an own file was turned away (at the pick, or by the import job); `mediaReason` says why and carries the
 *   Russian text (`MEDIA_REASONS_RU`): `heic` is «сохраните как JPEG», `too-large` and `no-space` say what to change, `changed` that
 *   the file may be picked again. A reason never carries a path.
 *
 * Stage 3 music (the flashapi list; a request costs one of 30 per 31 days):
 * - MUSIC_KEY_MISSING: no RapidAPI key is stored, so nothing is sent and no quota is spent.
 * - MUSIC_KEY_REJECTED: flashapi answered 401 to this key (now or on an earlier refresh, remembered across restarts), or
 *   the stored key is already known to be rejected: nothing is sent until the key is replaced.
 * - MUSIC_QUOTA_EXHAUSTED: the local count reached the limit within the last 31 days, or the server's last answer said 0
 *   requests remained; nothing is sent (`MusicStatus.nextFreeAt` says when the next request may leave).
 * - MUSIC_UNAVAILABLE: the request was made or could not be made, and no usable list came of it (network, timeout,
 *   an HTTP error other than 401, an answer that is too large or has no usable track, or the quota log cannot be
 *   written so nothing was sent). `musicReason` says which (3c.6), `detail` says more, redacted of the key.
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
  "RENDER_QUEUE_FULL",
  "LIBRARY_TOO_NEW",
  "TEXT_INVALID",
  "TEXT_PREVIEW_SUPERSEDED",
  "MUSIC_KEY_MISSING",
  "MUSIC_KEY_REJECTED",
  "MUSIC_QUOTA_EXHAUSTED",
  "MUSIC_UNAVAILABLE",
  "MEDIA_UNSUPPORTED",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);

/**
 * Why the export folder cannot take a video (invariant 35): it is gone, it is a
 * file, it is read-only, it is full, it overlaps the library folder (the export
 * must never sit inside the library or contain it), or its root marker
 * `.studio-export.json` is unreadable or invalid (never silently replaced), or
 * the marker was written by a newer Studio (`newer-marker`: not damaged, so the
 * owner must never be told to delete it).
 *
 * `invalid-marker-with-records` is `invalid-marker` for a library that already holds video records (3e.3): the damaged
 * marker may be the very one those records name, so the owner is never told to delete, move or rename it (a fresh
 * marker would have a new id, and every record would read `elsewhere`). The engine makes the call; `invalid-marker`
 * stays for a library with no records, where deleting the file costs nothing.
 */
export const EXPORT_UNAVAILABLE_REASONS = [
  "missing",
  "not-a-directory",
  "not-writable",
  "not-enough-space",
  "overlaps-library",
  // The engine's own work folder (`userData/render-tmp`, swept at every start): what is exported there would be deleted.
  "overlaps-work-folder",
  "invalid-marker",
  "invalid-marker-with-records",
  "newer-marker",
] as const;
export const ExportUnavailableReason = z.enum(EXPORT_UNAVAILABLE_REASONS);
export type ExportUnavailableReason = z.infer<typeof ExportUnavailableReason>;

/**
 * Which caption rule a text breaks (K19), in the order the engine reports them: a text that breaks several
 * carries the first one. The rules themselves live in the engine (`captionIssues`); this is the closed
 * vocabulary that travels, texts in `CAPTION_ISSUES_RU`.
 *
 * - charset: a character outside printable ASCII and ’ ‘ “ ” – — …, a control character, or © ® ™ in any form.
 * - emoji-missing: an emoji the bundled emoji font cannot draw (also a lone flag half, a bare subdivision-flag tag).
 * - emoji-text-style: an emoji forced to text presentation (VS15), which the font cannot draw that way.
 * - too-long: over 60 characters as a person counts them.
 * - too-many-lines: over 2 lines.
 */
export const CAPTION_ISSUES = ["charset", "emoji-missing", "emoji-text-style", "too-long", "too-many-lines"] as const;
export const CaptionIssue = z.enum(CAPTION_ISSUES);
export type CaptionIssue = z.infer<typeof CaptionIssue>;

/**
 * Why music could not be fetched (3c.6): the cause behind MUSIC_UNAVAILABLE, so the window says what the owner can do
 * («позже» is true for only a few). Grouped by what was spent.
 *
 * Nothing was sent:
 * - shutting-down: the engine is stopping.
 * - not-available: this build has no persisting list store (the 3c.3 switch).
 * - no-music-folder: the engine was given no music folder, so there is no quota log.
 * - clock: the system clock is not a real date, so the 31-day window cannot be counted.
 * - config: the client could not be set up (a base URL or key the client refuses).
 * - log-held: a result or key-change line from earlier still waits to be written to the quota log.
 * - log-unwritable: the quota log could not be written now.
 * - log-unreadable: the quota log could not be read.
 * - log-corrupt: the quota log has a complete line that cannot be read (`music.recoverQuotaLog` is the way out).
 * - log-missing: the quota log is gone although requests were sent before (its marker says so): the same way out.
 *
 * The request left and counts:
 * - network: no answer (network, timeout).
 * - forbidden: 403, most likely no subscription to the API on the key.
 * - rate-limited: 429 (`retryAfterMs` when the server named a wait).
 * - server: another HTTP error.
 * - bad-answer: an answer too large, not a list, or with no usable track.
 * - store-failed: the list came, and storing it or its tracks failed.
 *
 * The downloads of a list fetched earlier (no request to flashapi):
 * - downloads-stopped: the CDN refused the sampled downloads alike, so the run stopped and kept every URL for the next start.
 * - downloads-failed: finishing an earlier refresh's downloads failed.
 */
export const MUSIC_UNAVAILABLE_REASONS = [
  "shutting-down",
  "not-available",
  "no-music-folder",
  "clock",
  "config",
  "log-held",
  "log-unwritable",
  "log-unreadable",
  "log-corrupt",
  "log-missing",
  "network",
  "forbidden",
  "rate-limited",
  "server",
  "bad-answer",
  "store-failed",
  "downloads-stopped",
  "downloads-failed",
] as const;
export const MusicUnavailableReason = z.enum(MUSIC_UNAVAILABLE_REASONS);
export type MusicUnavailableReason = z.infer<typeof MusicUnavailableReason>;

/**
 * An error as it travels between processes: a code plus optional diagnostics,
 * never user text. Six codes must say more than their name: MONTAGE_INVALID
 * carries the `issues` (a closed list of codes and paths, never values),
 * PHOTO_UNAVAILABLE the same list with only `photo-unavailable` issues (which
 * cells), EXPORT_UNAVAILABLE its `exportReason`, TEXT_INVALID its
 * `captionIssue`, MUSIC_UNAVAILABLE its `musicReason` and MEDIA_UNSUPPORTED its
 * `mediaReason`; no other code carries any.
 */
export const EngineError = z
  .strictObject({
    code: ErrorCode,
    detail: SafeText.optional(),
    retryAfterMs: Count.optional(),
    issues: z.array(MontageIssue).min(1).max(MAX_MONTAGE_ISSUES).optional(),
    exportReason: ExportUnavailableReason.optional(),
    captionIssue: CaptionIssue.optional(),
    musicReason: MusicUnavailableReason.optional(),
    mediaReason: MediaUnsupportedReason.optional(),
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
  })
  .refine((e) => (e.code === "TEXT_INVALID") === (e.captionIssue !== undefined), {
    message: "captionIssue must be present exactly on TEXT_INVALID",
    path: ["captionIssue"],
  })
  .refine((e) => (e.code === "MUSIC_UNAVAILABLE") === (e.musicReason !== undefined), {
    message: "musicReason must be present exactly on MUSIC_UNAVAILABLE",
    path: ["musicReason"],
  })
  .refine((e) => (e.code === "MEDIA_UNSUPPORTED") === (e.mediaReason !== undefined), {
    message: "mediaReason must be present exactly on MEDIA_UNSUPPORTED",
    path: ["mediaReason"],
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

/**
 * `EngineError.detail` of an INTERNAL `montages.get` for a draft file written by a newer Studio (3d.1a). The
 * window tells the owner to update the app (studio/renderer/lib/errors.ts), never that the draft is broken or
 * gone. A plain string, not a new `ErrorCode`, like `ENGINE_GONE_DETAIL`: only the detail tells it apart.
 */
export const DRAFT_TOO_NEW_DETAIL = "this draft was written by a newer version of Studio; update the app to open it";

/**
 * `EngineError.detail` of an INTERNAL `montages.get` for a draft whose file was replaced by saves faster than it
 * could be read: a retry reads it, so the window retries and never offers to delete the draft.
 */
export const DRAFT_CHANGING_DETAIL = "the draft was changed just now and could not be read; try again";

/**
 * `EngineError.detail` of an IN_FLIGHT `videos.render` refused because the export folder is being switched (3e.3): nothing was
 * queued and a retry a moment later goes through. IN_FLIGHT otherwise means paid requests; the window tells the two apart by this.
 */
export const EXPORT_CHANGING_DETAIL = "the export folder is being changed; try the render again in a moment";

/**
 * `EngineError.detail` of an INTERNAL `videos.render` that ran out of its 25 s command budget BEFORE the job was queued: nothing was
 * queued, so retrying is safe (unlike main's no answer at all, `NO_ANSWER_DETAIL_PREFIX`, where the job may exist).
 */
export const RENDER_NOT_QUEUED_DETAIL = "the render request ran out of time before it could be queued; nothing was queued";

/**
 * `EngineError.detail` of the NOT_FOUND `montages.focus` answers for an own photo the library does not hold (3f.2). The text is the one the
 * answer had before the media store existed, kept word for word because the parity suite's golden transcript names it (the goldens are
 * append-only); the engine and the mock both use THIS constant. The renderer shows a Russian text by code, never this detail.
 */
// Do not "fix" the wording: parity/testing/golden.ts is APPEND-ONLY and its `montages.focus: judged, unjudged, refused` line carries this exact text.
export const OWN_PHOTO_NOT_FOUND_DETAIL = "own photos are not available yet";

/**
 * `EngineError.detail` of the NOT_FOUND `music.peaks` answers for an own track the library does not hold, or holds as something that is not a track
 * (3f.4). Kept word for word for the same reason as `OWN_PHOTO_NOT_FOUND_DETAIL`: the parity golden's `music.peaks` line carries this exact text.
 */
// Do not "fix" the wording: parity/testing/golden.ts is APPEND-ONLY and its `music.peaks` lines for an own track carry this exact text.
export const OWN_MUSIC_NOT_FOUND_DETAIL = "own music is not available yet";

/** The start of the detail main gives a command the engine did not answer in time (`the engine did not answer within 30 s`): the command may still have been carried out. */
/**
 * What a render's TIMEOUT detail starts with (the render queue writes `... of N s` after it): a render that ran past its time limit, in ffmpeg or in the staging of its
 * files. The window keys its own text on it, since the general TIMEOUT text is about a paid OpenRouter request.
 */
export const RENDER_TIMEOUT_DETAIL_PREFIX = "the render ran past its time limit";

export const NO_ANSWER_DETAIL_PREFIX = "the engine did not answer within ";

/** `RENDER_QUEUE_FULL`'s detail: it names the limit, which `renderQueueLimitOf` reads back for the window's text. */
export function renderQueueFullDetail(limit: number): string {
  return `the render queue is full: ${limit} renders are already queued or running`;
}

/** The limit a `RENDER_QUEUE_FULL` detail names; null for any other text. */
export function renderQueueLimitOf(detail: string | undefined): number | null {
  const match = /^the render queue is full: (\d{1,6}) renders are already queued or running$/.exec(detail ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}
