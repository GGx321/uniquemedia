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
 * - PHOTO_UNAVAILABLE: a scene photo in the spec (or in a `montages.create` pick) cannot go into a video: it is not an eligible one
 *   (a candidate, the master, an import, an age-failed or rejected photo, another avatar's, or a missing one), it is already in a video
 *   (one photo, one video), a queued or running render holds it, or the avatar's usage cannot be trusted (a stale used index, or a record
 *   or reject log that needs repair: then EVERY photo of the avatar is refused); refused before ffmpeg starts.
 *   `issues` names the cells (`photo-unavailable` at each path); `photoReason` says which cause when the refused cells share a
 *   cause the owner can act on (`PHOTO_UNAVAILABLE_REASONS`), and `detail` is the engine's own words for the log.
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
 * «Удалить аватар» (2026-10-05):
 * - TRASH_UNAVAILABLE: the system Trash cannot take the avatar's folder (a network drive or a volume with no Trash, or the move failed), so
 *   NOTHING was deleted and the avatar stays as it was. Never a permanent delete in its place.
 *   `avatars.delete` also answers IN_FLIGHT while anything of the avatar runs or is reserved (a photo run, a candidate job, a render, a pending
 *   video, a draft being saved) or a library switch is under way, and NOT_FOUND for an avatar the library does not have.
 *
 * Custom categories (CS.2):
 * - POOL_REJECTED: the text model answered a category's pool twice and neither answer could be used (not the JSON asked for, empty, or
 *   too little left once every item that breaks the pool rules was dropped); both attempts are paid and booked, nothing is stored, and
 *   the owner rewords the description. `spentMicros` says what the call cost.
 *
 * Scene sets (CS.4a):
 * - SCENES_CHANGED: the scene set moved since the window read it (another window edited it, or a write landed): the revision the command carried
 *   is not the set's current one. Free: nothing was changed or sent, and the window reads the set again (`scenes.changed` follows).
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
  "TRASH_UNAVAILABLE",
  "POOL_REJECTED",
  "SCENES_CHANGED",
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
 * Why a scene photo was refused (PHOTO_UNAVAILABLE's `photoReason`, additive in v5): the window's text depends on it, so it is a closed
 * code and not the engine's free `detail`. Absent when the cause is one the owner cannot act on (a rejected, missing or foreign photo),
 * or when the refused cells have different causes.
 *
 * - in-video: the photo is already in a video (one photo, one video).
 * - held-by-render: a render that is queued or running holds the photo.
 * - pending-video: no render holds the photo, but a video that did not finish saving (a pending commit intent, not yet adopted or dropped) does.
 * - index-stale: the avatar's used index is behind its videos and could not be read again: EVERY photo of the avatar is refused.
 * - log-needs-repair: a record or the reject log of the avatar cannot be read: EVERY photo of the avatar is refused.
 *
 * (A record from a newer Studio is not one of these: it is LIBRARY_TOO_NEW.)
 */
export const PHOTO_UNAVAILABLE_REASONS = ["in-video", "held-by-render", "pending-video", "index-stale", "log-needs-repair"] as const;
export const PhotoUnavailableReason = z.enum(PHOTO_UNAVAILABLE_REASONS);
export type PhotoUnavailableReason = z.infer<typeof PhotoUnavailableReason>;

/** The reason all the refused cells share, or undefined when one has none or they differ. */
export function commonPhotoReason(reasons: readonly (PhotoUnavailableReason | undefined)[]): PhotoUnavailableReason | undefined {
  const first = reasons[0];
  return first !== undefined && reasons.every((reason) => reason === first) ? first : undefined;
}

/**
 * Why a category command was refused (VALIDATION's `categoryReason`, additive in v5): the sheet's text depends on it, so it is a closed code and
 * not the engine's free `detail`. Absent on a VALIDATION that is no category's own (a payload the contract refuses).
 *
 * - limit: the library already holds the most categories (50).
 * - name-taken: another category has this name (the one name rule: trimmed, NFC, case-folded).
 * - below-minimum: the removal would leave fewer places or outfits than a pool keeps.
 * - mirror-needed: the removal would take the last place with a mirror from a deck that can draw a mirror shot.
 * - item-not-found: the place or outfit to remove is not in the category (it may have been removed already).
 * - library-unreadable: the disk failed a read (a record or the folder) that the check for a new name or the limit needs, so the engine could not tell and wrote nothing (additive, CS.7 fix round 2).
 */
export const CATEGORY_REASONS = ["limit", "name-taken", "below-minimum", "mirror-needed", "item-not-found", "library-unreadable"] as const;
export const CategoryReason = z.enum(CATEGORY_REASONS);
export type CategoryReason = z.infer<typeof CategoryReason>;

/**
 * Why `avatars.editDescriptor` refused the owner's text (VALIDATION's `descriptorReason`, additive in Stage 5): the window's text depends on it, so it is a closed code.
 * One per way a hand-typed descriptor can fail the prompt-time contract (`AvatarDescriptor`), plus the stale proposal.
 *
 * - empty / hidden-chars: blank, or it holds invisible or control characters.
 * - too-long: over 600 characters.
 * - too-long-with-body (S5.2a): the text alone fits, but the text, «; » and her body phrase together are over 600 characters (the owner shortens the description).
 * - no-anchor: the avatar's "<age>-year-old" is missing (it may stand anywhere in the text).
 * - script / non-ascii-digits / other-age / under-21-bound / youth-word / number: the `AdultTextProblem` of the same name.
 * - stale: the stored text is no longer the one the proposal was made for.
 * - invalid: the contract refused it for a reason none of the above names (a rule added later).
 */
export const DESCRIPTOR_REASONS = ["empty", "hidden-chars", "too-long", "too-long-with-body", "no-anchor", "script", "non-ascii-digits", "other-age", "under-21-bound", "youth-word", "number", "stale", "invalid"] as const;
export const DescriptorReason = z.enum(DESCRIPTOR_REASONS);
export type DescriptorReason = z.infer<typeof DescriptorReason>;

/**
 * Why a portrait command was refused with VALIDATION (`EngineError.portraitReason`, Stage 5, S5.3a, additive in v5). The window's text depends on it, so it is a closed code.
 *
 * - not-imported: the avatar has no imported source photo (a wizard avatar), so there is nothing to draw a portrait from.
 * - too-many-candidates: the avatar already holds 15 unpicked portraits; a new batch of 5 would pass the limit.
 * - not-a-candidate: the photo named is not the avatar's source photo or one of its pending portraits that the pick gate accepts.
 * - source-unavailable (S5.3c): the one reason that is NOT a VALIDATION but an INTERNAL: the avatar's master is a portrait and its imported source photo is missing, quarantined or unreadable,
 *   so a batch (or a descriptor check, which compares with the source) cannot be made. Free. The owner's way out is the library folder.
 */
export const PORTRAIT_REASONS = ["not-imported", "too-many-candidates", "not-a-candidate", "source-unavailable"] as const;
export const PortraitReason = z.enum(PORTRAIT_REASONS);
export type PortraitReason = z.infer<typeof PortraitReason>;

/**
 * Why a clip command was refused (`EngineError.clipReason`, Stage 5, 5b.1, S5.V1, additive in v5). The window's text depends on it, so it is a closed code.
 *
 * With VALIDATION:
 * - not-a-gallery-photo / age-unverified / photo-unreadable / not-vertical / bold-off / no-motion: the photo cannot be brought to life (the six `CLIP_UNSUITABLE_REASONS`;
 *   `clips.options` answers them as a result, `clips.create` refuses with the same reason when it is sent anyway).
 * - unknown-motion: the motion id the sheet sent is not one the photo offers any more.
 * - grok-not-offered: `model: "grok"` outside mode `offer`, or on a photo that allows no fallback (I5.47).
 * - download-expired: the file is gone from OpenRouter (`clips.retryDownload`, after `retryDownloadUntil` or on a 404 / 410).
 * - not-ready: `clips.export` on a clip that is not `ready`.
 * - not-exported: `clips.reveal` on a clip with no copy in the export folder.
 * - file-damaged (5b.2, S5.WA1): `media.importClip` on a ready clip whose file in Studio is not the one its record names (the sha256 differs, or the file is gone or unreadable).
 *
 * With IN_FLIGHT:
 * - one-at-a-time: a paid clip is already in flight (`clips.create`).
 * - job-running: a job of this clip runs (`clips.delete`, `clips.retryDownload`, `clips.export`).
 * - submitted: the clip is already at the provider, so it cannot be cancelled (`avatars.cancel`).
 * - in-use (5b.2, S5.WA1): `clips.delete` while a render holds the clip's montage copy; nothing is removed.
 * - batch-running (5b.2, S5.WB1): a batch holds the clip money unit, so `clips.create`, `clips.createBatch` and the single «Оживить» wait (I5.61). `one-at-a-time` stays for a single clip holding it.
 * - clip-busy (5b.2, S5.WB1; text by S5.WC1): a paid clip or batch holds the unit, so part C's paid calls (`clips.suggestMotions`, `clips.translateIdea`) wait (I5.68).
 * - motion-busy (5b.2, S5.WC1; the other direction of the same guard, r2.1 N10): a part C call runs, so `clips.create` and `clips.createBatch` wait. GLOBAL: while ANY part C call runs, for any avatar and any photo.
 * - suggest-busy / idea-busy (5b.2, S5.WC1): a `clips.suggestMotions` / `clips.translateIdea` for the same photo is already running (one call per photo at a time).
 *
 * One `clipReason` per error. A batch item that breaks a rule is reported with its OWN reason (`bold-off`, `unknown-motion`, ...) and the path `["items", i]`; there is no batch-level reason for it.
 */
export const CLIP_VALIDATION_REASONS = [
  "not-a-gallery-photo",
  "age-unverified",
  "photo-unreadable",
  "not-vertical",
  "bold-off",
  "no-motion",
  "unknown-motion",
  "grok-not-offered",
  "download-expired",
  "not-ready",
  "not-exported",
  "file-damaged",
] as const;
export const CLIP_IN_FLIGHT_REASONS = ["one-at-a-time", "job-running", "submitted", "in-use", "batch-running", "clip-busy", "motion-busy", "suggest-busy", "idea-busy"] as const;
export const CLIP_REASONS = [...CLIP_VALIDATION_REASONS, ...CLIP_IN_FLIGHT_REASONS] as const;
/** The reasons `clips.options` answers for a photo that cannot be brought to life: the first six of `CLIP_VALIDATION_REASONS`, as one set. */
export const CLIP_UNSUITABLE_REASONS = ["not-a-gallery-photo", "age-unverified", "photo-unreadable", "not-vertical", "bold-off", "no-motion"] as const;
export const ClipReason = z.enum(CLIP_REASONS);
export type ClipReason = z.infer<typeof ClipReason>;

/** A scene's number in its set (the same bounds as `SceneId` in scenes.ts, which imports this file). */
const SceneIdNumber = z.number().int().min(1).max(10_000);

/**
 * Why a scene-set command was refused (VALIDATION's `sceneReason`, additive in v5): the window's text depends on it, so it is a closed code and not a
 * phrase of the engine's English `detail`. Absent on a VALIDATION that is no scene set's own. The revision that moved is not here: it is SCENES_CHANGED.
 *
 * - set-used: the set's run has started; a used set is read-only (a change, a write, an approval).
 * - open-set: the avatar already has an open set (compose).
 * - nothing-waiting: no scene of the set is waiting to be written («Дописать»).
 * - scene-missing: the set has no such scene (`sceneId` names the first).
 * - target-removed: the scene to write is removed, or every scene of an interrupted write is (`sceneId` names the first, when there is one).
 * - scene-without-text: an active scene has no text, at an approval (`sceneId` names the first).
 * - no-active-scenes: every scene is removed, at an approval.
 * - too-many-active: more active scenes than a run draws (100), at an approval.
 * - scene-text-problem: an active scene's stored text breaks today's word rules, at an approval (`sceneId` names it).
 * - write-record-cap: the set already records the most review writes (500).
 * - idea-room: the new scenes of an idea write would not fit in the set (200 with the room an interrupted idea holds).
 * - mixed-kinds: a rewrite names planned and own scenes together; they are written from different prompts.
 * - own-redraw: a redraw names an own scene; it has no place to redraw.
 * - no-open-write: the set has no unresolved write with that number (resume, dismiss).
 * - no-attempts-left: the unresolved write has no attempt left (resume).
 * - nothing-to-dismiss: a scene named in a dismissal has no unresolved rewrite.
 * - library-unreadable: the disk failed a read of the avatar's scene sets (a record or the folder) in the check that lets a new set in, so the engine could not tell whether one is open and wrote nothing (additive, CS.7 fix round 2).
 * - launch-set (Stage 4): the set, or the run, belongs to a batch launch that is not finished; the launch moves it («управляйте им в «Автопилоте»»). Also the answer of `runs.resume` / `runs.cancel` on a launch's slice run.
 * - over-plan (Stage 4): at `autopilot.continueAfterReview`, the set has more active scenes than the launch planned for the avatar; adding scenes cannot raise the launch's spend.
 * - not-awaiting (Stage 4): at `autopilot.continueAfterReview`, the avatar of the launch is not waiting for the owner's review of this set.
 * - legs-built-in-only (Stage 5, S5.8a): «Ножки» was asked for (`legsShare` above 0) with no built-in category among the request's categories; legs are drawn from the five built-ins only.
 *   Refused for free, before anything is priced, reserved or written (`runs.estimate`, `runs.start`, `scenes.estimateCompose`, `scenes.compose`).
 * - slot-text-problem (Stage 5, S5.6d): not a refusal of a command. The run ended ONE slot, free, because its sentence broke today's youth or revealing word rules at the
 *   assembler (the last gate before an image is paid for); it travels as that slot's end error. It names no scene (a run's slot is not a scene of a set).
 * - bold-level-needed (5a.3, S5.9a; asked for by S5.9c): «Ночнушки и бельё» or «Пляж и бассейн» was asked for at a level other than «Смелая». Refused for free, before anything is
 *   priced, reserved or written (`runs.estimate`, `runs.start`, `scenes.estimateCompose`, `scenes.compose`).
 * - model-refused, model-empty (5a.3, S5.9a; ended by S5.9d): not refusals of a command. They end ONE «Смелая» slot, like slot-text-problem, and travel in `RunResult.failedReasons`.
 *   The model refused the frame (a refusal is free; the attempts paid before it are in the spend), or answered without an image (a paid attempt, settled).
 */
export const SCENE_REASONS = [
  "set-used",
  "open-set",
  "nothing-waiting",
  "scene-missing",
  "target-removed",
  "scene-without-text",
  "no-active-scenes",
  "too-many-active",
  "scene-text-problem",
  "write-record-cap",
  "idea-room",
  "mixed-kinds",
  "own-redraw",
  "no-open-write",
  "no-attempts-left",
  "nothing-to-dismiss",
  "library-unreadable",
  "launch-set",
  "over-plan",
  "not-awaiting",
  "slot-text-problem",
  "legs-built-in-only",
  "bold-level-needed",
  "model-refused",
  "model-empty",
] as const;
export const SceneReason = z.enum(SCENE_REASONS);
export type SceneReason = z.infer<typeof SceneReason>;

/** The reasons that point at one scene: `sceneId` may travel with these only, and must with the first two. */
export const SCENE_REASONS_NAMING_A_SCENE = ["scene-text-problem", "scene-without-text", "scene-missing", "target-removed"] as const;

/**
 * Why `autopilot.estimate` or `autopilot.start` was refused with VALIDATION (`EngineError.launchReason`, Stage 4, additive in v5). The same codes are the
 * `blockers` of a `LaunchPreview` (`AVATAR_BLOCKER_CODES` and `LAUNCH_BLOCKER_CODES` in autopilot.ts hold the full lists; the others have a code of their own
 * when `start` refuses: AUTH_INVALID, RECONCILE_REQUIRED, EXPORT_UNAVAILABLE, IN_FLIGHT). Everything is refused BEFORE anything is written or spent.
 *
 * - open-set: an avatar the plan needs new photos for has an open scene set of its own (the owner finishes or deletes it on «Фото»).
 * - too-many-photos: an avatar would need more than 100 new photos in one launch.
 * - usage-unknown: which photos of an avatar are in a video cannot be trusted right now, so nothing can be taken from its library.
 * - launch-unreadable: a launch file cannot be read and may describe an active launch; the owner removes the entry first (`autopilot.removeUnreadable`).
 * - nothing-enabled: both «Сначала свободные фото» and «Догенерировать» are off, so there is nothing to make.
 * - legs-built-in-only (Stage 5, S5.8a): «Ножки» was asked for with no built-in category among the launch's categories (`autopilot.estimate`, `autopilot.start`).
 * - bold-level-needed (5a.3, S5.9a; asked for by S5.9c): «Ночнушки и бельё» or «Пляж и бассейн» is among the launch's categories at a level other than «Смелая» (`autopilot.estimate`, `autopilot.start`).
 */
export const LAUNCH_REASONS = ["open-set", "too-many-photos", "usage-unknown", "launch-unreadable", "nothing-enabled", "legs-built-in-only", "bold-level-needed"] as const;
export const LaunchReason = z.enum(LAUNCH_REASONS);
export type LaunchReason = z.infer<typeof LaunchReason>;

/**
 * An error as it travels between processes: a code plus optional diagnostics,
 * never user text. Six codes must say more than their name: MONTAGE_INVALID
 * carries the `issues` (a closed list of codes and paths, never values),
 * PHOTO_UNAVAILABLE the same list with only `photo-unavailable` issues (which
 * cells) and, when there is one, its `photoReason`, EXPORT_UNAVAILABLE its
 * `exportReason`, TEXT_INVALID its `captionIssue`, MUSIC_UNAVAILABLE its
 * `musicReason` and MEDIA_UNSUPPORTED its `mediaReason`; no other code carries any.
 */
export const EngineError = z
  .strictObject({
    code: ErrorCode,
    detail: SafeText.optional(),
    retryAfterMs: Count.optional(),
    issues: z.array(MontageIssue).min(1).max(MAX_MONTAGE_ISSUES).optional(),
    exportReason: ExportUnavailableReason.optional(),
    /**
     * Additive (S4.6g): `unknown` on an EXPORT_UNAVAILABLE that is the timeout of work which may still be going on (a `videos.delete` that did not answer in time: the file,
     * the record or the photos' rejection may have been done anyway). Absent on a refusal that changed nothing. The window words the two apart.
     */
    outcome: z.literal("unknown").optional(),
    captionIssue: CaptionIssue.optional(),
    musicReason: MusicUnavailableReason.optional(),
    mediaReason: MediaUnsupportedReason.optional(),
    photoReason: PhotoUnavailableReason.optional(),
    /**
     * Additive (CS.2): which rule a category command broke; only on VALIDATION, and on every category VALIDATION (create, update, regenerate,
     * and the one a create meets after its pool was paid for, which also carries `spentMicros`). The sheet's text for it is `CATEGORY_REASONS_RU`.
     */
    categoryReason: CategoryReason.optional(),
    /**
     * Additive (CS.7): which rule a scene-set command broke (`SCENE_REASONS`); only on VALIDATION, and on every VALIDATION of `scenes.*` and
     * `runs.estimateFromScenes` / `runs.startFromScenes` that is the set's own (a payload the contract refuses has none). The window's text for it is `SCENE_REASONS_RU`.
     */
    sceneReason: SceneReason.optional(),
    /** Additive (CS.7): the scene a `sceneReason` points at, when it names one (`SCENE_REASONS_NAMING_A_SCENE`); always with `scene-text-problem` and `scene-without-text`. */
    sceneId: SceneIdNumber.optional(),
    /** Additive (Stage 4): which rule `autopilot.estimate` / `autopilot.start` broke (`LAUNCH_REASONS`); only on VALIDATION, never beside a scene or category reason. The window's text is `LAUNCH_REASONS_RU`. */
    launchReason: LaunchReason.optional(),
    /**
     * Additive (Stage 5, S5.0a): which rule `avatars.editDescriptor` found the owner's text breaking (`DESCRIPTOR_REASONS`); only on VALIDATION, never beside another reason.
     * The window's text is `DESCRIPTOR_REASONS_RU` (`descriptorReasonRu`).
     */
    descriptorReason: DescriptorReason.optional(),
    /** Additive (Stage 5, S5.3a): which rule a portrait command broke (`PORTRAIT_REASONS`); only on VALIDATION (INTERNAL for `source-unavailable`), never beside another reason. The window's text is `PORTRAIT_REASONS_RU`. */
    portraitReason: PortraitReason.optional(),
    /**
     * Additive (Stage 5, 5b.1, S5.V1): which rule a clip command broke (`CLIP_REASONS`); on VALIDATION, or on IN_FLIGHT for `one-at-a-time`, `job-running`, `submitted`, `in-use`, `batch-running`, `clip-busy`, `motion-busy`, `suggest-busy` and `idea-busy`; never beside another
     * reason. The window's text is `CLIP_REASONS_RU`.
     */
    clipReason: ClipReason.optional(),
    /**
     * Additive (Stage 5, 5b.2, S5.WB1; plan s5b2 §5.2.1, L3): where in the payload a clip refusal points: `["items", i]`, the batch item (0-based) whose own `clipReason` this is. Only on a VALIDATION that
     * carries a `clipReason` (`clips.createBatch`); the window draws the reason's text on that row.
     * The index is not bounded here (errors.ts cannot import clips.ts, which imports it): the engine points only inside the payload it already validated, whose items are at most `MAX_BATCH_CLIPS`.
     */
    path: z.tuple([z.literal("items"), Count]).optional(),
    /** Additive (Stage 5, S5.0a): the owner's own offending words, only with the reason `youth-word` (at most a handful, each short). */
    descriptorWords: z.array(z.string().min(1).max(60)).max(10).optional(),
    /**
     * Additive (CS.2): what a failed paid category call cost, in micro-dollars as the ledger booked it (a settled attempt at its cost, an
     * open reserve at its worst case). Present on every failure of `categories.create` / `categories.regenerate` from the moment its call
     * was started — a provider's refusal (0), two rejected pools, a dropped connection, a pool paid for and not storable — and absent on
     * the refusals that come before it (PRICE_CHANGED, IN_FLIGHT, VALIDATION, no key, no library), where nothing was booked. The sheet's
     * «потрачено $X» reads it.
     */
    spentMicros: Count.optional(),
    /**
     * Additive (5a.3, S5.9a, gap D): which price a PRICE_UNAVAILABLE could not find: `bold`, the Seedream 2K tier of a «Смелая» estimate; and (5b.1, S5.V1) `video`, a listing that reads but
     * lacks a model or resolution a clip needs. Only on PRICE_UNAVAILABLE; a refusal for any other price carries none, and the window shows its general text.
     */
    priceScope: z.enum(["bold", "video"]).optional(),
  })
  .refine((e) => e.path === undefined || (e.code === "VALIDATION" && e.clipReason !== undefined), {
    message: "path may only accompany a VALIDATION with a clipReason: it points at the batch item that broke the rule",
    path: ["path"],
  })
  .refine((e) => e.priceScope === undefined || e.code === "PRICE_UNAVAILABLE", {
    message: "priceScope may only be present on PRICE_UNAVAILABLE",
    path: ["priceScope"],
  })
  .refine((e) => (e.code === "MONTAGE_INVALID" || e.code === "PHOTO_UNAVAILABLE") === (e.issues !== undefined), {
    message: "issues must be present exactly on MONTAGE_INVALID and PHOTO_UNAVAILABLE",
    path: ["issues"],
  })
  .refine((e) => e.code !== "PHOTO_UNAVAILABLE" || (e.issues ?? []).every((i) => i.code === "photo-unavailable"), {
    message: "PHOTO_UNAVAILABLE lists photo-unavailable issues only",
    path: ["issues"],
  })
  .refine((e) => e.photoReason === undefined || e.code === "PHOTO_UNAVAILABLE", {
    message: "photoReason may only be present on PHOTO_UNAVAILABLE",
    path: ["photoReason"],
  })
  .refine((e) => e.categoryReason === undefined || e.code === "VALIDATION", {
    message: "categoryReason may only be present on VALIDATION",
    path: ["categoryReason"],
  })
  // The ends of a Seedream slot (I5.39) travel as the slot's EngineError in the run journal: a refusal as MODERATION_REFUSED, an unusable paid response as INTERNAL (engineError.ts maps it).
  .refine((e) => e.sceneReason === undefined || e.code === (e.sceneReason === "model-refused" ? "MODERATION_REFUSED" : e.sceneReason === "model-empty" ? "INTERNAL" : "VALIDATION"), {
    message: "sceneReason may only be present on VALIDATION, except model-refused (MODERATION_REFUSED) and model-empty (INTERNAL)",
    path: ["sceneReason"],
  })
  .refine((e) => e.sceneReason === undefined || e.categoryReason === undefined, {
    message: "a refusal has a sceneReason or a categoryReason, not both",
    path: ["sceneReason"],
  })
  .refine((e) => e.launchReason === undefined || e.code === "VALIDATION", {
    message: "launchReason may only be present on VALIDATION",
    path: ["launchReason"],
  })
  .refine((e) => e.launchReason === undefined || (e.sceneReason === undefined && e.categoryReason === undefined), {
    message: "a refusal has one reason: a launchReason, a sceneReason or a categoryReason",
    path: ["launchReason"],
  })
  .refine((e) => e.descriptorReason === undefined || e.code === "VALIDATION", {
    message: "descriptorReason may only be present on VALIDATION",
    path: ["descriptorReason"],
  })
  .refine((e) => e.descriptorReason === undefined || (e.sceneReason === undefined && e.categoryReason === undefined && e.launchReason === undefined), {
    message: "a refusal has one reason: a descriptorReason, a launchReason, a sceneReason or a categoryReason",
    path: ["descriptorReason"],
  })
  .refine((e) => e.portraitReason === undefined || e.code === (e.portraitReason === "source-unavailable" ? "INTERNAL" : "VALIDATION"), {
    message: "portraitReason may only be present on VALIDATION, except source-unavailable, which belongs to INTERNAL",
    path: ["portraitReason"],
  })
  .refine(
    (e) =>
      e.portraitReason === undefined ||
      (e.descriptorReason === undefined && e.sceneReason === undefined && e.categoryReason === undefined && e.launchReason === undefined),
    {
      message: "a refusal has one reason: a portraitReason, a descriptorReason, a launchReason, a sceneReason or a categoryReason",
      path: ["portraitReason"],
    },
  )
  .refine((e) => e.clipReason === undefined || e.code === ((CLIP_IN_FLIGHT_REASONS as readonly string[]).includes(e.clipReason) ? "IN_FLIGHT" : "VALIDATION"), {
    message: "clipReason may only be present on VALIDATION, except one-at-a-time, job-running, submitted, in-use, batch-running, clip-busy, motion-busy, suggest-busy and idea-busy, which belong to IN_FLIGHT",
    path: ["clipReason"],
  })
  .refine(
    (e) =>
      e.clipReason === undefined ||
      (e.portraitReason === undefined && e.descriptorReason === undefined && e.sceneReason === undefined && e.categoryReason === undefined && e.launchReason === undefined),
    {
      message: "a refusal has one reason: a clipReason, a portraitReason, a descriptorReason, a launchReason, a sceneReason or a categoryReason",
      path: ["clipReason"],
    },
  )
  .refine((e) => e.descriptorWords === undefined || e.descriptorReason === "youth-word", {
    message: "descriptorWords may only accompany the descriptorReason youth-word",
    path: ["descriptorWords"],
  })
  .refine((e) => e.sceneId === undefined || (e.sceneReason !== undefined && (SCENE_REASONS_NAMING_A_SCENE as readonly string[]).includes(e.sceneReason)), {
    message: "sceneId may only accompany a sceneReason that names a scene",
    path: ["sceneId"],
  })
  .refine((e) => (e.sceneReason !== "scene-text-problem" && e.sceneReason !== "scene-without-text") || e.sceneId !== undefined, {
    message: "scene-text-problem and scene-without-text name their scene",
    path: ["sceneId"],
  })
  .refine((e) => (e.code === "EXPORT_UNAVAILABLE") === (e.exportReason !== undefined), {
    message: "exportReason must be present exactly on EXPORT_UNAVAILABLE",
    path: ["exportReason"],
  })
  .refine((e) => e.outcome === undefined || e.code === "EXPORT_UNAVAILABLE", {
    message: "outcome may only be present on EXPORT_UNAVAILABLE",
    path: ["outcome"],
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
 * `EngineError.detail` of an INTERNAL answer main gives to a command that starts paid work or moves a launch while the Mac sleeps or has only just woken (S4.7, L-d; `commandHold.ts`):
 * nothing was sent, a retry a moment later goes through. A plain string, not a new `ErrorCode`, like `ENGINE_GONE_DETAIL`; the window words it in Russian (studio/renderer/lib/errors.ts).
 */
export const HOST_ASLEEP_DETAIL = "the Mac is going to sleep or has just woken; the command was not sent, try again in a moment";

/**
 * Stage 5, 5b.1 (S5.V8 follow-up, additive): `EngineError.detail` of an INTERNAL export of a clip («Сохранить в папку») stopped by the clip's own file in Studio — not the bytes its
 * record names, unreadable, or a file the walker or ffmpeg refuses (I5.54). Every other INTERNAL of an export leaves that file whole, and the window says so (43c); this one must not:
 * it says the file is damaged (`CLIP_FILE_DAMAGED_RU`). A plain string, not a new `ErrorCode`, like `DRAFT_TOO_NEW_DETAIL`.
 */
export const CLIP_FILE_DAMAGED_DETAIL = "the clip's file in Studio is damaged or unreadable: it is not the file its record names";

/**
 * `EngineError.detail` of LIBRARY_TOO_NEW from `montages.create` and `videos.render` for an avatar with a video record a newer Studio
 * wrote (its photo usage cannot be judged). One text for the engine and the mock.
 */
export const LIBRARY_TOO_NEW_DETAIL = "a video record of this avatar was written by a newer version of Studio";

/**
 * `EngineError.detail` of a PHOTO_UNAVAILABLE refused because the avatar's photo usage cannot be trusted right now (a stale used
 * index, or a record or reject log that needs repair): every photo of the avatar is refused. The reason is the library's own code.
 */
export function usageUntrustedDetail(reason: Extract<PhotoUnavailableReason, "index-stale" | "log-needs-repair">): string {
  return `the usage of this avatar's photos cannot be trusted right now (${reason})`;
}

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

/**
 * What the detail of a RENDER_FAILED starts with when the render could not get room for its temporary files (the layers' peak, or the copy of an own file):
 * a retry cannot help until disk space is freed, so the window says that instead of «Попробуйте ещё раз». The engine writes `: <what is needed>` after it.
 */
export const RENDER_NO_SPACE_DETAIL_PREFIX = "not enough free space for the render's temporary files";

export const NO_ANSWER_DETAIL_PREFIX = "the engine did not answer within ";

/** The detail main gives a command that was waiting for an answer when the engine process exited: like a missing answer, the command may have been carried out. */
export const ENGINE_EXITED_DETAIL = "the engine exited before answering";

/** `RENDER_QUEUE_FULL`'s detail: it names the limit, which `renderQueueLimitOf` reads back for the window's text. */
export function renderQueueFullDetail(limit: number): string {
  return `the render queue is full: ${limit} renders are already queued or running`;
}

/** The limit a `RENDER_QUEUE_FULL` detail names; null for any other text. */
export function renderQueueLimitOf(detail: string | undefined): number | null {
  const match = /^the render queue is full: (\d{1,6}) renders are already queued or running$/.exec(detail ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}
