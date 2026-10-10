import { z } from "zod";
import { AbsolutePath, ApiKey, Count, EngineError, EngineNotice, Id, MediaFileName, MediaPickKind, MediaUnsupportedReason, MusicKey, PickedFileIdentity, Settings, type EngineCommandMessage } from "../shared/engine";
import { DESCRIPTOR_MAX_ATTEMPTS } from "./avatars/descriptor";
import { POOL_MAX_ATTEMPTS } from "./scenes/poolCall";
import { DESCRIPTOR_CHECK_MAX_ATTEMPTS, IMPORT_DESCRIBE_MAX_ATTEMPTS } from "./avatars/plan";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { MAX_ATTEMPT_MS } from "./openrouter/transport";
import { REFERENCE_TIMEOUT_MS } from "./runs/timeouts";
import { AVATAR_DELETE_PREPARE_DEADLINE_MS, VIDEOS_DELETE_DEADLINE_MS } from "./videos/timeouts";

// Messages between main and the engine that are not part of the
// renderer-facing contract (studio/shared/engine). They never reach the
// renderer: main builds them itself and the engine accepts them only on its
// own MessagePort. The API key travels only here (invariant 10).

/**
 * The settings main owns and persists (userData/settings.json): T0 `Settings`
 * without the API key status, which main (stored, last4) and the engine
 * (rejected) derive at run time.
 */
export const EngineSettings = Settings.omit({ apiKey: true, musicKey: true });
export type EngineSettings = z.infer<typeof EngineSettings>;

/** The first message, sent through `parentPort` together with the engine's MessagePort. */
export const EngineInit = z.strictObject({
  kind: z.literal("control"),
  type: z.literal("init"),
  ledgerPath: AbsolutePath,
  /**
   * `userData/library`, the folder the default settings name. The engine
   * creates it when the settings name it and it is missing (first run); a
   * folder the user chose is never created, it may be an unmounted volume.
   */
  defaultLibraryPath: AbsolutePath,
  /**
   * The folder the default settings name for «Готовые видео» (`~/Studio/export`,
   * or `userData/export` when the home folder is unusable). The engine creates it
   * on first use when the settings name it; a folder the owner chose must already
   * exist. Absent, no export folder is ever created.
   */
  defaultExportPath: AbsolutePath.optional(),
  /** `userData/raw`: where the body of a paid answer that could not be used is kept, redacted. */
  rawDir: AbsolutePath,
  /**
   * `userData/render-tmp`: where a render job keeps its pass-1 intermediates,
   * one folder per job. Local on purpose: they are near-lossless and large. The
   * engine sweeps it when it starts. Absent, nothing is swept.
   */
  renderTmpDir: AbsolutePath.optional(),
  /**
   * `studio/assets/stickers`: the built-in sticker set (the APNGs and `catalog.json`), inside app.asar when packaged. A render reads
   * each sticker from here, checked against the catalogue, and copies it into its own job folder (3b.6). Absent, a spec with a
   * sticker layer fails its job, with a reason that names no path.
   */
  stickerDir: AbsolutePath.optional(),
  /**
   * The environment every ffmpeg child gets (S4): main's `engineEnv` allowlist.
   * The engine never reads the process environment, so it arrives here; the
   * engine filters it through the allowlist once more. Absent, a child inherits
   * its parent's environment (tests and tools only).
   */
  ffmpegEnv: z.record(z.string().max(256), z.string().max(32_768)).optional(),
  settings: EngineSettings,
  encryptionAvailable: z.boolean(),
  /** A mock OpenRouter for end-to-end tests; honoured only by an E2E build (invariant 13). */
  openRouterBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * `userData/music`: where the flashapi quota log lives (and, from 3c.4, the lists, tracks and covers). Absent, the
   * music service has no place to keep its ledger, so every refresh is refused (MUSIC_UNAVAILABLE) and none is sent.
   */
  musicDir: AbsolutePath.optional(),
  /** A mock flashapi for end-to-end tests; honoured only by an E2E build, and only a loopback base (the same rule as OpenRouter's). */
  musicBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * A mock CDN for end-to-end tests (3c.4); honoured only by an E2E build, and only a loopback plain-http base. Every
   * download URL still passes the host allowlist: only where its bytes come from changes.
   */
  musicCdnBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * What main has to tell the windows (the engine restarted, settings.json was
   * reset), oldest first. The engine keeps them pending in its snapshot and
   * emits each as an `engine.notice` in its own seq/bootId stream, so a window
   * never sees an event from a foreign bootId and one opened later still
   * shows them. Every (re)start gets the whole list again.
   */
  notices: z.array(EngineNotice),
});
export type EngineInit = z.infer<typeof EngineInit>;

