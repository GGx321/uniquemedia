import { z } from "zod";

/**
 * Wire protocol version carried by every message as `v`.
 *
 * - 2 (2026-09-29): 2K removed: `RunRequest` and `PhotoSummary` no longer carry a `resolution`.
 * - 3 (2026-09-29): `job.progress`, `job.failed` and `job.cancelled` carry the job's `kind`, `avatarId` and (a run) `runId`.
 * - 4 (2026-09-29): `RunSummary.capExhausted`; a run whose cap cannot fund one more attempt is no longer `resumable`.
 * - 5 (2026-09-29): Stage 3's render contract: the `render` job kind (queued jobs, frames as progress) with its identity in the job events;
 *   `videos.*`, `photos.setRejected`, `montages.*` (create, get, list, save, delete, focus), the `video.changed`, `montage.changed` and `export.status` events,
 *   `MontageSpec`/`MontageDraft`, a draft's nullable name and the engine-only montage issue codes (caption-invalid, media-unavailable, sticker-unavailable, track-unavailable, track-too-short);
 *   `Settings.exportPath` and `.renderConcurrency`; `Snapshot.exportStatus`; `PhotoSummary.used`/`usedIn`/`rejected`/`reserved`/`eligible`; `AvatarSummary.videoCount`/`eligibleUnusedCount`;
 *   `EngineError.issues`, `.exportReason` and `.captionIssue`; the error codes MONTAGE_INVALID, PHOTO_UNAVAILABLE, EXPORT_UNAVAILABLE, RENDER_FAILED, RENDER_VERIFY_FAILED, RENDER_QUEUE_FULL (`detail` names the limit), LIBRARY_TOO_NEW, TEXT_INVALID.
 */
