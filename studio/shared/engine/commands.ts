import { z } from "zod";
import { AvatarName, AvatarTraits } from "./avatar";
import { nonEmpty, ProtocolVersion } from "./envelope";
import { EngineError } from "./errors";
import { EventMessage } from "./events";
import { Focus, MAX_CLIPS, MAX_LISTED_MONTAGES, Montage, MontageDraft, MontageIssues, MontageListItem, MontageName, MontageShape, PhotoRef, TextLayer } from "./montage";
import { AbsolutePath, ApiKey, Count, Id, Micros, ModelId, MusicKey } from "./primitives";
import { FileState, MAX_LISTED_VIDEOS, VideoSummary } from "./video";
import {
  ApiKeyStatus,
  AvatarSummary,
  Draft,
  EngineNotice,
  Estimate,
  ExportStatus,
  ImageAgeCheck,
  JobState,
  MoneyStatus,
  MAX_PEAK_BARS,
  MIN_PEAK_BARS,
  MusicKeyStatus,
  MusicListResult,
  MusicPeaksResult,
  MusicStatus,
  NetworkConcurrency,
  PhotoSummary,
  ReconcileResult,
  RunRequest,
  RunSummary,
  Settings,
  UnreadableAvatar,
} from "./state";

/**
 * `avatars.pickImportPhoto`'s result (T6c): the renderer never sends a path
 * or raw bytes (design constraint 1) — main opens its own native dialog,
 * reads the file itself (with a size cap) and forwards the bytes straight to
 * the engine over the control channel (control.ts's `import.stagePhoto`),
 * never through this command's own payload. `picked: false` is a plain
 * cancel (no dialog result), never an error.
 */
export const ImportPhotoPicked = z.discriminatedUnion("picked", [
  z.strictObject({ picked: z.literal(true), stagingId: Id, width: Count, height: Count }),
  z.strictObject({ picked: z.literal(false) }),
]);
export type ImportPhotoPicked = z.infer<typeof ImportPhotoPicked>;

/**
 * `settings.setExportPath`'s result (3e.3, K18): the renderer never names the folder (design constraint 1). Main opens its
 * own dialog; `picked: false` is a plain cancel. A picked folder answers the settings as they now stand, the folder's
 * `rootId` (the identity in its marker), and how many video records now resolve in it (`resolved`: they name this
 * `rootId`) and how many stay in another folder (`elsewhere`) until that folder is chosen again.
 */
export const ExportPathPicked = z.discriminatedUnion("picked", [
  // `incomplete`: some record files could not be read (or an avatar's records are more than one read takes), so the counts may be short.
  z.strictObject({ picked: z.literal(true), settings: Settings, rootId: Id, resolved: Count, elsewhere: Count, incomplete: z.boolean() }),
  z.strictObject({ picked: z.literal(false) }),
]);
export type ExportPathPicked = z.infer<typeof ExportPathPicked>;

/** A path as a person reads it (home as «~»), composed by main: for display only, never to be sent back as a path. */
export const DisplayPath = z.string().min(1).max(4096);

const Empty = z.strictObject({});

/** A window of a track is at most a day: far past any track, and it bounds the work a request can ask for. */
const MAX_PEAK_WINDOW_MS = 24 * 3600 * 1000;

/** `music.peaks`' request (K26): a trending track by id, or (from 3f) an own one by media id. */
export const MusicPeaksRequest = z.strictObject({
  track: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("trending"), trackId: Id }),
    z.strictObject({ source: z.literal("own"), mediaId: Id }),
  ]),
  startMs: Count.max(MAX_PEAK_WINDOW_MS),
  durationMs: Count.min(1).max(MAX_PEAK_WINDOW_MS),
  bars: z.number().int().min(MIN_PEAK_BARS).max(MAX_PEAK_BARS),
});
export type MusicPeaksRequest = z.infer<typeof MusicPeaksRequest>;

/** runs.list answers at most this many runs, newest first. */
export const MAX_LISTED_RUNS = 100;

/**
 * photos.list answers at most this many photos, newest first: no cursor yet
 * (T8b). A single run already caps at 100 photos (RunRequest.count); this is
 * a generous multiple of that for one avatar's whole gallery across many
 * runs, picked as a simple bound for now rather than because anything today
 * demands more — revisit with a cursor if a real library ever approaches it.
 */
export const MAX_LISTED_PHOTOS = 500;