/** Sent by main over the MessagePort after init, in order with the commands. */
export const HostControl = z.discriminatedUnion("type", [
  /** A key the user stored (or main decrypted on engine start); replaces any previous one. */
  z.strictObject({ kind: z.literal("control"), type: z.literal("apiKey.set"), key: ApiKey }),
  z.strictObject({ kind: z.literal("control"), type: z.literal("apiKey.clear") }),
  /**
   * The RapidAPI (music) key: the same hand-over as the OpenRouter key's (main decrypts it on every (re)start and on
   * a set), kept in the engine's memory for the flashapi client. Independent of `apiKey.*`.
   */
  /**
   * `origin` says who stored the key: `"user"` (the owner set it just now; an earlier 401 no longer applies, and the
   * quota log is told) or `"start"` (main decrypted the stored key for a (re)started engine; whether it is still
   * rejected is read back from the quota log). Absent counts as `"user"`.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("musicKey.set"), key: MusicKey, origin: z.enum(["user", "start"]).optional() }),
  z.strictObject({ kind: z.literal("control"), type: z.literal("musicKey.clear") }),
  /**
   * Settings main has just persisted (and re-sent with init after a restart).
   * They are the truth: a library folder is taken only once it appears here.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("settings.update"), settings: EngineSettings }),
  /**
   * 3f.1: main gives up on the `media.import` it sent as `callId` (its own deadline passed, or the window that asked closed): the engine
   * stops opening that file and releases the library. There is no reply; the import's own reply (reason `cancelled`) is the answer. An
   * abort for a call that is not running changes nothing. It does NOT stop an import JOB that has already started: that is
   * `media.cancelImport`, and a job outlives the window that asked for it.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("media.abortImport"), callId: Id }),
  /**
   * Stage 4 (plan §9, S4.7): the Mac is going to sleep (`suspend`) or has woken (`resume`). Main sends it from `powerMonitor`; while suspended an autopilot launch sends no new
   * attempt. There is no reply. It is a control message and not a command of the renderer's contract on purpose: no window can tell the engine the Mac is asleep.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("host.power"), state: z.enum(["suspend", "resume"]) }),
]);
export type HostControl = z.infer<typeof HostControl>;

/**
 * T6c (L3): the same 20 MB cap `importFlow.ts` already refuses a picked file
 * over, enforced again at the contract boundary — `bytes` below is never
 * trusted to already be under it just because main is the only sender.
 * Exported so main's own flow bounds its read by this exact number, rather
 * than keeping a second constant that could drift from this one.
 */
export const MAX_IMPORT_PHOTO_BYTES = 20 * 1024 * 1024;

/**
 * How long main waits for `media.import`. Since 3f.1b the call answers once the file is OPENED and its job started (the copy runs inside
 * the job), so it is short in practice; the long bound stays as a backstop for a hung open (a stale network drive), and the engine's own
 * deadline below ends it sooner, with a TIMEOUT main can read.
 */
export const MEDIA_IMPORT_DEADLINE_MS = 10 * 60_000;

/** The engine gives up on an open a little BEFORE main does, so its own answer (a TIMEOUT) is the one main reads, and the open and its hold on the library end with it. */
export const MEDIA_IMPORT_ENGINE_DEADLINE_MS = MEDIA_IMPORT_DEADLINE_MS - 15_000;

/** The most video files one avatar delete hands main to move: the record files one read takes (`MAX_RECORD_FILES_READ`). The rest stay as plain files (`unlisted`). */
export const MAX_DELETE_VIDEO_FILES = 2000;

/**
 * What the engine resolved for «Удалить аватар» and hands to MAIN only (never to the renderer): the avatar's folder inside the library and each of its
 * video files that is in the export folder now. Main checks every path again against its own roots before it trashes anything. `unlisted` counts the video
 * files the engine did not list (more records than one delete moves): they stay where they are.
 */
export const AvatarDeletePlan = z.strictObject({
  avatarId: Id,
  libraryRoot: AbsolutePath,
  folder: AbsolutePath,
  exportRoot: AbsolutePath.nullable(),
  files: z.array(AbsolutePath).max(MAX_DELETE_VIDEO_FILES),
  unlisted: Count,
});
export type AvatarDeletePlan = z.infer<typeof AvatarDeletePlan>;

/** A question main asks the engine; the engine answers with an `EngineReply` carrying the same `callId`. */
export const HostCall = z.discriminatedUnion("type", [
  /**
   * Opens (creating on first use) the library at a folder the user picked in
   * main's dialog, and stages it. Only the engine touches the library; the
   * engine switches to the staged folder only on a `library.confirm` that
   * names it. A folder main gave up on (its deadline passed, so it never
   * sent a confirm) is therefore never taken.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("library.open"), callId: Id, path: AbsolutePath }),
  /**
   * Commits the switch to a folder staged by `library.open` for this exact
   * path string: a folder never staged (or staged under another spelling of
   * the same string) is refused with VALIDATION rather than surveyed fresh —
   * opening it here, after the busy check below, would reopen the very
   * TOCTOU window this call exists to close (a paid command could start
   * during that survey and write into the old library while this call
   * answers ok). Main must send `library.open` again first.
   *
   * Already the live (and saved) folder is a harmless no-op, checked by the
   * same path string, without staging or a survey. Otherwise, refused with
   * IN_FLIGHT, the live library unchanged, while any avatar job or paid
   * command writes into it, or a pick or archive is in flight; main then
   * must not persist the new path. Once staged and not busy, the switch
   * itself has no await in it: main persists the path and pushes the rest of
   * the settings (`settings.update`) only after an ok reply.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("library.confirm"), callId: Id, path: AbsolutePath }),
  /**
   * T6c (import an existing avatar): main's own dialog read the picked
   * photo's raw bytes itself (design constraint 1 — the renderer never sends
   * a path or raw bytes); this hands them to the engine, which validates them
   * (media checks, not animated, a readable size), downscales the two JPEGs
   * the paid calls need and holds them staged, replacing any earlier staged
   * photo. `bytes` never reaches the renderer-facing contract (commands.ts) —
   * only this main-only control message ever carries raw image bytes.
   */
  z.strictObject({
    kind: z.literal("control"),
    type: z.literal("import.stagePhoto"),
    callId: Id,
    bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength <= MAX_IMPORT_PHOTO_BYTES, `must be at most ${MAX_IMPORT_PHOTO_BYTES} bytes`),
  }),
  /**
   * The app is quitting (main's `will-quit`), and its engine process is about to be killed. The engine stops accepting
   * renders, cancels every queued and running one (an orphaned ffmpeg would keep writing into the export folder with
   * no timeout), and waits a bounded while so a commit already past its claim can finish, then replies. Main bounds its
   * own wait on the reply and kills the process either way; whatever is left, the next start's recovery settles.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("engine.shutdown"), callId: Id }),
  /**
   * 3e.3 (K18): the owner picked `path` in main's own dialog as the export folder «Готовые видео». The engine checks it as
   * the export check does (it must not overlap the library, must be a folder that takes a write, and must carry a valid
   * root marker, which is written when it has none) and counts the video records that resolve in it. It adopts NOTHING:
   * main persists the path and sends `settings.update` only after an ok reply. A folder is never created here (the
   * dialog makes folders); refused with EXPORT_UNAVAILABLE (`exportReason`), or IN_FLIGHT while a render is queued or
   * running (a render commits into the folder it was planned for, and its record must not be left behind by a switch).
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("export.choose"), callId: Id, path: AbsolutePath }),
  /**
   * 3f.1 (invariant 34, K29): the owner picked `path` in main's own dialog as an own file to import. The window never names it. Main has
   * already looked at the file (a plain file, not a link; within the kind's cap) and sends the identity it saw (`expected`: device, inode, size and
   * times as exact unsigned decimal strings), so the engine can tell a file that was replaced since. The engine opens the path ONCE, with no
   * symlink following, judges the file from its OPEN handle and its first bytes (identity, size, the kind, the kind's cap, an importer for
   * the kind), and STARTS AN IMPORT JOB (3f.1b); the reply is its `mediaJobId`. The job copies at most the kind's cap into the engine's own
   * staging area, hands that copy, never the path, to the kind's importer, and stores the file and its record, with progress events and
   * a cancel (`media.cancelImport`). The reply is `error` (VALIDATION) with `mediaReason` for a file the boundary turned away (an importer's
   * refusal comes later, as the job's `MEDIA_UNSUPPORTED`), or an error of its own (IN_FLIGHT, LIBRARY_UNAVAILABLE, INTERNAL).
   * `name` is the file's base name, for display only.
   */
  z.strictObject({
    kind: z.literal("control"),
    type: z.literal("media.import"),
    callId: Id,
    pick: MediaPickKind,
    path: AbsolutePath,
    name: MediaFileName,
    expected: PickedFileIdentity,
  }),
  /**
   * «Удалить аватар», step 1: main asks what goes with `avatarId`. The engine refuses (IN_FLIGHT) while anything of the avatar runs or is reserved (a photo run,
   * a candidate job, a render, a focus request, a pending video, a draft being saved) or a library switch is under way, and NOT_FOUND for an unknown avatar.
   * Otherwise it claims the avatar (nothing else may start for it), takes it out of its indexes (memory only: the disk is untouched), and replies with the
   * `deletePlan`: the paths main may move to the system Trash. The avatar stays claimed until `avatar.deleteFinish`.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("avatar.deletePrepare"), callId: Id, avatarId: Id, token: Id }),
  /**
   * «Удалить аватар», step 2: what became of the avatar's FOLDER. `trashed`: it is in the Trash, so the engine forgets the avatar for good, announces
   * `avatar.removed` and lets go of the claim. `kept`: it is still there (the Trash refused, a path failed main's check), so the engine puts the avatar
   * back in its indexes as it was and lets go of the claim. Always sent, whatever happened, so a claim never outlives the delete. A `deleteFinish` the engine
   * has no matching `deletePrepare` for (it restarted meanwhile) is answered NOT_FOUND and changes nothing.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("avatar.deleteFinish"), callId: Id, avatarId: Id, token: Id, outcome: z.enum(["trashed", "kept"]) }),
  /**
   * Main finished moving an avatar's folder to the Trash but the engine did not know the delete any more (it restarted between prepare and finish, so it
   * lists an avatar whose folder is gone): the engine looks at the disk, forgets every avatar whose own manifest file is no longer there (announcing each with
   * `avatar.removed`) and leaves the rest, and any avatar a delete or a job is under way for. Free, no reply but ok.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("avatars.pruneMissing"), callId: Id }),
]);
export type HostCall = z.infer<typeof HostCall>;

/**
 * The engine's answer to a `HostCall`: no `error` means it succeeded.
 * `stage` is set only for `import.stagePhoto`'s own successful reply — the
 * one HostCall whose caller (main) needs more than a bare ok, so the
 * renderer's `avatars.pickImportPhoto` result (commands.ts's
 * `ImportPhotoPicked`) can carry the staged photo's id and pixel size.
 */
export const EngineReply = z.strictObject({
  kind: z.literal("control"),
  type: z.literal("reply"),
  callId: Id,
  error: EngineError.optional(),
  stage: z.strictObject({ stagingId: Id, width: Count, height: Count }).optional(),
  /** Set only by a successful `export.choose`: the folder's identity, and how many records resolve in it or stay elsewhere. */
  exportFolder: z.strictObject({ rootId: Id, resolved: Count, elsewhere: Count, incomplete: z.boolean() }).optional(),
  /** Set only by a successful `media.import`: the job the file's importer started. */
  mediaJobId: Id.optional(),
  /** Set with `error` when `media.import` turned the file away: why. */
  mediaReason: MediaUnsupportedReason.optional(),
  /** Set only by a successful `avatar.deletePrepare`: what main may move to the Trash. */
  deletePlan: AvatarDeletePlan.optional(),
});
export type EngineReply = z.infer<typeof EngineReply>;

/** True for anything that claims to be a control message; commands and responses never do. */
export function isControlMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && "kind" in message && message.kind === "control";
}

/** Room for the engine's own work around its network waits: ledger fsyncs, the library write, a reserve queued behind a reconcile. */
const COMMAND_SLACK_MS = 30_000;

/**
 * How long main waits for the answer to a command before it answers INTERNAL
 * itself; a command not listed gets main's default (30 s). A paid command
 * must not be given up on while the engine may still be working on it: the
 * user would click again and pay twice. So createDraft waits for a price load
 * (every GET at once, one timeout) and every descriptor attempt at its
 * slowest. The estimates wait for a price load that times out, so the
 * fallback estimate still arrives.
 */
export const COMMAND_DEADLINE_MS: Partial<Record<EngineCommandMessage["type"], number>> = {
  "avatars.estimate": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.estimateCandidates": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.estimateRewriteDescriptor": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.estimateImport": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // T6c: up to IMPORT_DESCRIBE_MAX_ATTEMPTS describe attempts, each at its slowest (no age check since 2026-10-05); S5.0c: then up to DESCRIPTOR_CHECK_MAX_ATTEMPTS check attempts of the
  // saved avatar, each bounded by the shorter check timeout (MAX_ATTEMPT_MS is a safe upper bound for it).
  "avatars.importAvatar": PRICE_FETCH_TIMEOUT_MS + (IMPORT_DESCRIBE_MAX_ATTEMPTS + DESCRIPTOR_CHECK_MAX_ATTEMPTS) * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  // Stage 5, S5.0c: the check's price (a price load that times out still gives the fallback estimate), and the paid check itself: a price load, a load of the master, then every check attempt.
  "avatars.estimateCheckDescriptor": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.checkDescriptor": PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_CHECK_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  // Answers with the job id once its checks and a price load are done; the job runs on and reports by events.
  "avatars.generateCandidates": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.createDraft": PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  // The image-model catalogue: the list GET, then every candidate's endpoints GET at once, each with its own timeout. Without an entry
  // it fell back to the default 30 s, which is exactly two timeouts.
  "settings.imageModels": 2 * PRICE_FETCH_TIMEOUT_MS + 15_000,
  // CS.2: the pool call is the descriptor's mould: a price load, then every pool attempt at its slowest. The estimate waits for a price load that times out.
  "categories.estimate": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "categories.create": PRICE_FETCH_TIMEOUT_MS + POOL_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  "categories.regenerate": PRICE_FETCH_TIMEOUT_MS + POOL_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  // Sized like createDraft's descriptor part: the same job, the same attempt ceiling.
  "avatars.rewriteDescriptor": PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
  // T6: each answers once its checks, a price load and its plan or journal reads are done; a run's job runs on
  // and reports by events.
  "runs.estimate": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "runs.estimateResume": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // Also waits for the master's own look before a run exists (`preflightMaster`): a bounded load of the master,
  // then a bounded prepare of the gates on it, one REFERENCE_TIMEOUT_MS each. Bounding the preflight inside the
  // slack instead would refuse a slow but healthy master; the deadline is sized to the awaited path, as createDraft's is.
  "runs.start": PRICE_FETCH_TIMEOUT_MS + 2 * REFERENCE_TIMEOUT_MS + COMMAND_SLACK_MS,
  "runs.resume": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // CS.5: a run from a scene set is priced and started like any run (the start also waits for the master's preflight).
  "runs.estimateFromScenes": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // S4.6p: the images alone for N photos, or for what a launch still has to draw: the same price load.
  "runs.estimateImages": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "runs.startFromScenes": PRICE_FETCH_TIMEOUT_MS + 2 * REFERENCE_TIMEOUT_MS + COMMAND_SLACK_MS,
  "runs.list": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // CS.4a: a set's compose and «Дописать» answer once their checks and a price load are done (the writer's job runs on and reports by events); the
  // estimates wait for a price load that times out, so the fallback estimate is not lost. The other scenes commands are local and keep the default.
  "scenes.estimateCompose": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "scenes.estimateWrite": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "scenes.compose": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "scenes.write": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // The export check and then the bounded delete (a full hash on a slow drive): main must outwait both, or the engine's own timeout text
  // («look at the video list before trying again») never reaches the window.
  "videos.delete": VIDEOS_DELETE_DEADLINE_MS,
  // The confirmation's counts: the same bounded look at the export folder and the avatar's record files as the delete's first step.
  "avatars.deletePreview": AVATAR_DELETE_PREPARE_DEADLINE_MS,
  // Stage 4: the estimate, the start and the resume of a launch each wait for a price load (which times out into the fallback list) after their checks; the launch itself
  // runs on and reports by `autopilot.changed`. The other autopilot commands only read or move the launch's own files and keep the default.
  "autopilot.estimate": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "autopilot.start": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "autopilot.resume": PRICE_FETCH_TIMEOUT_MS + 15_000,
};
