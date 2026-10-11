import { z } from "zod";
import { AvatarName, AvatarTraits, DescriptorCheck } from "./avatar";
import { AutopilotContinueResult, AutopilotEstimateResult, AutopilotGetResult, AutopilotLaunchResult, AutopilotListResult, LaunchDraft, LaunchDraftInput, LaunchEntryId, LaunchMicros, LaunchView } from "./autopilot";
import { AvatarDeletePreview, AvatarDeleteResult } from "./avatarDelete";
import { AvatarBody } from "./body";
import { CategoriesListResult, CategoryDescription, CategoryName, CategoryPoses, CategorySummary, CustomCategoryId, POOL_OUTFITS_MAX, POOL_PLACES_MAX, PoolText } from "./categories";
import { nonEmpty, ProtocolVersion } from "./envelope";
import { EngineError } from "./errors";
import { EventMessage } from "./events";
import { ImageModelCatalogue, ImageQuality } from "./imageModels";
import { Focus, MAX_CLIPS, MAX_LISTED_MONTAGES, Montage, MontageDraft, MontageIssues, MontageListItem, MontageName, MontageShape, PhotoRef, TextLayer } from "./montage";
import { AbsolutePath, ApiKey, Count, Id, LaunchId, Micros, ModelId, MusicKey } from "./primitives";
import { COMPOSE_NEEDS_CATEGORY, COMPOSE_REQUEST_FIELDS, ComposeRequest, composeNeedsCategory, MAX_COMPOSE_SCENES, SceneEditOp, SceneWriteTarget, ScenesEditResult, ScenesGetResult } from "./scenes";
import { MediaCancelImportPayload, MediaCancelImportResult, MediaDeletePayload, MediaDeleteResult, MediaListPayload, MediaListResult, MediaPickImportPayload, MediaPickResult, MediaSummary } from "./media";
import { OwnStickerBytes, OwnStickerBytesPayload, StickerBytes, StickerBytesPayload } from "./stickerBytes";
import { FileState, MAX_LISTED_VIDEOS, VideoSummary } from "./video";
import {
  ApiKeyStatus,
  AvatarPortraits,
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

/** Whether the owner's «Опубликовано» marks could be read (Stage 4): `ok`, or `unknown` for a torn or unreadable `published.jsonl`. */
export const PublishedMarks = z.enum(["ok", "unknown"]);
export type PublishedMarks = z.infer<typeof PublishedMarks>;

/** A video shows at most 20 clips, each a collage of at most 4 photos: far past it, and it bounds a forged result. */
const MAX_REJECTED_PER_VIDEO = 100;

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
 * photos.list answers at most this many photos per page, newest first (T8b).
 * A single run already caps at 100 photos (RunRequest.count); this is a
 * generous multiple of that for one avatar's whole gallery across many runs.
 * Past it the gallery pages with a cursor (S4.P2, `PhotoCursor`): every photo
 * the autopilot may take can also be seen by the owner.
 */
export const MAX_LISTED_PHOTOS = 500;

const PHOTO_CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\|([A-Za-z0-9_-]{1,128})$/;

/** A position in photos.list's newest-first order: where the last shown photo stands. */
export type PhotoCursorPosition = { createdAt: string; photoId: string };

/** The cursor naming the position (createdAt, photoId) of the last photo of a page: `<createdAt>|<photoId>`. Keyset, not an offset. */
export function encodePhotoCursor(createdAt: string, photoId: string): string {
  return `${createdAt}|${photoId}`;
}

/** The position a cursor names, or null when it is not one of ours (a forged or damaged value). */
export function decodePhotoCursor(cursor: string): PhotoCursorPosition | null {
  const match = PHOTO_CURSOR_PATTERN.exec(cursor);
  const createdAt = match?.[1];
  const photoId = match?.[2];
  if (createdAt === undefined || photoId === undefined || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, photoId };
}

/**
 * photos.list's `cursor` (S4.P2; additive, protocol stays 5): the value a previous page's `nextCursor` gave. It crosses the
 * renderer-to-engine boundary, so the schema is the gate: anything that does not decode is refused as VALIDATION.
 */
export const PhotoCursor = z.string().max(160).refine((value) => decodePhotoCursor(value) !== null, "must be a cursor photos.list gave");
export type PhotoCursor = z.infer<typeof PhotoCursor>;

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
  /**
   * Stage 4 (additive): the library's launch that is not finished (running, paused, pausing or stopping), so a window opened later sees it; null or absent
   * when there is none. A finished launch is read with `autopilot.get`.
   */
  autopilot: LaunchView.nullable().optional(),
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
  // Stage 3 (3f.1, K29, invariant 34): own media come in through main only. The payload is the KIND and nothing else (a `path` is
  // refused by the strict schema); main opens its own dialog with per-kind filters, checks each picked file, and hands the engine the
  // path over the control channel (control.ts's `media.import`). The answer carries job ids and refused NAMES, never a path.
  defineCommand("media.pickImport", MediaPickImportPayload, MediaPickResult),
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
  // Stage 3 (3d.4, review round 1): a built-in sticker's bytes for the preview's ImageDecoder. The media scheme stays closed to
  // script reads (never corsEnabled), so main answers from the verified built-in catalogue (the catalogue's sha256, the APNG
  // re-inspected, the manifest agreeing): the window names an id, and is told the file and never a path. NOT_FOUND for an id the
  // set does not hold.
  defineCommand("stickers.bytes", StickerBytesPayload, StickerBytes),
  // Stage 3 (3f.5): an OWN sticker's bytes for the same decoder, as a command of its own so the two doors stay apart. Main resolves the media id
  // through its record (the kind must be sticker, the sha256 is checked on the exact bytes, the size is capped before it reads), answers the file and
  // never a path. NOT_FOUND for an id that is not an own sticker; INTERNAL, with fixed text, for one that fails its check.
  defineCommand("media.stickerBytes", OwnStickerBytesPayload, OwnStickerBytes),
  // «Удалить аватар» (2026-10-05): the avatar, its photos, candidates, master, drafts and finished videos (the files in «Готовые видео» and their
  // records) go to the system Trash (macOS Trash, Windows Recycle Bin), where the owner can restore them. Only main has `shell.trashItem`, so
  // this is main's: the window names an avatar and never a path. Main asks the engine what goes (the engine resolves every path itself, inside the
  // library and the export folder), moves the avatar's folder first, and tells the engine whether it went. Answers
  //   IN_FLIGHT         anything of the avatar runs or is reserved (a photo run, a candidate job, a render, a pending video, a draft being saved), or a
  //                     library switch is under way: nothing is touched;
  //   TRASH_UNAVAILABLE the Trash cannot take the avatar's folder (a network drive, a volume with no Trash): nothing is deleted, never a permanent delete;
  //   NOT_FOUND         an avatar the library does not have; LIBRARY_UNAVAILABLE no library is open.
  // On success `videoFilesKept` counts the files that were found and could not be moved: they stay as plain files in «Готовые видео».
  defineCommand("avatars.delete", z.strictObject({ avatarId: Id }), AvatarDeleteResult),
] as const;