/**
 * `montages.create`'s photos: none (an empty draft, «Новый монтаж») up to the
 * clip cap, each at most once (a scene photo appears once per montage).
 */
const MontagePhotoIds = z
  .array(Id)
  .max(MAX_CLIPS)
  .refine((ids) => new Set(ids).size === ids.length, "photoIds must not repeat");

/** Avatar records the engine could not list normally, kept bounded (the Snapshot and avatars.list). */
export const MAX_UNREADABLE_AVATARS = 200;
const UnreadableAvatars = z.array(UnreadableAvatar).max(MAX_UNREADABLE_AVATARS);

function defineCommand<const T extends string, P extends z.ZodType, R extends z.ZodType>(
  type: T,
  payload: P,
  result: R,
) {
  return {
    type,
    payload,
    result,
    command: z.strictObject({
      v: ProtocolVersion,
      id: Id,
      kind: z.literal("command"),
      type: z.literal(type),
      payload,
    }),
    response: z.strictObject({
      v: ProtocolVersion,
      id: Id,
      kind: z.literal("response"),
      type: z.literal(type),
      ok: z.literal(true),
      result,
    }),
  };
}

/**
 * Everything a new window needs to rebuild its state, the avatar wizard
 * included. Events with the same `bootId` and `seq > lastSeq` are applied on
 * top (the window can close while the app keeps running on macOS). A new
 * `bootId` means the engine restarted and its seq numbering began again.
 */
export const Snapshot = z.strictObject({
  bootId: Id,
  lastSeq: Count,
  settings: Settings,
  money: MoneyStatus,
  avatars: z.array(AvatarSummary),
  drafts: z.array(Draft),
  /** Avatar records (saved or draft) in the library that could not be read into the lists, with their ids and why. */
  unreadableAvatars: UnreadableAvatars,
  /** How many there really are, even past the `MAX_UNREADABLE_AVATARS` bound: the list can be cut, this count never is (L1). */
  unreadableTotal: Count,
  jobs: z.array(JobState),
  /**
   * Bumped by one every time the live library folder actually changes (a
   * switch confirmed, or the library becoming unavailable). Also on
   * `settings.changed`, so a window resyncs on a genuine switch even when the
   * path string alone would not say so (e.g. the same folder reached through
   * two different spellings is not a switch; a folder that stops resolving
   * while the path is unchanged still needs a compare that is not fooled by
   * either case).
   */
  librarySwitchGeneration: Count,
  /** Whether the export folder can take a video now; stubbed `ok` until task 3a.8a checks it. */
  exportStatus: ExportStatus,
  /** Notices still pending, oldest first: a window opened after one was emitted still shows it. */
  notices: z
    .array(EngineNotice)
    .refine((notices) => new Set(notices.map((n) => n.noticeId)).size === notices.length, "notices must not repeat"),
});

/**
 * Events after a seq, or `gap` when older events were evicted or the caller's
 * `bootId` belongs to an earlier engine; either way a snapshot is needed.
 */
export const EventsSince = z.discriminatedUnion("gap", [
  z.strictObject({ gap: z.literal(true) }),
  z.strictObject({
    gap: z.literal(false),
    events: z
      .array(EventMessage)
      .refine((events) => events.every((e, i) => i === 0 || e.seq > (events[i - 1]?.seq ?? 0)), {
        message: "events must be in strictly increasing seq order",
      }),
  }),
]);

/**
 * The worst case the user saw and agreed to. A paid command whose current
 * worst case is higher is refused with PRICE_CHANGED before anything is spent.
 */
const AcceptedWorst = { acceptedWorstMicros: Micros };

