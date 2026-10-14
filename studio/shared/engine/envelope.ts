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
// Stage 5, S5.7a (additive, no bump): «Подача» and the angle from the scene.
//  - `RunRequest.level`, `COMPOSE_REQUEST_FIELDS.level` and `LaunchSettings.level` (`SceneLevel`, `ordinary` | `flirty`; absent = ordinary; `bold` is refused); `RunRequest.poses`,
//    `COMPOSE_REQUEST_FIELDS.poses` and `LaunchSettings.poses` become optional and are accepted and ignored for the angle (a window of an older build still sends them).
//  - `SceneView.level` (only `flirty`) and `SceneView.capture` (only when it is not the shot's own); `SceneSetView.poses` is echoed only when the set stored them and `SceneSetView.level`
//    only when it is flirty; `PhotoQaSummary.faceMarked`; `RunResult.failedReasons` (the scene reasons of the slots that ended with one).
//  - Rollback: an older build cannot read a plan.json, a scene-set file or a launch file that carries `level` or lacks `poses` (its schemas are strict), so a library used by this build
//    is not opened again by an older one once S5.7c ships the window that stops sending `poses`.
// Stage 5, S5.8a (additive, no bump): «Ножки».
//  - `RunRequest.legsShare`, `COMPOSE_REQUEST_FIELDS.legsShare` and `LaunchSettings.legsShare` (`LegsShare`: 0, 15 or 30; absent = 0), and the stored set request's `legsShare`; `SceneView.framing`
//    (only `legs`) beside the scene's `capture`. The same rollback limit as S5.7a: an older build's strict schemas cannot read a plan.json, a scene-set file or a launch file that carries them.
//  - A request that asks for legs with no built-in category is refused for free (`sceneReason` / `launchReason` `legs-built-in-only`, Russian texts in `SCENE_REASONS_RU` / `LAUNCH_REASONS_RU`).
// Stage 5, 5a.3, S5.9a (additive, no bump; no new command, no new error code): «Смелая».
//  - `SceneLevel` gains `bold` (`RunRequest.level`, `COMPOSE_REQUEST_FIELDS.level`, `LaunchSettings.level` and a stored set's request level; a plan SLOT stays ordinary or flirty until S5.9c); `SceneView.level` and `SceneSetView.level` echo
//    `flirty` or `bold`. Until the two «Смелая» categories exist (S5.9b2) `bold` over the five ordinary built-ins draws exactly as `flirty`, the set and the plan keeping the level asked for.
//  - `SceneRoute` (`seedream`): `SceneView.route` and a plan slot's `route`; `PhotoSummary.route`, read from the sidecar's new optional `source.route` (a photo of the 1K fallback or made before
//    5a.3 carries none); `RunPlan.models.bold` (the bold image model, written only when the plan has a Seedream slot).
//  - `Estimate.boldAttemptMicros` (the price of one Seedream attempt, only when the plan has Seedream slots); `EngineError.priceScope` (`bold`, only on PRICE_UNAVAILABLE).
//  - `SCENE_REASONS` gain `bold-level-needed`, `model-refused` and `model-empty`; `LAUNCH_REASONS` gain `bold-level-needed` (Russian texts in `SCENE_REASONS_RU` / `LAUNCH_REASONS_RU`).
//  - Rollback: an older build cannot read a plan.json, a scene-set file or a launch file whose request or draft carries `level: "bold"`, a plan with a slot `route` or `models.bold`, a `stoppedError` or slot end with `priceScope` or the new scene reasons (its schemas are strict), nor the ids of the
//    two «Смелая» categories S5.9b2 adds; a photo sidecar's `source.route` is stripped harmlessly (its source schema is not strict). Roll back only before the first «Смелая» run.
// Stage 5, 5b.1, S5.V1 (additive, no bump; nine commands, a job kind, an error field, a money field; nothing that exists changes): «Оживить», one photo into one clip.
//  - commands `clips.options` (free, `{ avatarId, photoId }` → `ClipOptions`: a suitable photo's sheet, or an unsuitable one with its reason), `clips.create` (paid, held while the Mac sleeps;
//    `{ avatarId, photoId, motionId, model, quality, seconds, fallback, acceptedWorstMicros }` → `{ jobId }`, no reveal), `clips.list` (→ `{ clips, notListedTotal? }`), `clips.get`
//    (→ `{ clip }`, each export with its `fileState`), `clips.markSeen`, `clips.delete`, `clips.retryDownload` and `clips.export` (→ `{ jobId }`), all free; and `clips.reveal`, which only main answers
//    (`MAIN_ONLY_COMMANDS`; the engine refuses it).
//  - the job kind `clip` in the job events and `JobState` (`done / total` count the steps of a clip, or the frames of an export; `phase`, and in `rendering` the `model` and `submittedAt`, in
//    `proving` the `proveUntil`) and its result `ClipJobResult`; `ClipSummary`, `ClipOptions`, `ClipExport` (its profile says which fps mode made the file) and the rest live in clips.ts.
//  - `EngineError.clipReason` (`CLIP_REASONS`, only on VALIDATION, or on IN_FLIGHT for `one-at-a-time`, `job-running` and `submitted`; never beside another reason; Russian texts `CLIP_REASONS_RU`)
//    and `EngineError.priceScope` gains `video` (only on PRICE_UNAVAILABLE; its text is in `PRICE_SCOPES_RU`).
//  - `MoneyStatus.reconcileAvailableAt` (the open variant only, optional): the earliest time `money.reconcile` can run while it is held.
//  - (S5.V8 follow-up) `CLIP_FILE_DAMAGED_DETAIL`: the detail of an INTERNAL export stopped by the clip's own file in Studio, so the window never calls that file intact.
//  - `Estimate` moved to estimate.ts and is still exported from state.ts. Rollback: an older build cannot read a clip job in a snapshot (its `JobState` is strict), and never looks in a `clips` folder.
//  - (S5.V8b, additive, optional) a clip create job also carries `photoId`, `request`, `motion` (`source` and `label` only) and `acceptedWorstMicros` in its job.progress and its `JobState`, taken from the journal's `requested` line, so a window that first sees
//    the job (a new window after a restart, a reload mid-render) draws its tile whole. An export job and an older engine's job carry none. Rollback: an older build refuses a clip job that carries them (its `JobState` and `JobProgress` are strict); roll back only with no clip job running.
//  - (S5.V8b follow-up, additive, optional) a clip job also carries `openReserveMicros`: what the ledger can still charge for the clip (the sum of its open reserves), told wherever one is open and absent where none is; the tile of
//    `late` and `recovering` says it as «спишется при сверке», every other phase says `acceptedWorstMicros`. The four facts above are told together or not at all (a schema refine). Rollback as above.
// Stage 5, 5b.2, S5.WA1 (additive, no bump; one command, one summary field each on a media and a clip, two clip reasons): clips in the montage editor.
//  - command `media.importClip` (free, an engine command: `{ avatarId, clipId }` → `{ mediaId }` when a live copy exists, else `{ jobId }`; no path): a ready clip becomes the editor's own video, as its own copy,
//    one per clip. It answers after its pre-job checks on the default deadline, like `media.import`; the encode runs in an `import` job. Its refusals use the machinery that exists, in this order: LIBRARY_UNAVAILABLE,
//    NOT_FOUND, VALIDATION `clipReason` `not-ready`, IN_FLIGHT `job-running`, VALIDATION `file-damaged`, MEDIA_UNSUPPORTED `mediaReason` `no-space` for a full disk (there is no DISK_FULL code).
//  - `MediaSummary.origin` (optional, only on a video): `{ kind: "clip", avatarId, clipId, photoId }`, strict. The `import` job ref (`JobState`, `JobProgress`, `JobFailed`, `JobCancelled`) gains the same optional `origin`.
//    `ClipSummary.use` (optional, only on a ready clip, at least one key, else absent; Q-F = 1): `inVideo` `"clip" | "photo"` (a finished video holds this clip, or its frame through the photo or a sibling clip) and
//    `inDrafts` `{ count, first?: { name, frame } }` (drafts that hold the copy; the delete dialog's warning, with the first draft's `MontageName` and 1-based frame).
//  - `CLIP_REASONS` gain `file-damaged` (VALIDATION) and `in-use` (IN_FLIGHT, a `clips.delete` while a render holds the copy); Russian texts in `CLIP_REASONS_RU`.
//  - `frame-foreign` and `frame-repeated` (the admission's PHOTO_UNAVAILABLE details, plan §5.1.3) are details of an existing code and belong to the engine task S5.WA2, not to this contract.
//  - Rollback: a 5b.1 build reads media and video records loosely and ignores `origin` and `clipFrames`: a clip copy shows in «Мои» as an ordinary own video (placeable, deletable by hand) and a photo used only
//    through a clip copy looks free; nothing becomes unreadable, the fields survive, and a 5b.2+ build reads them again; videos rendered by the old build carry no `clipFrames`.
//    Job refs carry `origin` only on the wire while a job runs. `use` and the two new reasons are wire-only within one build: nothing stores them, so an older build never reads them from disk. Studio has no downgrade path; roll back only before the first clip is put in a montage.
// Stage 5, 5b.2, S5.WB1 (additive, no bump; three commands, one job phase and four job fields, two clip reasons, one error field): the batch «Оживить выбранные» (part B1, one clip at a time).
//  - commands `clips.batchOptions` (free: `{ avatarId, photoIds: 1..20 unique }` → `ClipBatchOptions`: each photo's `ClipOptions`, the four sums `{ expected, worst, worstNoFallback }`, `monthRoomMicros`, `monthFits`),
//    `clips.createBatch` (paid, held while the Mac sleeps: `{ avatarId, items: 1..20 { photoId, motionId } with unique photos, quality, seconds, fallback, acceptedWorstMicros }` → `{ batchId, jobIds }`; the accepted
//    worst case is the SUM of the members'; no `model`, no motion text) and `clips.cancelBatch` (free: `{ avatarId, batchId }` → `{ cancelled }`, queued members only). Deadlines: `clips.batchOptions` counts ⌈20 / 4⌉ parallel plan reads
//    (`CLIP_PLAN_READ_PARALLEL`), `clips.createBatch` adds 1 s per item (L4).
//  - `MAX_BATCH_CLIPS` (20), `MAX_CLIPS_IN_FLIGHT` (1 under B1; B2 may raise it to 3 in a later reviewed commit) and the one batch price formula `clipBatchWorstMicros` / `clipBatchExpectedMicros` (Σ of the single-clip formulas,
//    whole micro-dollars) live in `shared/engine/clips.ts` and nowhere else.
//  - the clip job phase `queued` (first in `CLIP_PHASES`); a clip job also carries `batchId`, `batchIndex` (1-based) and `batchSize` (all three or none) and `waitReason` (`turn` | `alone` | `rate-limit` | `proof`, only on `queued` or
//    `proving`). `ClipRecord` and `ClipSummary` also carry the same trio `batchId`, `batchIndex`, `batchSize` (optional, all three or none, the place within the size) so the «Клипы» tab's batch header survives `KEEP_FINISHED`
//    and a restart (L9): the window counts members by DISTINCT `batchIndex` (a 429 requeue gives two records for one photo) and says «не снимались N» as `batchSize` minus the members that have a record. A cancelled clip job (`job.cancelled`, `JobState`) may say why: `detail`
//    `ClipCancelDetail` (`photo-gone` = removed from the gallery | `photo-unreadable` = in the gallery, file missing or damaged | `price-changed` | `price-unavailable` | `ledger-stopped` | `money-uncertain` | `cancelled`); the Russian texts are `clipCancelDetailRu(detail, count)` (mockups 60c-60f).
//    A `queued` job must carry the whole trio, `done` 0, and no model, submit time, proof window or open reserve. `clips.createBatch`: NOT_FOUND means the avatar only; a member's missing or foreign photo is VALIDATION
//    `not-a-gallery-photo` at `path: ["items", i]`. `clips.cancelBatch` answers `cancelled` 0..20. `clipBatchDroppedRu(count)` is the header's text after a restart or quit dropped the queue.
//  - `CLIP_REASONS` gain `batch-running` and `clip-busy`, both IN_FLIGHT only. There is ONE `clipReason` per error and no `batch-member` reason: an item that breaks a rule is refused as VALIDATION with its OWN reason and the new
//    `EngineError.path` `["items", i]` (only on a VALIDATION with a `clipReason`) (L3).
//  - two refines carried over from the WA1 review: `ClipUse.inDrafts.first` only when `count` is 1, and the import job's `origin` (`JobState`, `JobProgress`, `JobFailed`, `JobCancelled`) only when `mediaKind` is `video`.
//    Rollback of these two: a build without them accepts what this one refuses, never the other way round.
//  - Rollback: the `ClipRecord` trio `batchId` / `batchIndex` / `batchSize` is PERSISTED ON DISK (a clip record), and an older build (5b.1/5b.2 before this task) has a STRICT `ClipRecord` (`engine/clips/store.ts` reads a record that fails it as `invalid`), so it would list a batch member's record as unreadable; unlike the media and video records of 5b.2 part A, this one is not read loosely. The job fields, `queued`,
//    `waitReason`, `detail`, `path`, `ClipSummary.batchId` and the two new reasons are wire-only within one build: nothing stores them. Studio has no downgrade path; roll back only before the first batch is run.
// Stage 5, 5b.2, S5.WC1 (additive, no bump; four commands, two motion sources and id forms, four reasons, one new on-disk store): part C «свои движения», the vision writer's suggestions and the owner's own idea (Q-H = 2).
//  - commands `clips.estimateSuggest` and `clips.estimateIdea` (free: `{ avatarId, photoId }` → `Estimate`), `clips.suggestMotions` (paid, held while the Mac sleeps: `{ avatarId, photoId, acceptedWorstMicros }` → `outcome` `ok`
//    { `motions` 1..3 `v-<n>`, `reading`, `costMicros` } | `none` { `costMicros` }) and `clips.translateIdea` (paid, held: `{ avatarId, photoId, text, acceptedWorstMicros }`, `text` the owner's idea of 1..300 characters with no control
//    character → `ok` { `item` an `o-<n>` motion, `costMicros` } | `none` { `costMicros` } | `rejected` { `problems` non-empty, unique, in the fixed display order `MOTION_PROBLEMS`, `costMicros` }). Every result carries `costMicros`: the window
//    says «бесплатно» only when it is 0 (a mixed paid-then-moderation `none` shows «оплачено $X»), and a cost above 0 shows as at least $0.001 (`motionCostShownMicros`). Deadlines: the estimates `PRICE_FETCH_TIMEOUT_MS` + slack; the paid
//    calls add the library's identity and `MOTION_MAX_ATTEMPTS` (2) attempts at their slowest.
//  - `ClipMotionId` gains `v-<1..99>` and `o-<1..99>`; `ClipMotionChoice.source` and `ClipMotion.source` gain `vision` and `own`, and the form of an id belongs to its source (`clipMotionIdSource`); a vision or own text is at most 60 characters
//    of printable ASCII. `ClipOptions.motions` is up to 9 (`CLIP_MOTIONS_MAX`) with a limit per source (`CLIP_CHOICES_MAX`: scene 1, code 3, vision 3, own 2), in the order scene, code, vision, own.
//    `ClipFrameReading` (`notes`: `capture-differs`, `second-phone`; marks only) comes with the suggestion. `MotionProblem` (nine closed codes, `MOTION_PROBLEMS_RU` texts) comes with a rejection.
//    The micros constants `MOTION_SUGGEST_*` and `MOTION_TRANSLATE_*` and the pure `ownIdeaLabel` (the owner's words cut by word to 40 characters with a «…»; the engine makes the label) live in `shared/engine/clipMotions.ts`.
//  - `CLIP_REASONS` gain `motion-busy`, `suggest-busy` and `idea-busy` (IN_FLIGHT only) and the Russian text of `clip-busy` is the owner's final one. The guard is two-way and GLOBAL: `clips.create` and `clips.createBatch` answer
//    `motion-busy` while ANY part C call runs (any avatar, any photo), and the two paid calls answer `clip-busy` while any clip money unit is in flight.
//  - on disk: `avatars/<id>/motions/<photoId>.json` (`MOTIONS_DIR`, `MotionStoreFile`, `schemaVersion` 1, strict) is a NEW store that no 5b.1 build reads (it never looks in that folder). The clip record's `motion.source` is PERSISTED and widened:
//    a 5b.1 build has a STRICT `ClipRecord` (`ClipMotion.source` is `scene` | `code` on 91adc7f0; `engine/clips/store.ts` reads a record that fails it as `invalid`), so it would list a clip made from a suggestion or an own idea as unreadable,
//    and its journal parser skips a `requested` line it cannot parse. Everything else (the commands, results, `ClipFrameReading`, `MotionProblem`, the three reasons, the ids on the wire) is wire-only. Studio has no downgrade path;
//    roll back only before the first clip is made from a suggestion or an own idea.
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