// v5 stays open until Stage 3's first release: contract changes before that do not bump the version. Added within it since:
// 3e.2: `AvatarSummary.usage` (K16) with `videos.quarantineRecords` and `photos.rebuildRejected`; `FileState` `unchecked` (K15);
// `VideoSummary.title` (K12), `.music.trackId` (K13) and `.firstClip`; `videos.get`; main's `videos.revealFolder` (K17).
// 3c: `music.status`, `.refresh`, `.recoverQuotaLog`, `.list` and `.peaks`, the `music.changed` event, the error codes MUSIC_KEY_MISSING, MUSIC_KEY_REJECTED, MUSIC_QUOTA_EXHAUSTED and
// MUSIC_UNAVAILABLE with `EngineError.musicReason`; `Settings.musicKey` (the key's presence, never the key).
// 3d: `montages.textPreview` (TEXT_PREVIEW_SUPERSEDED), `TEXT_INVALID`'s `captionIssue` and the montage issue `caption-invalid`.
// 3e.3: `export.check` and main's `settings.setExportPath`; the export folder's reasons `overlaps-work-folder` and `invalid-marker-with-records`.
// 3f: own media: `media.list`, `.delete`, `.cancelImport`, main's `media.pickImport`, the `media.changed` event, the `import` job kind, MEDIA_UNSUPPORTED with
// `EngineError.mediaReason`, own sources in a montage spec (`source: "own"`), and the issue codes `media-unavailable` and `video-too-short`.
// The notice `engine-internal-error`.
// Review of the whole of Stage 3 (additive): `EngineError.photoReason` on PHOTO_UNAVAILABLE (why a photo was refused: in-video, held-by-render, pending-video (held only by an unfinished video's pending intent), index-stale,
// log-needs-repair); `montages.list`'s `notListedTotal` (draft files not read, absent when 0).
// Removed within it (owner decision 2026-10-05, personal-use app; no bump, for the same reason): the `confirmedAiPersona` field of
// `avatars.importAvatar` and the error code AGE_CHECK_FAILED (with its «already refused» detail). The parity golden never held either.
// Own scene categories and the review of scenes (CS.2 to CS.7, additive, one bundle with the window):
//  - categories: `categories.list`, `.estimate`, `.create`, `.regenerate`, `.update`, `.delete` and `.dismissInterrupted`; the `category.changed` event; `CategoryRef` in
//    `RunRequest.categories` (at most 20), `PhotoCategory` and `PhotoSummary.categoryName`; the error code POOL_REJECTED, `EngineError.categoryReason` (a closed
//    code on every category VALIDATION) and `EngineError.spentMicros` (what a failed paid category call cost).
//  - scene sets: `scenes.estimateCompose`, `.compose`, `.get`, `.edit`, `.estimateWrite`, `.write` (targets unwritten, rewrite, idea, resume), `.cancel` and `.discard`;
//    the `scenes.changed` event; the `scenes` job kind in the job events; the error code SCENES_CHANGED; `runs.estimateFromScenes` and `runs.startFromScenes`.
//    CS.7: `EngineError.sceneReason` (a closed code on every VALIDATION of those commands, see `SCENE_REASONS`) and `EngineError.sceneId` (the scene a reason
//    points at). CS.7 round 2: the reason `library-unreadable` in both `SCENE_REASONS` and `CATEGORY_REASONS` (the disk failed a read a check before a new set or
//    category needs; nothing was written or spent).
//  - settings: `settings.imageModels` (its catalogue carries the flag `complete`: every candidate of a live list was priced) and `settings.setCameraRealism`; the
//    REQUIRED new fields `Settings.imageQuality` (nullable) and `Settings.cameraRealism`. Required fields in schemas that already existed are safe here only because
//    both ship in ONE bundle: the producers (main's settings store, which fills an older settings file in; the engine; the mock) and the consumers (the window,
//    `EngineSettings`, `EngineInit`) are built together, and the literal version stays 5. A change like it after a release needs a version bump.
//  - avatars: `avatars.deletePreview` and `avatars.delete`, the `avatar.removed` event, the error code TRASH_UNAVAILABLE.
//  - montage: `MIN_CLIP_MS` is 100 ms (the shortest clip).
// Stage 4, S4.P2 (additive, no bump): `photos.list` takes an optional `cursor` and answers `nextCursor` (null on the last page) and `remainingTotal`; without a cursor the
//   first page is exactly what it was. The answer's two new fields are required: the engine and the mock, its only producers, ship with the window in one bundle.
// Stage 4 «Автопилот» (S4.1, additive, one bundle with the window; plan §9 and §18):
//  - commands `autopilot.estimate`, `.start`, `.pause`, `.resume` (it carries `acceptedRemainingMicros`: the click that also consents to paid work after a restart), `.stop`,
//    `.continueAfterReview`, `.list`, `.get` (the launch, its log and its videos) and `.removeUnreadable` (by an opaque `entryId`, never a name or a path); `videos.setPublished`;
//    `media.setForAutopilot`; the event `autopilot.changed` (the launch, whole); `Snapshot.autopilot`. The types are in `autopilot.ts`: `LaunchDraft`, `LaunchPreview`, `LaunchView`
//    (its `stopping` and `pausing` states, `paused.cause`, `inFlight`, the strict `PaidHold` by reason, `freeHold`, `resumeBlockedBy`), `LaunchSummary`, `LaunchVideo` and `LogLine`
//    (a closed `kind`, types and numbers only: the window words them).
//  - optional fields on shapes that exist: `VideoSummary.origin` / `.launchId` / `.publishedAt`, `videos.list`'s `published` (`ok` / `unknown`), `videos.delete`'s `rejectPhotos` and the
//    result's `rejectedPhotoIds`, `MediaSummary.forAutopilot`, `RunSummary.launchId`, `SceneSetView.launchId`, `launchId` on the `run`, `scenes` and `render` `JobState`.
//  - `EngineError.launchReason` (`LAUNCH_REASONS`, Russian texts `LAUNCH_REASONS_RU`) and the scene reasons `launch-set`, `over-plan` and `not-awaiting`. No new error code.
//  - not in the renderer's contract, on purpose: main's `host.power` (`suspend` / `resume`) is a `HostControl` of engine/control.ts, and the video record's `origin` / `launchId` /
//    `launchVideoKey` and the scene set file's `launchId` / `launchDraw` are on-disk fields, all optional, with no schema version bumped.
// Stage 4, S4.9a (additive, no bump): `LaunchPreview.month.raiseToMicros` — the budget of «поднимите бюджет до $X», answered by the engine so the window computes no
//   money (§4.2). Required, like S4.P2's fields: the engine and the mock, its only producers, ship with the window in one bundle.
// Stage 4, S4.6v (additive, no bump): `LaunchView.unsettled { requests, openMicros }`, OPTIONAL — the launch's open reserves that no request of the engine is out for (those of a previous
//   process after a restart, and those a drop or a timeout left), counted at their worst case inside `spentMicros` until a reconcile settles them. It is DISJOINT from `inFlight`
//   (one open reserve is in exactly one of the two, the engine splits them by whether the Budget has a request out for the attempt) and the contract refuses a view where the two
//   together pass `spentMicros`. The engine and the mock always fill it; a view without it reads as none, and the window then falls back to `inFlight` alone.
// Stage 4, S4.6g (additive, no bump; every field optional, so an answer from before it parses unchanged):
//  - `autopilot.get`: a finished `LaunchVideo` carries the owner's mark from `published.jsonl` (`publishedAt`, no longer always null), `removed: true` when its record has been
//    deleted since (`videos.delete`, or its avatar), and `publishedUnknown: true` when the avatar's marks could not be read (then `publishedAt` is null and says nothing). The
//    result's `published` (`ok` / `unknown`, absent while no avatar of the launch has a log) mirrors `videos.list`'s. `autopilot.list`'s `LaunchSummary.videosDone` counts
//    only the finished videos whose records stand, so a deleted video leaves «N из M».
//  - `autopilot.list`'s `UnreadableLaunch.scope` (`folder` / `file`, only on an `io-error`): the `autopilot/` folder could not be listed, or one launch file could not be opened.
//  - `EngineError.outcome` (`unknown`, only on EXPORT_UNAVAILABLE): a `videos.delete` that did not answer in time; its work was not cancelled and may have finished, so the answer
//    promises neither that the video is still there nor that it is gone.
// Stage 4, S4.6p (additive, no bump; a new command, nothing that exists changes): `runs.estimateImages`, the free price of DRAWING photos, images alone, so the window computes no
//   money (it used to take the run's estimate less the compose's, and a launch's strip showed the allocation for want of an expected price). Two payloads, one answer
//   `{ estimate, photos }`: `{ avatarId, count }` (1..100) prices `count` photos of an avatar that can get photos (an owner's set that cannot be approved yet; the generate card's
//   compose mode), and `{ launchId, avatarId }` prices what the unfinished launch still has to draw for the avatar (the photos of its set that no slice has taken, plus the open
//   slots of the slices that began; before «Продолжить запуск», the planned scenes with a text), and `photos` is those the money buys (an open slot within its own slice's cap, a scene not yet in a
//   slice within the allocation left for new slices; fewer than the photos left only when a price rose since the plan). Both are priced by the code the real
//   draw is priced by (`runs.estimateFromScenes`' and the launch's slices'), so the figure is the one the run will reserve. NOT_FOUND for an avatar that is not saved and active, a
//   launch that is not the unfinished one, or an avatar it does not hold. Why a command and not `runs.estimateFromScenes` for a launch's set: that refuses a set with a scene
//   that has no text, which is the very state of the review the strip prices.
// Stage 4, S4.6r to S4.10 (additive, no bump; one bundle with the window; listed here after the fact, S4.10 fix D, since the contract's own tests held them and this changelog did not):
//  - `WaitingReason` and `LogKind` `library-unknown` (the §22 follow-up of S4.6c2): the library cannot say which of an avatar's photos are free (its usage is unknown), so nothing is picked or dropped yet; the row waits
//    and the line is written once.
//  - `InternalHoldKind` `job-failed` (S4.6r), beside `allocation-exceeded`: a paid job ended in a way no row of the failure table covers; «Продолжить» runs it again. `PaidHold.internal.detail.message`
//    (optional, only with `job-failed`, enforced by the schema) carries the job's words, paths scrubbed and cut; `LogKind` `hold-internal` carries `holdKind` and the same words as `detail`.
//  - `LogKind` `render-retry` (S4.6r): a render that ended without a video is submitted again once, free; the second failure drops the video (`render-dropped`).
//  - `LogKind` `open-set` (S4.10): the owner's own open scene set stands in the way of an avatar's compose; written once per wait.
//  - `HOST_ASLEEP_DETAIL` (S4.7), a plain `EngineError.detail` string and no new `ErrorCode`: main refuses a command that starts paid work or moves a launch while the Mac sleeps or has just woken;
//    nothing was sent, and a retry a moment later goes through. The window words it in Russian.
// Stage 5, S5.0a (additive, no bump; a new command and two optional error fields, nothing that exists changes): `avatars.editDescriptor { avatarId, text, expectedText }` →
//   `{ avatar }`, the owner's own free edit of a saved avatar's descriptor (a stale `expectedText` is refused); `EngineError.descriptorReason` (`DESCRIPTOR_REASONS`, only on VALIDATION,
//   never beside another reason; Russian texts `DESCRIPTOR_REASONS_RU` / `descriptorReasonRu`) and `EngineError.descriptorWords` (the owner's own offending words, only with
//   the reason `youth-word`). No new ErrorCode.
// Stage 5, S5.0c (additive, no bump; two new commands and one optional result field, nothing that exists changes): `avatars.estimateCheckDescriptor { avatarId }` → `Estimate` (free; also for a
//   draft) and `avatars.checkDescriptor { avatarId, acceptedWorstMicros }` → `{ check: DescriptorCheck }` (paid; never writes); `avatars.importAvatar`'s result gains the optional nullable
//   `descriptorCheck`. `DescriptorCheck`, `AspectVerdict`, `CheckAspect`, `CheckState` live in avatar.ts. No new ErrorCode.
// Stage 5, S5.2a (additive, no bump; two new commands, optional fields, one new reason): `avatars.setBody { avatarId, body }` and `avatars.dismissBodyProposal { avatarId }` → `{ avatar }` (free);
//   `AvatarBody` (the eight optional body traits, body.ts) whose keys are also keys of `AvatarTraits`; `AvatarDescriptor.body` (the code-written body phrase, never stored in the text);
//   `AvatarSummary.body` and `AvatarSummary.bodyProposal` (OMITTED, never null, when unset); `DescriptorReason` `too-long-with-body`. No new ErrorCode.
// Stage 5, S5.3a (additive, no bump; five new commands, a job kind, an error field; nothing that exists changes): the reference portrait of an imported avatar.
//  - commands `avatars.estimatePortraits` (free, `{}` → `Estimate`), `avatars.generatePortraits { avatarId, acceptedWorstMicros }` → `{ jobId }` (paid), `avatars.portraits { avatarId }` →
//    `AvatarPortraits` (free read), `avatars.pickPortrait { avatarId, photoId }` → `{ avatar }` and `avatars.discardPortraits { avatarId }` → `{ avatarId, removed }` (free).
//  - the job kind `avatar.portraits` in the job events and `JobState` (`done / total` count its five slots) and its result `PortraitsResult`; `PortraitCandidate` (with its likeness, 0.55 to 1),
//    `FailedPortraitSlot` (`age-rejected`, `unlike`, `no-face`, `multiple-faces`, `failed`) and `PortraitSlot` live in state.ts.
//  - `EngineError.portraitReason` (`PORTRAIT_REASONS`, on VALIDATION, and on INTERNAL for `source-unavailable`; never beside another reason; Russian texts `PORTRAIT_REASONS_RU`). No new ErrorCode.
//  - `AvatarSummary` is unchanged: a portrait is an ordinary photo of the avatar and `masterPhotoId` moves to it.
//  - S5.3c (a refinement of the shape above, before any window reads it): `AvatarPortraits.masterLikeness` is null exactly when the master is the source photo, the avatar has no source photo, or its master is missing (`AvatarPortraits.masterMissing`, omitted unless true: the master is a portrait whose file is gone while the source is alive; the batch and the check still run from the source).
//    An `avatar.portraits` job stores a slot's portrait BEFORE it emits the `job.progress` that counts it, so a window that re-reads `avatars.portraits` on every progress sees it.
//  - S5.3R (additive): a `failed` slot of `PortraitsResult.failedSlots` carries `charge` (`free`, `paid` or `worst-until-reconcile`): what the slot cost as the ledger settled its image and its age check
//    for the mode the batch was started in. The window shows it and no longer guesses it from the age-check setting.
export const PROTOCOL_VERSION = 5;
export const ProtocolVersion = z.literal(PROTOCOL_VERSION);

/** An event's position in the engine's event stream; starts at 1 and only grows. */
export const Seq = z.number().int().positive();

/** Turns a literal list into the non-empty tuple Zod's unions and enums expect. */
export function nonEmpty<T>(items: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("expected at least one item");
  return [first, ...rest];
}