/** Commands main answers itself; the API key never travels to the engine inside a command. */
const MAIN_ONLY_SPECS = [
  defineCommand("settings.setApiKey", z.strictObject({ key: ApiKey }), ApiKeyStatus),
  defineCommand("settings.clearApiKey", Empty, ApiKeyStatus),
  // Stage 3 (3c.2, K27): the RapidAPI key, in its own KeyStore. The renderer can set and clear it and never read it
  // back; there is no check command (Q4), since a check would spend one of the 30 requests.
  defineCommand("settings.setMusicKey", z.strictObject({ key: MusicKey }), MusicKeyStatus),
  defineCommand("settings.clearMusicKey", Empty, MusicKeyStatus),
  // T6c (import an existing avatar): the renderer asks main to open its own
  // native file dialog and read the picked photo (design constraint 1) — an
  // empty payload, exactly like settings.setLibraryPath's dialog is never
  // handed a real path by the renderer. main forwards the bytes to the
  // engine over the control channel (control.ts's `import.stagePhoto`),
  // never through this command.
  defineCommand("avatars.pickImportPhoto", Empty, ImportPhotoPicked),
  // Stage 3 (3e): «Показать в папке». Only main can open the system file manager (`shell.showItemInFolder`),
  // and only for a video whose file is `present`; the engine has no such command.
  defineCommand("videos.reveal", z.strictObject({ videoId: Id }), z.strictObject({ videoId: Id })),
  // Stage 3 (3e.3, K18): the export folder «Готовые видео». Main opens its own folder dialog (at the current folder), and the
  // engine checks the pick (overlap, directory, write probe, marker; the marker is written when the folder has none) and
  // counts the records that resolve in it. Nothing changes on a cancel, and nothing on a refusal: EXPORT_UNAVAILABLE
  // (`exportReason`) for a folder that cannot be used, IN_FLIGHT while a render is queued or running, VALIDATION for a
  // pick that is not an absolute path.
  defineCommand("settings.setExportPath", Empty, ExportPathPicked),
  // The export folder as a person reads it (`~/Studio/export`): only main knows the home folder, and the window has no other
  // way to show the path the way the design does. Re-asked whenever `Settings.exportPath` changes.
  defineCommand("settings.exportDisplay", Empty, z.strictObject({ display: DisplayPath })),
  // Stage 3 (3e.2, K17): «Папка «Готовые видео»» on the avatar's «Видео» tab. The window names the avatar, never a folder: main
  // finds the avatar's folder in the export folder from the place of one of its videos and opens it in the system file manager;
  // with none there yet it opens the export folder itself (`opened` says which). EXPORT_UNAVAILABLE (`exportReason`) when the
  // export folder cannot be used, NOT_FOUND for an unknown avatar.
  defineCommand("videos.revealFolder", z.strictObject({ avatarId: Id }), z.strictObject({ opened: z.enum(["avatar", "root"]) })),
] as const;