/** Commands main forwards to the engine. */
const ENGINE_SPECS = [
  // settings
  defineCommand("settings.get", Empty, Settings),
  defineCommand("settings.setBudget", z.strictObject({ monthlyBudgetMicros: Micros }), Settings),
  defineCommand("settings.setLibraryPath", z.strictObject({ path: AbsolutePath }), Settings),
  // `imageQuality` is additive: absent keeps the current one when the model lists it (else low, else the model's first; null for a
  // model with no quality knob). The image model and quality must come from `settings.imageModels` (VALIDATION with a Russian
  // `detail` otherwise); they apply to NEW runs only.
  defineCommand("settings.setModels", z.strictObject({ imageModel: ModelId, imageQuality: ImageQuality.nullable().optional(), textModel: ModelId }), Settings),
  // The image models Settings offers: live from OpenRouter (cached), or the bundled list when it cannot be reached.
  defineCommand("settings.imageModels", Empty, ImageModelCatalogue),
  // «Реализм камеры»; applies to NEW runs.
  defineCommand("settings.setCameraRealism", z.strictObject({ cameraRealism: z.boolean() }), Settings),
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
  // Stage 5, S5.0a (additive): the owner's own edit of a saved avatar's descriptor. Free. `text` is what the owner wants stored, `expectedText` the stored text the edit
  // (or the check's proposal) was made against: a different stored text is refused as stale, so a proposal never overwrites a later hand edit. Refused with VALIDATION and a
  // `descriptorReason` when the text breaks a rule (bounded here only so a runaway paste is refused before any work), NOT_FOUND for an unknown avatar, VALIDATION for a draft,
  // IN_FLIGHT while a rewrite, a candidates batch, an archive, a delete or a check holds the avatar (a photo run or a launch does not), LIBRARY_UNAVAILABLE without a library.
  defineCommand(
    "avatars.editDescriptor",
    z.strictObject({ avatarId: Id, text: z.string().max(4_000), expectedText: z.string().max(4_000) }),
    z.strictObject({ avatar: AvatarSummary }),
  ),
  // Stage 5, S5.2a (additive): the avatar's body traits. `setBody` REPLACES the whole body with `body` (a key left out goes back to «не задано»; `{}` clears it) and clears a stored
  // import proposal in the same write. Free. VALIDATION for a body the contract refuses, a draft (its body is chosen in the wizard), a schema-version-1 record (its traits cannot hold the
  // body), and a body that would leave the description and the body phrase together over 600 characters (`descriptorReason` `too-long-with-body`); NOT_FOUND for an unknown avatar; IN_FLIGHT
  // while a rewrite, a candidates batch, an archive, a delete or a check holds the avatar (a photo run or a launch does not); LIBRARY_UNAVAILABLE without a library.
  // `dismissBodyProposal` («Не нужно») drops the stored proposal, with the same claim and the same refusals; an avatar with none answers as it is.
  defineCommand("avatars.setBody", z.strictObject({ avatarId: Id, body: AvatarBody }), z.strictObject({ avatar: AvatarSummary })),
  defineCommand("avatars.dismissBodyProposal", z.strictObject({ avatarId: Id }), z.strictObject({ avatar: AvatarSummary })),
  // Stage 5, S5.0c (additive): the descriptor-vs-master check. One vision call compares a saved avatar's master photo with its stored descriptor and answers a verdict per aspect
  // (hair, eyes, marks, body) and, for a mismatch of the first three, a proposed text. It NEVER writes: the owner applies a proposal with the free `avatars.editDescriptor`, passing
  // the check's `checkedText` as `expectedText`. `estimateCheckDescriptor` is free and also prices a DRAFT (the wizard shows «Затем — сверка описания с ним · до $X» under
  // «Сохранить»); NOT_FOUND for an unknown avatar, LIBRARY_UNAVAILABLE without a library. `checkDescriptor` is paid, accepted like `rewriteDescriptor`, and refused, before any
  // spend and in this order: AUTH_INVALID (no usable key), the ledger's own refusals, LIBRARY_UNAVAILABLE, NOT_FOUND, VALIDATION (a draft),
  // DESCRIPTOR_INVALID (a stored descriptor that fails today's rules: mend it with `editDescriptor`), PRICE_CHANGED, BUDGET_EXCEEDED, IN_FLIGHT (a job, a command or a photo run holds
  // the avatar; checked first of all). A master photo that is missing on disk or cannot be read is INTERNAL and free (an active avatar always has one in its manifest).
  defineCommand("avatars.estimateCheckDescriptor", z.strictObject({ avatarId: Id }), Estimate),
  defineCommand("avatars.checkDescriptor", z.strictObject({ avatarId: Id, ...AcceptedWorst }), z.strictObject({ check: DescriptorCheck })),
  // Stage 5, S5.3a (additive): the reference portrait of an IMPORTED avatar. An imported photo that shows a phone, a mirror or a room leaks all three into every scene, so five clean
  // head-and-shoulders portraits are drawn FROM it, ranked by the face gate against it, and the owner picks one as the avatar's master (the imported photo stays on disk).
  //  - `estimatePortraits` is free and avatar-independent (the import screen prices it before the avatar exists): 5 × (image + one reference) and, with the age check on, 5 age checks.
  //    PRICE_UNAVAILABLE when the model lists no price for an input image.
  //  - `generatePortraits` is paid, accepted like `generateCandidates`, and answers the `avatar.portraits` job that runs on (job.progress, then job.done/failed/cancelled).
  //    Refused free, with VALIDATION and `portraitReason` `not-imported` (no source photo) or `too-many-candidates` (15 unpicked portraits already), NOT_FOUND, IN_FLIGHT,
  //    MASTER_FACE_UNUSABLE (no face in the source), FACE_GATE_UNAVAILABLE, PRICE_CHANGED, BUDGET_EXCEEDED, RECONCILE_REQUIRED and the usual key and library refusals.
  //  - `portraits` is a free read: the source photo's id (null for a wizard avatar), the master's likeness when the master is a portrait, and the pending portraits the pick accepts, best first.
  //  - `pickPortrait` is free: the named photo (a pending portrait, or the source photo to go back to it) becomes the master, `avatar.changed` follows, and the other portraits go.
  //    The current master is answered as it is. VALIDATION with `portraitReason` `not-a-candidate` for any other photo, `not-imported` for a wizard avatar.
  //  - `discardPortraits` is free («Оставить как есть»): removes every pending portrait and says how many.
  defineCommand("avatars.estimatePortraits", Empty, Estimate),
  defineCommand("avatars.generatePortraits", z.strictObject({ avatarId: Id, ...AcceptedWorst }), z.strictObject({ jobId: Id })),
  defineCommand("avatars.portraits", z.strictObject({ avatarId: Id }), AvatarPortraits),
  defineCommand("avatars.pickPortrait", z.strictObject({ avatarId: Id, photoId: Id }), z.strictObject({ avatar: AvatarSummary })),
  defineCommand("avatars.discardPortraits", z.strictObject({ avatarId: Id }), z.strictObject({ avatarId: Id, removed: Count })),
  // «Удалить аватар»: what the confirmation shows (counts of photos, candidates, drafts, videos and of the video files that would go to the Trash too).
  // Free and read-only. Refuses like the delete itself does while anything of the avatar runs (IN_FLIGHT), so the dialog says so instead of offering a
  // button that cannot work; NOT_FOUND for an avatar the library does not have, LIBRARY_UNAVAILABLE without a library.
  defineCommand("avatars.deletePreview", z.strictObject({ avatarId: Id }), AvatarDeletePreview),
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
  // constraint 1: pick, then estimate, then accept). Worst case: up to two
  // vision-description attempts — an import makes no age check and asks for no
  // AI-persona confirmation (owner decision 2026-10-05, personal-use app).
  defineCommand("avatars.estimateImport", z.strictObject({ stagingId: Id }), Estimate),
  defineCommand(
    "avatars.importAvatar",
    z.strictObject({ stagingId: Id, name: AvatarName, ...AcceptedWorst }),
    // Stage 5, S5.0c (additive): the avatar is saved first; then the descriptor check of the saved avatar runs in the same command, in the import's own scope and cap, and its worst
    // case is part of the import's (`avatars.estimateImport`). `descriptorCheck` is null when the check was refused, timed out (60 s) or could not be read: the paid import is never
    // undone. Absent from an engine that does not run one.
    z.strictObject({ avatar: AvatarSummary, descriptorCheck: DescriptorCheck.nullable().optional() }),
  ),
  // photo runs (T6). A run is persisted in the library (its plan and journal),
  // so it outlives its jobs: a resume is a new job of the same run. The run's
  // worst case is its cap for its whole life, resumes included.
  // Free; NOT_FOUND unless the avatar is saved and active, DESCRIPTOR_INVALID for a descriptor to rewrite first.
  defineCommand("runs.estimate", RunRequest, z.strictObject({ estimate: Estimate })),
  // Plans and persists the run, then answers; the job runs on (job.progress, then job.done/failed/cancelled).
  defineCommand("runs.start", RunRequest.extend(AcceptedWorst), z.strictObject({ runId: Id, jobId: Id })),
  // CS.5: a run made from a reviewed scene set (`scenes.*`): no writer, only images. `runs.estimateFromScenes` is free: M photos (the set's active
  // scenes with text) priced with no writer term, at the settings' image model, quality and age-check mode. Refused, in this order and all free: NOT_FOUND
  // (no such set), SCENES_CHANGED (the revision moved), VALIDATION (an active scene has no text, none or more than 100 are active, or an active text breaks
  // today's word rules), IN_FLIGHT (a scenes job runs), VALIDATION (the set is already used), then NOT_FOUND again (its avatar cannot get photos).
  // `runs.startFromScenes` checks the same, then exactly `runs.start`'s checks,
  // then — under the set's own lock, right before the run folder is made under the set's pre-issued run id — the revision once more (an edit or a discard
  // that landed meanwhile: SCENES_CHANGED / NOT_FOUND, nothing written). The run's cap is the accepted worst case for exactly those scenes. A second start
  // of the same set is refused (the run exists); the set is read-only from the moment the run exists. Answers like `runs.start`: the job runs on.
  defineCommand("runs.estimateFromScenes", z.strictObject({ sceneSetId: Id, revision: z.number().int().min(1) }), z.strictObject({ estimate: Estimate })),
  defineCommand("runs.startFromScenes", z.strictObject({ sceneSetId: Id, revision: z.number().int().min(1), ...AcceptedWorst }), z.strictObject({ runId: Id, jobId: Id })),
  // S4.6p: what DRAWING photos costs, images alone, so the window never works a price out (the renderer computes no money). Free and read-only, priced by the very code
  // `runs.startFromScenes` and the launch's slices price a draw with, at the settings' image model, quality and age-check mode; `photos` is the count the figure is for.
  //  - `{ avatarId, count }`: `count` photos (1..100) of an avatar that can get photos. For an owner's set that cannot be approved yet (a scene without text, a write running).
  //    Refused free like `runs.estimate`: LIBRARY_UNAVAILABLE, NOT_FOUND for an avatar that is not saved and active, DESCRIPTOR_INVALID.
  //  - `{ launchId, avatarId }`: what the unfinished launch still has to draw for the avatar. Its photos are those of the avatar's set not yet in a slice (before the owner's
  //    «Продолжить запуск»: the active scenes with a text) plus the open slots of the slices that began. `photos` is those the money buys: an open slot is paid from its own slice's cap, a scene
  //    not yet in a slice from the draw allocation left for new slices, so a price that rose since the plan answers FEWER photos and the figure is that of the photos named: it never
  //    exceeds what the launch may spend. NOT_FOUND for a launch that is not the unfinished one, or an avatar it does not hold. Nothing to draw (or an avatar that is done, in montage
  //    or skipped): 0 photos and zero figures. Reading the slices judges and latches nothing.
  defineCommand(
    "runs.estimateImages",
    z.union([z.strictObject({ avatarId: Id, count: z.number().int().min(1).max(MAX_COMPOSE_SCENES) }), z.strictObject({ launchId: LaunchId, avatarId: Id })]),
    z.strictObject({ estimate: Estimate, photos: Count }),
  ),
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
  // T8b's gallery: an avatar's stored run photos, newest first, a page of
  // MAX_LISTED_PHOTOS at a time (S4.P2: `cursor` asks for the page after a
  // previous one; without it, the first page, as before). NOT_FOUND only for an avatarId the library does not
  // have at all — a draft, an active avatar and an archived one all get
  // their (possibly empty) list, like avatars.list already lists archived
  // avatars normally; see engine.ts's own comment on this handler.
  // `skippedTotal` mirrors avatars.list's own unreadableTotal: a run photo
  // whose sidecar cannot be read into the contract's shape is not silently
  // lost — its count survives even though (unlike unreadableAvatars) there
  // is no per-item list to show for it.
  defineCommand(
    "photos.list",
    z.strictObject({ avatarId: Id, cursor: PhotoCursor.optional() }),
    z.strictObject({
      photos: z.array(PhotoSummary).max(MAX_LISTED_PHOTOS),
      skippedTotal: Count,
      // S4.P2: the cursor of the next (older) page, null on the last one; and how many listable photos lie beyond this page.
      // `skippedTotal` keeps its meaning (photos that could not be read), so a photo beyond the page is never counted in it.
      nextCursor: PhotoCursor.nullable(),
      remainingTotal: Count,
    }),
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
  //   MONTAGE_INVALID   (with issues) a montage that is not complete or breaks a rule: the structural issues, then `sticker-unavailable`,
  //                     `caption-invalid`, `track-unavailable` / `track-too-short`, and, for an own file the library does not hold as the
  //                     kind the montage needs, `media-unavailable` / `video-too-short` / `track-too-short` (`not-yet-supported` is no
  //                     longer produced: every part renders);
  //   EXPORT_UNAVAILABLE (with exportReason) the export folder is unusable (invariant 35);
  //   PHOTO_UNAVAILABLE (with `photo-unavailable` issues by cell path) a scene photo that is not an eligible, unused one
  //                     of this avatar, or one another queued or running render holds; also an avatar whose usage cannot be
  //                     trusted right now (an unreadable record or a stale index): then EVERY photo is refused. `photoReason` says
  //                     which cause when the cells share one (`in-video`, `held-by-render`, `pending-video` (no render holds it, a video
  //                     that did not finish saving does: its pending intent), `index-stale`, `log-needs-repair`);
  //   RENDER_QUEUE_FULL (`detail` names the limit) too many renders are queued or running;
  //   LIBRARY_TOO_NEW   a video record was written by a newer Studio;
  //   IN_FLIGHT         the export folder is being changed (`EXPORT_CHANGING_DETAIL`), or the library was switched while the render was
  //                     being prepared: nothing was queued, and a retry a moment later goes through;
  //   INTERNAL          `RENDER_NOT_QUEUED_DETAIL`: the command ran out of its budget before the job was queued (nothing was queued);
  //   LIBRARY_UNAVAILABLE no library is open;
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
  // Stage 4 (additive): `published` says whether the owner's «Опубликовано» marks (`published.jsonl`) could be read: `unknown` when the log is torn or unreadable, and
  // then every video is shown unmarked, with a notice. Absent from a producer that has no marks (before Stage 4), read as `ok` with none.
  defineCommand(
    "videos.list",
    z.strictObject({ avatarId: Id }),
    z.strictObject({ videos: z.array(VideoSummary).max(MAX_LISTED_VIDEOS), published: PublishedMarks.optional() }),
  ),
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
  // Stage 4 (additive): `rejectPhotos: true` («Удалить видео и отклонить фото», on every video, autopilot or not) first marks every scene photo of the record rejected
  // (`rejected.jsonl`), then deletes as above, so a crash between the two leaves a video with rejected photos (harmless; delete again) and never free photos the
  // next launch could take. The export folder is checked FIRST: a refusal (EXPORT_UNAVAILABLE) changes nothing, and neither does any other refusal before the marks. The photos stay rejected
  // with the video still in place only when the delete itself failed, or timed out with its outcome unknown (delete again). The result then lists `rejectedPhotoIds`.
  defineCommand(
    "videos.delete",
    z.strictObject({ videoId: Id, mode: z.enum(["video", "record"]), rejectPhotos: z.literal(true).optional() }),
    z.strictObject({ videoId: Id, fileDeleted: z.boolean(), fileState: FileState, rejectedPhotoIds: z.array(Id).max(MAX_REJECTED_PER_VIDEO).optional() }),
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
  // (safe to repeat). `kept` counts the log's lines kept (a restore is a line too: not the photos left rejected), `dropped` the
  // lines left out. `avatar.changed` follows when the usage moved.
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
  // (no decode, no network). Both refuse nothing that costs: NOT_FOUND for a track that is not stored (an own track is the
  // media store's: one the library does not hold, or holds as something that is not a track, is NOT_FOUND too), VALIDATION for a
  // payload that breaks the contract.
  defineCommand("music.list", Empty, MusicListResult),
  defineCommand("music.peaks", MusicPeaksRequest, MusicPeaksResult),
  // A new draft for an avatar from 0 to 20 of its scene photos (0: an empty draft, «Новый монтаж»), with the focus of
  // every placed photo resolved and no name (`name: null`, the window says «без названия»). Refused, and nothing is stored, with
  //   PHOTO_UNAVAILABLE (issues `photo-unavailable` at `["photoIds", i]`) a photo that is not eligible, or is already in a video,
  //                     or is held by a render that is queued or running: one photo goes into one video; `photoReason` says which
  //                     cause when the refused photos share one (while the avatar's usage cannot be trusted EVERY photo is refused);
  //   LIBRARY_TOO_NEW   a video record of the avatar was written by a newer Studio (its photo usage cannot be judged);
  //   LIBRARY_UNAVAILABLE no library is open; IN_FLIGHT a library switch is being surveyed;
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
  // Drafts, newest `updatedAt` first, at most MAX_LISTED_MONTAGES; `total` counts every draft that was read and is readable,
  // `skippedTotal` the files that were read and could not be (they are left out, never a failed list). `notListedTotal` (additive:
  // absent when 0, never 0) counts the draft files a listing did not even read because there were more than it reads (1000): they
  // are not known to be bad, so they are never in `skippedTotal`. The reading budget is spent avatar by avatar, in the library's
  // order: within the avatar that runs it out the newest files by modification time are read, and every LATER avatar loses all its
  // files, whatever their age. No `avatarId` = every avatar. `videoCount` = the videos rendered from the draft. NOT_FOUND for an `avatarId` the library does not have.
  defineCommand(
    "montages.list",
    z.strictObject({ avatarId: Id.optional() }),
    z.strictObject({ items: z.array(MontageListItem).max(MAX_LISTED_MONTAGES), total: Count, skippedTotal: Count, notListedTotal: Count.min(1).optional() }),
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
  // active, or an own photo the library does not hold as a photo; PHOTO_UNAVAILABLE (issue at `["photo"]`) for a scene photo that
  // is not an eligible photo of this avatar.
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
  // Stage 3 (3f.1b, K28, K29): the own-media records and the import job. `media.list` is newest first (`total` says when a listing was cut);
  // `media.delete` removes the stored file and its record. A draft that names the media keeps the reference and reads it as
  // `media-unavailable`, and a rendered video is a file of its own, so neither refuses it; a QUEUED OR RUNNING render that uses the media does
  // (IN_FLIGHT: delete it when the render ends). NOT_FOUND for an unknown id.
  // `media.cancelImport` stops a running import job at whatever phase it is in (the copy, the importer, the record) and leaves
  // nothing behind; NOT_FOUND for a job that is not an import of this engine, and a job that already ended is answered as it is.
  defineCommand("media.list", MediaListPayload, MediaListResult),
  defineCommand("media.delete", MediaDeletePayload, MediaDeleteResult),
  defineCommand("media.cancelImport", MediaCancelImportPayload, MediaCancelImportResult),
  // CS.2: the owner's own scene categories, one library-wide list shared by every avatar (plan §4.1). All of them but the estimate need an
  // open library (LIBRARY_UNAVAILABLE without one); the estimate needs neither a library nor a key.
  // `categories.list`: the readable categories in creation order (at most 50, the oldest first), `unreadable` files kept as they are, `overLimit`
  // readable ones past the 50th that the list leaves out (kept on disk; every category file holds a place towards the limit), the creates and
  // regenerates a closed Studio left unanswered (`interrupted`, each with its spend and the open part of it) and the paid call in flight (`busy`).
  // `categories.estimate`: the price of one pool call, shown before «Создать» / «Пересоздать»: expected at the typical tokens of one attempt,
  // worst = both attempts at their ceilings. It is the `acceptedWorstMicros` of the two paid commands.
  // `categories.create` / `categories.regenerate`: paid and synchronous (one pool call, at most two attempts). One at a time (IN_FLIGHT);
  // VALIDATION for a name another category holds (`categoryNameKey`: trim, Unicode-normalised, case-folded) or past the 50-category limit
  // (`MAX_CUSTOM_CATEGORIES`; a window that wants to tell the two apart checks both against `categories.list` first); PRICE_CHANGED
  // above the accepted worst case; MODERATION_REFUSED (free) when the provider refuses the description; POOL_REJECTED after two unusable
  // answers. A failure carries `spentMicros` in its error, and a failed regenerate keeps the old pool. The answer's `spentMicros` is what
  // THIS call cost; the category's own `spentMicros` is its total.
  // `categories.update`: free; a new name, and places / outfits to remove by their text (refused with VALIDATION below the pool's minimums), and (CS.8a, additive)
  // `poses`: the category's angles (1..4 distinct of front / three-quarter / profile / back) or null to clear them; any list is storable, so it has no refusal of its own.
  // IN_FLIGHT for a category whose regeneration is under way or that is being deleted, and VALIDATION `name-taken` for a rename to the name a create in flight is about to
  // take (its pool is paid for and must stay storable). `categories.delete`: free; IN_FLIGHT while its regeneration runs. Photos and plans already made keep their snapshot.
  // CS.7: every write of the library's records (this, `scenes.compose/edit/write/discard`, `runs.startFromScenes`) is IN_FLIGHT while a library switch is being surveyed.
  // `categories.dismissInterrupted`: free; forgets an interrupted call's record (NOT_FOUND for one that is not listed).
  defineCommand("categories.list", Empty, CategoriesListResult),
  defineCommand("categories.estimate", Empty, Estimate),
  defineCommand(
    "categories.create",
    z.strictObject({ name: CategoryName, description: CategoryDescription, ...AcceptedWorst }),
    z.strictObject({ category: CategorySummary, spentMicros: Micros }),
  ),
  defineCommand(
    "categories.regenerate",
    z.strictObject({ categoryId: CustomCategoryId, description: CategoryDescription, ...AcceptedWorst }),
    z.strictObject({ category: CategorySummary, spentMicros: Micros }),
  ),
  defineCommand(
    "categories.update",
    z
      .strictObject({
        categoryId: CustomCategoryId,
        name: CategoryName.optional(),
        removeLocations: z.array(PoolText).min(1).max(POOL_PLACES_MAX).optional(),
        removeOutfits: z.array(PoolText).min(1).max(POOL_OUTFITS_MAX).optional(),
        /** CS.8a: sets the category's angles, or clears them (null: no preference, the run's toggles decide again). */
        poses: CategoryPoses.nullable().optional(),
      })
      .refine((p) => p.name !== undefined || p.removeLocations !== undefined || p.removeOutfits !== undefined || p.poses !== undefined, {
        message: "name a change: a new name, places to remove, outfits to remove or the angles",
        path: ["name"],
      }),
    z.strictObject({ category: CategorySummary }),
  ),
  defineCommand("categories.delete", z.strictObject({ categoryId: CustomCategoryId }), z.strictObject({ categoryId: CustomCategoryId })),
  defineCommand("categories.dismissInterrupted", z.strictObject({ jobId: Id }), z.strictObject({ jobId: Id })),
  // CS.4a: scene sets — an avatar's planned run held before any image is paid for (plan §4.2). Every one needs an open library (LIBRARY_UNAVAILABLE).
  // `scenes.estimateCompose`: free; what composing `count` scenes could cost (the writer's worst case for them: chunks of 25, two attempts each).
  // NOT_FOUND for an avatar that cannot get photos or a custom category the library does not hold, before any price is fetched.
  // `scenes.compose`: paid, a job (`job.progress` ... `job.done`). Plans the scenes, issues the set's run id and every chunk's attempt ids, and writes
  // the set BEFORE the first call; answers once the job is launched (`jobId: null` for count 0, an empty set, which costs nothing). PRICE_CHANGED above
  // the accepted worst case, BUDGET_EXCEEDED when the month has no room, VALIDATION when the avatar already has an open set (discard it first),
  // IN_FLIGHT while the avatar runs a photo run or another scenes job.
  // `scenes.get`: free; the avatar's newest set (open, or used and read-only) and how many set files could not be read (kept as they are).
  // `scenes.edit`: free, on the revision the window shows (SCENES_CHANGED when it moved; two edits on one revision: the second is refused and
  // nothing is lost). `{ problem }` is a normal result: the text does not go through and nothing changed. IN_FLIGHT while the set's job runs, VALIDATION once used.
  // `scenes.write` answers IN_FLIGHT for a set whose own job runs BEFORE anything else (before the key, the ledger or the library are looked at: its claim on the set
  // comes first); the set is live from that claim, so a write refused later (price, budget, revision) or cancelled before its job began is announced again
  // (`scenes.changed`, before `job.cancelled`), and its answer may come after `job.cancelled`.
  // CS.7: every VALIDATION of the scene commands carries `EngineError.sceneReason` (`SCENE_REASONS`, Russian text `SCENE_REASONS_RU`) and, for a refusal about one scene
  // (a text that breaks today's word rules, an active scene with no text, a scene the set lacks or has removed), its `sceneId`.
  // `scenes.estimateWrite` / `scenes.write`: «Дописать» — writes only the scenes still waiting, chunk by chunk, with the attempts each chunk has left
  // (never a fresh pair after an interruption), priced as `min(2 − answered, unused ids) × the writer's ceiling` per chunk; the same refusals as compose
  // and VALIDATION when nothing is waiting. `scenes.cancel`: ok for a set whose job is not running; the reserve of a request in flight stays open
  // until reconciled. `scenes.discard`: free; IN_FLIGHT while a job runs, VALIDATION for a used set.
  // CS.4b: `scenes.write` and `scenes.estimateWrite` also take `rewrite { sceneIds 1..5, redraw }` (a new sentence for planned scenes, with `redraw` a new place,
  // outfit, activity, time of day and pose first; for own scenes, `redraw: false`, written again from the stored idea), `idea { idea, count 1..5, shot | null }`
  // (own scenes written from the owner's idea in any script; `null` is «Авто» and never draws the mirror) and `resume { write }` (carries an interrupted
  // rewrite or idea write on). Each is ONE writer request under ids of its own, `${sceneSetId}:write-${k}#n`, recorded in the set with its draw BEFORE the call;
  // a new write is priced at two attempts, a resume at the attempts its write has left. The refusals are free and come before any price: VALIDATION for a
  // scene the set lacks or has removed, mixed kinds, an own scene redrawn, a set with no room for the scenes, or a write that is not unresolved or has no
  // attempt left; NOT_FOUND for a redraw of a scene whose custom category was deleted. A write that did not finish leaves its scenes as they were and marks
  // each (`SceneView.rewriteInterrupted`), or is listed on the set (`interruptedIdeas`), while the set stays `ready`; `scenes.edit` `dismissInterrupted`
  // lets one go, free. A write that can never be answered (two rejected answers, a provider's refusal, no attempt left) ends its job `failed` and leaves nothing.
  defineCommand("scenes.estimateCompose", ComposeRequest, z.strictObject({ estimate: Estimate })),
  defineCommand("scenes.compose", z.strictObject({ ...COMPOSE_REQUEST_FIELDS, ...AcceptedWorst }).refine(composeNeedsCategory, COMPOSE_NEEDS_CATEGORY), z.strictObject({ sceneSetId: Id, jobId: Id.nullable() })),
  defineCommand("scenes.get", z.strictObject({ avatarId: Id }), ScenesGetResult),
  defineCommand("scenes.edit", z.strictObject({ sceneSetId: Id, revision: z.number().int().min(1), op: SceneEditOp }), ScenesEditResult),
  defineCommand("scenes.estimateWrite", z.strictObject({ sceneSetId: Id, target: SceneWriteTarget }), z.strictObject({ estimate: Estimate })),
  defineCommand("scenes.write", z.strictObject({ sceneSetId: Id, revision: z.number().int().min(1), target: SceneWriteTarget, ...AcceptedWorst }), z.strictObject({ jobId: Id })),
  defineCommand("scenes.cancel", z.strictObject({ sceneSetId: Id }), z.strictObject({ sceneSetId: Id })),
  defineCommand("scenes.discard", z.strictObject({ sceneSetId: Id }), z.strictObject({ sceneSetId: Id })),
  // A fresh look at the export folder (3e.3, K9): the same check a render attempt makes, without a render. Free. The answer is the
  // status as the check found it, and `export.status` follows when it CHANGED, so a window that asks on focus shows an
  // unplugged drive, and a plugged one, without a render attempt.
  defineCommand("export.check", Empty, z.strictObject({ exportStatus: ExportStatus })),
  // ---- Stage 4 «Автопилот» (S4.1, plan §9 and §18). The engine serves every one of them since S4.6 (the orchestrator, its steps and the host), and the mock runs a launch of its own (S4.8); a payload that
  // breaks the contract is VALIDATION before either looks at it. Nothing here spends before `autopilot.start` is accepted with a worst case at least the engine's own.
  // `autopilot.estimate`: free. The plan of the draft with the engine's own estimate, the month's room and what the card shows; draws the `planSeed` when the draft has none.
  //   LIBRARY_UNAVAILABLE without a library; NOT_FOUND for an avatar that is not saved and active. What blocks a start is listed in `blockers`, not refused here.
  // `autopilot.start`: the click «Запустить: N видео · до $W» accepts the launch's worst case. PRICE_CHANGED when the engine's recomputed W′ is above `acceptedWorstMicros`
  //   (free: the screen asks again and needs a new click), BUDGET_EXCEEDED for the month's `short`, IN_FLIGHT while a launch is unfinished, VALIDATION (`launchReason`:
  //   open-set, too-many-photos, usage-unknown, launch-unreadable, nothing-enabled), AUTH_INVALID, RECONCILE_REQUIRED and the halt codes, EXPORT_UNAVAILABLE — all before
  //   anything is written or spent. The launch then spends without further clicks, up to W′ and never above, until a restart.
  // `autopilot.pause` / `autopilot.stop`: a soft stop, nothing is aborted: the requests in flight finish and nothing new starts. NOT_FOUND, VALIDATION for the wrong state.
  // `autopilot.resume`: «Продолжить · до $R». The one click that also consents to paid work after a restart, so it carries the remaining worst case it accepts; PRICE_CHANGED
  //   when the engine's R′ is above it, RECONCILE_REQUIRED / the halt codes / LEDGER_UNREADABLE while the ledger blocks paid work, AUTH_INVALID, VALIDATION when the launch
  //   is in the wrong state or the hold's cause is still there, NOT_FOUND.
  // `autopilot.continueAfterReview`: «Продолжить запуск: M фото» after the owner reviewed an avatar's scenes. SCENES_CHANGED when the revision moved; VALIDATION with
  //   `sceneReason` `over-plan` (more active scenes than planned) or `not-awaiting`. The answer says whether the draw starts now or waits for «Продолжить» (a paused launch).
  // `autopilot.list`: the launches, newest first (≤ 200), and the entries of `autopilot/` that cannot be read as a launch, by an opaque `entryId`.
  // `autopilot.get`: one launch with its log (the newest ≤ 500 lines) and its videos. NOT_FOUND. S4.6g: a finished video carries the owner's mark (`publishedAt`), `removed` when its
  // record was deleted since and `publishedUnknown` when the avatar's marks cannot be read; the result's `published` is `videos.list`'s (envelope.ts). `autopilot.list` counts only
  // the finished videos whose records stand, and tells an unreadable `io-error` entry's `scope` (folder or file).
  // `autopilot.removeUnreadable`: moves one unreadable entry to the library's quarantine, never deletes it. `entryId` is taken from `autopilot.list`; the engine finds the
  //   file itself and never takes a name or a path. NOT_FOUND for no match, and for a file that reads fine now (it is never moved).
  defineCommand("autopilot.estimate", z.strictObject({ draft: LaunchDraftInput }), AutopilotEstimateResult),
  defineCommand("autopilot.start", z.strictObject({ draft: LaunchDraft, acceptedWorstMicros: LaunchMicros }), AutopilotLaunchResult),
  defineCommand("autopilot.pause", z.strictObject({ launchId: LaunchId }), AutopilotLaunchResult),
  defineCommand("autopilot.resume", z.strictObject({ launchId: LaunchId, acceptedRemainingMicros: LaunchMicros }), AutopilotLaunchResult),
  defineCommand("autopilot.stop", z.strictObject({ launchId: LaunchId }), AutopilotLaunchResult),
  defineCommand(
    "autopilot.continueAfterReview",
    z.strictObject({ launchId: LaunchId, avatarId: Id, sceneSetId: Id, revision: z.number().int().min(1) }),
    AutopilotContinueResult,
  ),
  defineCommand("autopilot.list", Empty, AutopilotListResult),
  defineCommand("autopilot.get", z.strictObject({ launchId: LaunchId }), AutopilotGetResult),
  defineCommand("autopilot.removeUnreadable", z.strictObject({ entryId: LaunchEntryId }), Empty),
  // `videos.setPublished`: the owner's «Опубликовано» mark on a video, an append-only log beside the records (the records are write-once). Studio deletes nothing on it.
  // Answers the video as it now stands and `video.changed` follows. NOT_FOUND for an unknown video.
  defineCommand("videos.setPublished", z.strictObject({ videoId: Id, published: z.boolean() }), z.strictObject({ video: VideoSummary })),
  // `media.setForAutopilot`: «для автопилота» on an own track (an append-only log; free). NOT_FOUND for a media that is not an own track the library holds,
  // MEDIA_UNSUPPORTED (`mediaReason` `format`) for a track that is not an m4a, which the render cannot read. Answers the record as it now stands.
  defineCommand("media.setForAutopilot", z.strictObject({ mediaId: Id, on: z.boolean() }), z.strictObject({ media: MediaSummary })),
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