/** Commands main forwards to the engine. */
const ENGINE_SPECS = [
  // settings
  defineCommand("settings.get", Empty, Settings),
  defineCommand("settings.setBudget", z.strictObject({ monthlyBudgetMicros: Micros }), Settings),
  defineCommand("settings.setLibraryPath", z.strictObject({ path: AbsolutePath }), Settings),
  defineCommand("settings.setModels", z.strictObject({ imageModel: ModelId, textModel: ModelId }), Settings),
  defineCommand("settings.setConcurrency", z.strictObject({ network: NetworkConcurrency }), Settings),
  defineCommand("settings.setImageAgeCheck", z.strictObject({ imageAgeCheck: ImageAgeCheck }), Settings),
  // money
  defineCommand("money.status", Empty, MoneyStatus),
  defineCommand("money.reconcile", Empty, ReconcileResult),
  // avatars (2a). One avatar job = descriptor + candidate batches + age checks, under one cap.
  // A draft is an avatar with status "draft"; picking a candidate makes it active.
  defineCommand("avatars.list", Empty, z.strictObject({ avatars: z.array(AvatarSummary), unreadableAvatars: UnreadableAvatars, unreadableTotal: Count })),
  // A new avatar: the descriptor call, then the first batch of candidates and their age checks.
  defineCommand("avatars.estimate", z.strictObject({ traits: AvatarTraits }), Estimate),
  // Another batch for an existing draft: candidates and their age checks, no descriptor call.
  // Keyed like avatars.generateCandidates, whose acceptedWorstMicros it produces.
  defineCommand("avatars.estimateCandidates", z.strictObject({ avatarId: Id }), Estimate),
  // The descriptor-only recovery for an avatar listed in unreadableAvatars with
  // reason "descriptor-invalid": no candidates, no age checks. Keyed like
  // avatars.rewriteDescriptor, whose acceptedWorstMicros it produces.
  defineCommand("avatars.estimateRewriteDescriptor", z.strictObject({ avatarId: Id }), Estimate),
  defineCommand(
    "avatars.createDraft",
    z.strictObject({ traits: AvatarTraits, ...AcceptedWorst }),
    z.strictObject({ draft: Draft }),
  ),
  defineCommand(
    "avatars.generateCandidates",
    z.strictObject({ avatarId: Id, ...AcceptedWorst }),
    z.strictObject({ jobId: Id }),
  ),
  defineCommand("avatars.cancel", z.strictObject({ jobId: Id }), z.strictObject({ jobId: Id })),
  defineCommand(
    "avatars.pick",
    z.strictObject({ avatarId: Id, photoId: Id, name: AvatarName }),
    z.strictObject({ avatar: AvatarSummary }),
  ),
  defineCommand("avatars.archive", z.strictObject({ avatarId: Id }), z.strictObject({ avatar: AvatarSummary })),
  // The paid recovery for an avatar whose stored descriptor fails today's
  // rules: rewrites it from the avatar's stored typed traits alone (the same
  // descriptor job as createDraft), keeping its master photo, candidates and
  // name untouched. Refused with VALIDATION when the descriptor already fits
  // today's rules (nothing to fix, so no spend), or NOT_FOUND for an unknown id.
  defineCommand(
    "avatars.rewriteDescriptor",
    z.strictObject({ avatarId: Id, ...AcceptedWorst }),
    z.strictObject({ avatarId: Id }),
  ),
  // T6c: import an existing avatar from one photo the owner already has,
  // instead of generating one. `stagingId` names a photo staged by main's
  // dialog (avatars.pickImportPhoto, above) and validated/downscaled by the
  // engine; the estimate must be for that exact staged image (design
  // constraint 1: pick, then estimate, then accept). Worst case: one
  // one-time image age check + up to two vision-description attempts.
  defineCommand("avatars.estimateImport", z.strictObject({ stagingId: Id }), Estimate),
  // Refused with AGE_CHECK_FAILED when the one-time age check on the staged
  // photo does not clearly confirm an adult (nothing is stored, reserves are
  // settled); `confirmedAiPersona` must be exactly `true` — the engine refuses
  // without the owner's confirmation that the photo is an AI persona, not a
  // real person (a schema-level requirement, not a business check, so a
  // missing or false confirmation never even reaches the engine's logic).
  defineCommand(
    "avatars.importAvatar",
    z.strictObject({ stagingId: Id, name: AvatarName, confirmedAiPersona: z.literal(true), ...AcceptedWorst }),
    z.strictObject({ avatar: AvatarSummary }),
  ),
  // photo runs (T6). A run is persisted in the library (its plan and journal),
  // so it outlives its jobs: a resume is a new job of the same run. The run's
  // worst case is its cap for its whole life, resumes included.
  // Free; NOT_FOUND unless the avatar is saved and active, DESCRIPTOR_INVALID for a descriptor to rewrite first.
  defineCommand("runs.estimate", RunRequest, z.strictObject({ estimate: Estimate })),
  // Plans and persists the run, then answers; the job runs on (job.progress, then job.done/failed/cancelled).
  defineCommand("runs.start", RunRequest.extend(AcceptedWorst), z.strictObject({ runId: Id, jobId: Id })),
  // Aborts the run's requests in flight (their reserves stay at their worst case until reconciled); ok for a run
  // that is not running, NOT_FOUND for an unknown one.
  defineCommand("runs.cancel", z.strictObject({ runId: Id }), z.strictObject({ runId: Id })),
  // Free: what a resume could still spend — its open slots' remaining attempts at today's prices, never more
  // than the run's cap leaves. Keyed like runs.resume, whose acceptedWorstMicros it produces.
  defineCommand("runs.estimateResume", z.strictObject({ runId: Id }), z.strictObject({ estimate: Estimate })),
  // Continues a stopped run from its persisted state, never re-planning and never raising its cap; PRICE_CHANGED
  // when the remaining worst case rose above the accepted one. RECONCILE_REQUIRED after a crash until the user
  // reconciles; IN_FLIGHT while it runs; VALIDATION when every slot already ended.
  defineCommand("runs.resume", z.strictObject({ runId: Id, ...AcceptedWorst }), z.strictObject({ runId: Id, jobId: Id })),
  // Every run the open library holds, newest first (bounded), read from disk: how to find a run to resume after a restart.
  defineCommand("runs.list", Empty, z.strictObject({ runs: z.array(RunSummary).max(MAX_LISTED_RUNS) })),
  // T8b's gallery: an avatar's stored run photos, newest first, bounded at
  // MAX_LISTED_PHOTOS. NOT_FOUND only for an avatarId the library does not
  // have at all — a draft, an active avatar and an archived one all get
  // their (possibly empty) list, like avatars.list already lists archived
  // avatars normally; see engine.ts's own comment on this handler.
  // `skippedTotal` mirrors avatars.list's own unreadableTotal: a run photo
  // whose sidecar cannot be read into the contract's shape is not silently
  // lost — its count survives even though (unlike unreadableAvatars) there
  // is no per-item list to show for it.
  defineCommand(
    "photos.list",
    z.strictObject({ avatarId: Id }),
    z.strictObject({ photos: z.array(PhotoSummary).max(MAX_LISTED_PHOTOS), skippedTotal: Count }),
  ),
  // Stage 3: montages and rendered videos. A render spends nothing.
  // The owner's own "do not use" mark on a photo (rejected.jsonl); the mark is set or cleared, and the photo answered as it now stands.
  defineCommand(
    "photos.setRejected",
    z.strictObject({ avatarId: Id, photoId: Id, rejected: z.boolean() }),
    z.strictObject({ photo: PhotoSummary }),
  ),
  // Queues a render of a saved draft, or of a spec straight from a headless caller. Everything is checked in one step
  // BEFORE anything is claimed or written, and a refusal costs nothing (no job, no reservation, no file):
  //   MONTAGE_INVALID   (with issues) a montage that is not complete, or uses a part that is not supported yet
  //                     (layers, music, own media: `not-yet-supported`, N9);
  //   EXPORT_UNAVAILABLE (with exportReason) the export folder is unusable (invariant 35);
  //   PHOTO_UNAVAILABLE (with `photo-unavailable` issues by cell path) a scene photo that is not an eligible, unused one
  //                     of this avatar, or one another queued or running render holds; also an avatar whose usage cannot be
  //                     trusted right now (an unreadable record or a stale index: `detail` says which);
  //   RENDER_QUEUE_FULL (`detail` names the limit) too many renders are queued or running;
  //   LIBRARY_TOO_NEW   a video record was written by a newer Studio;
  //   NOT_FOUND         an unknown avatar, or a `montageId` no draft has; a draft file that cannot be read is INTERNAL.
  // A `montageId` renders the draft's spec as stored NOW (the job keeps that copy: a later save or delete does not reach it), and
  // is judged exactly like a `spec`. Deleting the draft while the render is queued or running is allowed: the video's record then
  // lists `montageId: null`, as `videos.list` does for a draft deleted after the video was made.
  // `spec` takes the montage's shape only, so a structurally invalid one gets that issue list rather than a bare
  // VALIDATION error. The answer carries the job and video ids; `job.progress`, then `job.done` / `job.failed` /
  // `job.cancelled` follow, and `video.changed` when the record lands.
  defineCommand(
    "videos.render",
    z.union([z.strictObject({ montageId: Id }), z.strictObject({ spec: MontageShape })]),
    z.strictObject({ jobId: Id, videoId: Id }),
  ),
  // Cancels a queued or running render; NOT_FOUND for an unknown job or one that is not a render. Ok for a render that
  // already ended (it stays as it ended). A cancel that arrives once the commit has claimed the video's name is IGNORED
  // by the commit ("done wins"): the answer is still ok and the job ends `done` (or `failed` if saving then fails).
  // From that point the job says so (`saving: true` on `job.progress` and in the snapshot), and the window shows a
  // «сохранение» phase with Cancel disabled.
  defineCommand("videos.cancel", z.strictObject({ jobId: Id }), z.strictObject({ jobId: Id })),
  // An avatar's video records, newest first, bounded at MAX_LISTED_VIDEOS; each with its file's state, checked on this read
  // (one shared hash budget per listing, so it stays a `stat` for almost every record). A record that cannot be read or
  // checked never fails the list: an unreadable one is left out, one whose look failed or did not answer reads `unchecked` (3e.2,
  // K15). NOT_FOUND for an unknown avatar.
  defineCommand("videos.list", z.strictObject({ avatarId: Id }), z.strictObject({ videos: z.array(VideoSummary).max(MAX_LISTED_VIDEOS) })),
  // Deletes a video by the OWNER'S INTENT, which the request carries (Studio never guesses it from a state it just looked at):
  //   mode "video"  («Удалить»): the file (when its FULL check finds it `present`), then the record; the photos are freed.
  //                 The export folder must be usable: an unavailable one answers EXPORT_UNAVAILABLE and NOTHING is deleted
  //                 (a sleeping network drive must never turn this into a record-only delete that orphans the file).
  //                 A file already `missing` or `changed` (never deleted: it is not provably Studio's) goes with only the
  //                 record; a record whose file is in another root (`elsewhere`) is EXPORT_UNAVAILABLE `missing`.
  //   mode "record" («Удалить запись»): ONLY the record, whatever the file's state, and never the file; the photos are freed.
  // Answers what it did: `fileDeleted`, and the file's `fileState` as it was found before anything was removed.
  // NOT_FOUND for an unknown video; LIBRARY_TOO_NEW for a record from a newer Studio; INTERNAL (detail names no path)
  // for a record that cannot be read or a disk that fails.
  defineCommand(
    "videos.delete",
    z.strictObject({ videoId: Id, mode: z.enum(["video", "record"]) }),
    z.strictObject({ videoId: Id, fileDeleted: z.boolean(), fileState: FileState }),
  ),
  // One video by id (3e.2), with its file's state looked at now: whatever its avatar and however many videos it has (a listing
  // stops at MAX_LISTED_VIDEOS). Main's «Открыть в папке» reads the record's place through it. NOT_FOUND for an unknown video;
  // LIBRARY_TOO_NEW for a record from a newer Studio; INTERNAL (detail names no path) for a record that cannot be read.
  defineCommand("videos.get", z.strictObject({ videoId: Id }), z.strictObject({ video: VideoSummary })),
  // «Убрать повреждённую запись» (3e.2, K16): every file among the avatar's video records that cannot be read as a record (and
  // every record misfiled under another avatar that names this one) is MOVED to the library's quarantine, never deleted, and the
  // records are read again. The engine decides from the disk as it is now: a file that reads as a sound record is never moved,
  // a record from a newer Studio is never moved (updating the app is its fix), a file the disk would not open is never moved (its
  // bytes may be a sound record: `record-inaccessible`), and a stale used index alone moves nothing.
  // Safe to repeat: with nothing broken it moves nothing. `avatar.changed` follows when the avatar's usage moved.
  // NOT_FOUND for an unknown avatar; INTERNAL (detail names no path) when a file could not be moved (those moved stay moved).
  defineCommand("videos.quarantineRecords", z.strictObject({ avatarId: Id }), z.strictObject({ avatarId: Id, quarantined: Count })),
  // «Восстановить отметки» (3e.2, K16): the owner's reject marks (`rejected.jsonl`) with a line that cannot be read. The file is
  // COPIED to the library's quarantine first, then replaced at once by the lines that read (a torn last line is dropped too),
  // so every mark that can be read is kept and nothing is ever lost without a copy. `rebuilt: false` when nothing needed it
  // (safe to repeat). `kept` counts the marks kept, `dropped` the lines left out. `avatar.changed` follows when the usage moved.
  // NOT_FOUND for an unknown avatar; INTERNAL (detail names no path) when the file could not be copied or written (it is then
  // as it was).
  defineCommand(
    "photos.rebuildRejected",
    z.strictObject({ avatarId: Id }),
    z.strictObject({ avatarId: Id, rebuilt: z.boolean(), kept: Count, dropped: Count }),
  ),
  // Stage 3 music (3c.3, K24, K25). The status is free and never touches the network. A refresh costs one of the 30
  // requests per 31 days, so it needs `confirm: true` and is manual only. It answers AT ONCE with the status (refresh
  // `running`), because it outlives main's command deadline; `music.changed` then carries its progress and its end.
  // Refusals cost nothing: MUSIC_KEY_MISSING, MUSIC_KEY_REJECTED, MUSIC_QUOTA_EXHAUSTED, IN_FLIGHT (one at a time) and
  // MUSIC_UNAVAILABLE (nothing could be sent, e.g. the quota log cannot be written). A request that left and failed
  // shows as `refresh: failed` with the error instead, and stays counted.
  defineCommand("music.status", Empty, MusicStatus),
  defineCommand("music.refresh", z.strictObject({ confirm: z.literal(true) }), z.strictObject({ status: MusicStatus })),
  // Stage 3 (3c.6): the way out of a damaged quota log (`MusicStatus.quotaLog: "corrupt"`), which otherwise reads 30 of 30
  // forever. The engine copies the file aside (`quota.jsonl.corrupt-<time>`) and starts a new log that counts as 30 sends
  // made now, so the quota is closed for exactly 31 days: the conservative reading of a count nobody can trust. It needs
  // `confirm: true` (the owner agreed to the 31 days) and sends nothing. Answers the new status; `music.changed` follows.
  //   VALIDATION         the log is not damaged (nothing to recover): nothing changed;
  //   MUSIC_UNAVAILABLE  it could not be done, with `musicReason` (no music folder, the clock, the log unreadable or unwritable,
  //                      a shutting-down engine): nothing changed, or the damaged log is still the log.
  defineCommand("music.recoverQuotaLog", z.strictObject({ confirm: z.literal(true) }), z.strictObject({ status: MusicStatus })),
  // Stage 3 track store (3c.4, K23, K26). `music.list` is free and reads what is on disk: the tracks of the current list
  // whose audio is stored, at most 100, each with its highlights ascending (the likely default last). `music.peaks` is
  // the waveform of a window of one track: `bars` integers from 0 to 1000, read from the envelope kept at download time
  // (no decode, no network). Both refuse nothing that costs: NOT_FOUND for a track that is not stored (and, until 3f, for
  // an own track), VALIDATION for a payload that breaks the contract.
  defineCommand("music.list", Empty, MusicListResult),
  defineCommand("music.peaks", MusicPeaksRequest, MusicPeaksResult),
  // A new draft for an avatar from 0 to 20 of its scene photos (0: an empty draft, «Новый монтаж»), with the focus of
  // every placed photo resolved and no name (`name: null`, the window says «без названия»). Refused, and nothing is stored, with
  //   PHOTO_UNAVAILABLE (issues `photo-unavailable` at `["photoIds", i]`) a photo that is not eligible, or is already in a video,
  //                     or is held by a render that is queued or running: one photo goes into one video;
  //   NOT_FOUND         an avatar that does not exist or is not active.
  // The focus of every photo is asked at the same time under ONE budget that fits main's 30 s deadline; a photo that could not be
  // judged in time gets `focus: null` (the preview draws the stand-in point, and a render tries again).
  defineCommand("montages.create", z.strictObject({ avatarId: Id, photoIds: MontagePhotoIds }), z.strictObject({ montage: Montage })),
  // A draft as it stands, with the engine's verdict: `issues` are the structural ones (`montageIssues(spec, "spec")`, what a
  // render would refuse) plus the referential ones (a photo that is no longer usable, a sticker that is gone), bounded at 64.
  // NOT_FOUND for a draft that does not exist; INTERNAL (its detail names no path) for a draft file that cannot be read or
  // was written by a newer Studio, or was replaced by saves faster than it could be read (detail: try again); LIBRARY_UNAVAILABLE
  // without a library.
  defineCommand("montages.get", z.strictObject({ montageId: Id }), z.strictObject({ montage: Montage, issues: MontageIssues })),
  // Drafts, newest `updatedAt` first, at most MAX_LISTED_MONTAGES; `total` counts every readable draft, `skippedTotal` the files
  // that could not be read (they are left out, never a failed list). No `avatarId` = every avatar. `videoCount` = the videos
  // rendered from the draft. NOT_FOUND for an `avatarId` the library does not have.
  defineCommand(
    "montages.list",
    z.strictObject({ avatarId: Id.optional() }),
    z.strictObject({ items: z.array(MontageListItem).max(MAX_LISTED_MONTAGES), total: Count, skippedTotal: Count }),
  ),
  // Replaces a draft's spec and name. `spec.avatarId` must be the stored draft's (VALIDATION otherwise); nothing is checked
  // against the library (a draft may hold a photo that was rejected since), so a save never fails for a photo. NOT_FOUND for a
  // draft that was deleted. Saves of one draft are applied in the order they arrive: the last one wins.
  defineCommand(
    "montages.save",
    z.strictObject({ montageId: Id, spec: MontageDraft, name: MontageName.nullable() }),
    z.strictObject({ montage: Montage }),
  ),
  // Removes a draft. Allowed while a render of it is queued or running: the job keeps its spec, and the video's record then
  // lists `montageId: null`. NOT_FOUND for a draft that does not exist.
  defineCommand("montages.delete", z.strictObject({ montageId: Id }), z.strictObject({ montageId: Id })),
  // The focus of one photo, for a photo the owner just placed (a cell change): `null` when it could not be judged (no face
  // models, no answer in time; the draft then stores null). At most 20 s. NOT_FOUND for an avatar that does not exist or is not
  // active, or an own upload (no such store yet); PHOTO_UNAVAILABLE (issue at `["photo"]`) for a scene photo that is not an
  // eligible photo of this avatar.
  defineCommand("montages.focus", z.strictObject({ avatarId: Id, photo: PhotoRef }), z.strictObject({ focus: Focus.nullable() })),
  // The engine's own picture of one text layer, for the editor's preview: the caption rules, the layout, the fixed template and
  // the rasteriser (the very ones a render uses), drawn at the 1080 scale. The PNG is written to
  // `userData/render-tmp/text/<previewId>.png` and served at `studio-media://text/<previewId>`; `width` and `height` are its
  // pixels, which `textBox` places. `avatarId` is accepted for the contract's sake (K20) and is not read: the caption rules are
  // technical only. The layer's timing and place are not used. Only the layer's own drawing fields are.
  //   TEXT_INVALID              the caption breaks a caption rule: `captionIssue` says which. The text has to change.
  //   RENDER_FAILED             the rasteriser timed out (`detail` says to shrink the caption or change the style: it is never
  //                             retried by the engine), or resvg, the template or the text worker failed.
  //   TEXT_PREVIEW_SUPERSEDED   this preview was still waiting its turn when a newer one of the same layer arrived, and was dropped.
  //                             A preview already being drawn is never cancelled.
  defineCommand(
    "montages.textPreview",
    z.strictObject({ avatarId: Id, layer: TextLayer }),
    z.strictObject({ previewId: Id, width: z.number().int().positive(), height: z.number().int().positive() }),
  ),
  // A fresh look at the export folder (3e.3, K9): the same check a render attempt makes, without a render. Free. The answer is the
  // status as the check found it, and `export.status` follows when it CHANGED, so a window that asks on focus shows an
  // unplugged drive, and a plugged one, without a render attempt.
  defineCommand("export.check", Empty, z.strictObject({ exportStatus: ExportStatus })),
  // engine
  defineCommand("engine.snapshot", Empty, Snapshot),
  defineCommand("engine.events", z.strictObject({ afterSeq: Count, bootId: Id }), EventsSince),
] as const;

const COMMAND_SPECS = [...MAIN_ONLY_SPECS, ...ENGINE_SPECS] as const;

type CommandSpec = (typeof COMMAND_SPECS)[number];
export type CommandType = CommandSpec["type"];
type EngineCommandType = (typeof ENGINE_SPECS)[number]["type"];

export const COMMAND_TYPES: readonly CommandType[] = COMMAND_SPECS.map((s) => s.type);
export const MAIN_ONLY_COMMANDS: readonly CommandType[] = MAIN_ONLY_SPECS.map((s) => s.type);
export const ENGINE_COMMAND_TYPES: readonly EngineCommandType[] = ENGINE_SPECS.map((s) => s.type);

export const CommandType = z.enum(COMMAND_TYPES);

export const CommandMessage = z.discriminatedUnion("type", nonEmpty(COMMAND_SPECS.map((s) => s.command)));
export type CommandMessage = z.infer<typeof CommandMessage>;
export type CommandPayload<T extends CommandType> = Extract<CommandMessage, { type: T }>["payload"];

/** The commands the engine accepts: everything except the main-only key commands. */
export const EngineCommandMessage = z.discriminatedUnion("type", nonEmpty(ENGINE_SPECS.map((s) => s.command)));
export type EngineCommandMessage = z.infer<typeof EngineCommandMessage>;

export const OkResponse = z.discriminatedUnion("type", nonEmpty(COMMAND_SPECS.map((s) => s.response)));
export type OkResponse = z.infer<typeof OkResponse>;
export type CommandResult<T extends CommandType> = Extract<OkResponse, { type: T }>["result"];

/**
 * A failed command. `id` and `type` are null when the command itself could not
 * be parsed far enough to know them, so the caller still gets an answer.
 */
export const ErrorResponse = z.strictObject({
  v: ProtocolVersion,
  id: Id.nullable(),
  kind: z.literal("response"),
  type: CommandType.nullable(),
  ok: z.literal(false),
  error: EngineError,
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** A response echoes its command's `id` and `type`; `ok` tells success from failure. */
export const ResponseMessage = z.discriminatedUnion("ok", [OkResponse, ErrorResponse]);
export type ResponseMessage = z.infer<typeof ResponseMessage>;

export type Snapshot = z.infer<typeof Snapshot>;
export type EventsSince = z.infer<typeof EventsSince>;
