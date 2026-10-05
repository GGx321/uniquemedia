import { join } from "node:path";
import type { z } from "zod";
import type { RenderResult } from "../../shared/engine";
import type { MontageShape } from "../../shared/engine/montage";
import { MAX_MONTAGE_ISSUES } from "../../shared/engine/montage";
import { ownVideoClips, ownVideoIssues, totalFrames } from "../../shared/montage";
import { ExportFolderError, formatExportDate, NODE_EXPORT_FOLDER_FS, prepareExportFolder, type ExportFolderFs, type PreparedFolder } from "../exportName";
import type { Library } from "../library";
import type { PhotoResolver } from "../render";
import { inspectStreams } from "../music/decodeCheck";
import { TrackUnavailableError, type RenderTrack, type RenderTrackSource } from "../music/renderTrack";
import { stagingTimeoutMs } from "../renderQueue/progress";
import { RenderFailure, type RenderContext } from "../renderQueue/queue";
import { stagingBound, type StagingBound } from "../renderQueue/stagingBound";
import { runRenderJob, type RenderRunDeps, type RunAudio } from "../renderQueue/runner";
import type { VerifiedFile, VerifyExpected } from "../verify";
import type { NumberFs } from "./exportNumbers";
import { assertFolderContained, commitVideo, ContainmentError, type CommitStep, type CommittedVideo } from "./commit";
import { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
import type { OpenRegularOps } from "../library/openRegular";
import { collectForbiddenStrings, combineForbiddenStrings } from "./forbiddenStrings";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { copyOwnPhotos, type OwnPhotoSource } from "./ownPhotos";
import type { StreamCopyIo } from "./ownMedia";
import { openOwnTrack, OwnTrackUnavailableError, type OwnTrackSource } from "./ownTrack";
import { copyOwnVideos, ownVideoCopyName, OwnVideoUnavailableError, type OwnVideoSource } from "./ownVideos";
import type { OwnStickerSource } from "./ownStickers";
import { resolveLayers, type LayerDeps } from "./layers";
import { CommitTracker } from "./live";
import { partNameOf, scenePhotoIds, type VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";
import { readRootId } from "./rootMarker";
import { createTempExclusive } from "./tempFile";

// The `execute` a render job hands to `RenderQueue` (Stage 3 plan, 3a.8b): the
// runner, then the commit. Each job prepares its own avatar folder in the export
// root, writes its temp as `<folder>/.studio-part-<jobId>.mp4`, renders into it, and
// commits it (commit.ts). The used index is updated inside the same function,
// before it returns, so the queue's photo reservation is never released before
// the record counts (invariant 24): `RenderQueueDeps.beforeRelease` is not needed.
//
// CANCEL: `context.signal` stops ffmpeg (the job ends `cancelled`, the runner has
// removed its temp) and stops the commit until the name is claimed; from the claim
// on the commit finishes and the job ends `done` (commit.ts, "done wins").
//
// THE EXPORT FOLDER IS LOOKED AT AGAIN (invariant 35). `videos.render` checked it minutes before pass 2 writes
// the temp by path, so this function re-reads the root's marker (the id of the root that was checked must still
// be the id at that path: a volume swapped in at the same path passes every containment check) at three points,
// and checks the avatar folder's containment right before pass 2:
//   1. when the job starts, before `prepareExportFolder` makes anything;
//   2. right before pass 2 (with containment), where the job also CREATES its temp itself, exclusively and
//      without following a link, so ffmpeg only ever truncates a file this job made a moment ago;
//   3. inside the commit's root lock, right before the name is claimed (`CommitDeps.beforeClaim`).
//
// THE COMMIT HAS A DEADLINE (`commitDeadlineMs`). A hung fsync on a dropped network drive would otherwise hold a
// queue slot for ever (20 stuck jobs, then RENDER_QUEUE_FULL until a restart). At the deadline the job FAILS
// (EXPORT_UNAVAILABLE, not-writable) and the queue moves on. What was stuck before the claim is told to stop and
// rolls back when it wakes; what was stuck after the claim cannot be undone, so it finishes LATE: the record lands,
// the used index takes it and `onCommitted` announces it, although the job already reported `failed`. Until the
// commit has really ended, the tracker keeps its job, temp and placeholder live, so recovery never takes a commit
// that is still running for a crash's leftover.

/** The frame count of a timeline: what the queue submission's `totalFrames` and the verifier's expectation both come from, so they cannot disagree. */
export function totalFramesOf(clips: readonly { readonly durationMs: number }[]): number {
  return totalFrames(clips);
}

/** How long verify, the intent and the last look at the root may take BEFORE the point of no return (the name's claim). Generous: it reads up to 64 MiB and flushes to a possibly slow drive. After the claim there is no deadline (see the header). */
export const COMMIT_DEADLINE_MS = 120_000;

/** How long each group of export-volume calls before pass 2 (the job's start; the look right before pass 2) may take. A dropped network drive answers in neither. */
export const EXPORT_STEP_DEADLINE_MS = 30_000;

/** Everything one render needs, resolved by `videos.render` (3b.2) in its one synchronous step. */
export interface RenderPlan {
  readonly jobId: string;
  readonly videoId: string;
  readonly avatarId: string;
  /** From `safeName(avatar.name, avatar.id)`. */
  readonly safeName: string;
  /** From the up-front export check (`check.root`, `check.rootId`). */
  readonly exportRoot: { readonly root: string; readonly rootId: string };
  /** The RESOLVED spec (focus filled): what the record keeps, and what is rendered. */
  readonly spec: z.infer<typeof MontageShape>;
  /** photoId to its file and STORED size; resolved up front so a missing photo answers PHOTO_UNAVAILABLE, never a builder error. */
  readonly resolvePhoto: PhotoResolver;
  /**
   * The own photos the spec names (3f.2), each as the admission found it: the library file, its size and sha256. The job copies each, checked,
   * into its own folder; `resolvePhoto` points at the copy (`ownPhotoCopyName`), never at the library file. Absent: none.
   */
  readonly ownPhotos?: readonly OwnPhotoSource[];
  /** The stored sizes of the scene photos the spec names, summed: their read (the forbidden strings) spends the same staging budget as the copies. Absent: 0. */
  readonly scenePhotoBytes?: number;
  /**
   * The own stickers the spec names (3f.5), each as the admission found it: the library file, its canvas, loop and sha256. The job verifies
   * each when it resolves the layers and writes the verified bytes into its own folder (`layers.ts`); ffmpeg never reads the library file. Absent: none.
   */
  readonly ownStickers?: readonly OwnStickerSource[];
  /**
   * The own videos the spec's video clips name (3f.3b), each as the admission found it: the library file, its stored size, length and sha256. The job STREAMS each into its
   * own folder, verified as it goes (`ownVideos.ts`), and `resolveVideo` points at the copy (`ownVideoCopyName`), never at the library file. A spec with a video clip and a
   * plan with no source for it is refused (`media-unavailable`), never rendered as something else. Absent: none.
   */
  readonly ownVideos?: readonly OwnVideoSource[];
  /** Silence, by type (invariant 31): a plan cannot name a track file. A track comes only through `track`, opened from the store when the job starts. */
  readonly audio: { readonly kind: "silent" };
  /**
   * The trending track the montage uses, by id (3c.5, invariant 31). Only the id and where to start: the file's path is never in
   * the plan. The job asks the track store for it when it starts, and the store checks it again before handing it over.
   */
  readonly track?: { readonly trackId: string; readonly startMs: number };
  /**
   * The own track the montage uses (3f.4), as the admission found it: the stored file, its size and sha256, its decoded length and name. Never a
   * path ffmpeg reads: the job reads the file's VERIFIED BYTES when it starts and the runner writes them to the job's own `track.m4a`. A spec whose
   * `music` is an own track and a plan with none here is refused (`media-unavailable`), never rendered without its music.
   */
  readonly ownTrack?: { readonly source: OwnTrackSource; readonly startMs: number };
  readonly montageId: string | null;
  /** The draft's name when the render was asked for (K12); the record keeps it. Null for an unnamed draft or a headless spec. */
  readonly title: string | null;
  /** The kind token of the file name. */
  readonly videoKind: string;
  /** The tile's music (title, artist); for a plan with a `track` the job fills it from the track it opened. */
  readonly music: VideoRecord["music"];
}

export interface VideoRenderDeps {
  readonly library: Pick<Library, "root" | "readPhotoVerified" | "listAvatars" | "namedVideoFiles" | "usageReasons"> & IndexPort;
  readonly tracker: CommitTracker;
  /** `userData/render-tmp`. Required: there is no `os.tmpdir` fallback. */
  readonly renderTmpDir: string;
  /**
   * What the spec's text and sticker layers need (3b.6): the text rasteriser and the verified sticker set. Absent, a spec that has
   * layers fails INTERNAL before anything is made (an engine built without them must not drop layers silently).
   */
  readonly layers?: LayerDeps;
  readonly caseProbe: { isCaseInsensitive(root: string): Promise<boolean> };
  readonly now: () => Date;
  readonly fs?: CommitFs;
  readonly folderFs?: ExportFolderFs;
  /** `runRenderJob` unless a test plays the runner. */
  readonly runJob?: typeof runRenderJob;
  readonly runDeps?: RenderRunDeps;
  readonly verify?: (path: string, expected: VerifyExpected) => Promise<VerifiedFile>;
  /**
   * The track store, as the render uses it (3c.5): a plan's `track` is opened through it when the job starts. Absent, no track
   * is held, and a plan with a track is refused as `track-unavailable`.
   */
  readonly tracks?: Pick<RenderTrackSource, "openForRender">;
  /** The kinds of stream ffmpeg sees in a file, for the check of an own track's private copy (3f.4); `inspectStreams` by default (a test passes a stand-in). */
  readonly inspectStreams?: (path: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** How the own photos' library files are opened for their copies (a test plays a dead disk); the real ones by default. */
  readonly ownPhotoOps?: OpenRegularOps;
  /** The disk calls of the own videos' streamed copy (how the library file is opened, how the copy is created, the free-space question, the chunk size); the real ones unless a test plays a disk. */
  readonly ownVideoIo?: StreamCopyIo;
  /** Codes, ids and box paths only. */
  readonly log?: (line: string) => void;
  /** Test seams of the commit. */
  readonly hooks?: { reached?: (step: CommitStep) => void | Promise<void> };
  readonly claimStartAt?: number;
  /**
   * Called with the record once it is committed AND the used index has it, still inside the job (so before `job.done`),
   * or late for a commit that outlived its deadline. A throw is logged and changes nothing: the record is the truth.
   */
  readonly onCommitted?: (record: VideoRecord) => void;
  /**
   * Whether the draft this render started from was deleted since (asked when the record is written, so a delete during the
   * render is seen): the record then lists `montageId: null`. Absent: never.
   */
  readonly draftRemoved?: (montageId: string) => boolean;
  /** `COMMIT_DEADLINE_MS` unless a test says otherwise. */
  readonly commitDeadlineMs?: number;
  /** The timer behind `commitDeadlineMs`; the real one unless a test moves time itself (a short real deadline races the disk it is testing). */
  readonly deadlineTimers?: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  /** `EXPORT_STEP_DEADLINE_MS` unless a test says otherwise. */
  readonly stepDeadlineMs?: number;
  /**
   * Settles the commit intent a FAILED commit may have left, before the job ends (targeted recovery under the root lock):
   * the adopted record, or null when it was dropped, deferred or nothing was left. The signal says to stop (the step deadline).
   */
  readonly settleLeftover?: (input: SettleInput, signal: AbortSignal) => Promise<VideoRecord | null>;
  /** The disk calls of the commit's number scan; the real ones unless a test plays a library disk that does not answer. */
  readonly numberFs?: NumberFs;
  /** Creates the empty temp exclusively (no link followed); the real one unless a test plays a volume. */
  readonly createTemp?: (path: string) => Promise<void>;
}

export { CommitTracker } from "./live";

/** What a settle needs: the video, its own job (which it must not see as live), and the export root the commit used. */
export interface SettleInput {
  readonly avatarId: string;
  readonly videoId: string;
  readonly jobId: string;
  readonly exportRoot: ExportRootRef;
  /** The scene photos of the video's spec: held while the intent is pending, whatever the settle makes of it. */
  readonly photoIds: readonly string[];
}

/** The settle, cut at `ms`: a settle that does not answer is told to stop and counts as nothing settled (the job fails; the next open settles it). Never throws. */
async function settleBounded(settle: NonNullable<VideoRenderDeps["settleLeftover"]>, input: SettleInput, ms: number, log: (line: string) => void): Promise<VideoRecord | null> {
  const stop = new AbortController();
  try {
    return await guarded(new AbortController().signal, ms, () => settle(input, stop.signal));
  } catch (error) {
    stop.abort();
    log(`render ${input.jobId}: the leftover intent could not be settled (${codeOf(error)})`);
    return null;
  }
}

/**
 * Runs `work` under two ways out: `ms` passing (EXPORT_UNAVAILABLE not-writable: the volume does not answer) and the
 * job's own cancel (the signal's reason, so the job ends `cancelled`). A disk call that hangs on a dropped network drive
 * cannot be interrupted, but it no longer holds the job or its queue slot; if it wakes up later it finds the job over
 * (whatever it then creates is a leftover the next open's recovery sweeps).
 */
async function guarded<T>(signal: AbortSignal, ms: number, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const out = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "the export folder did not answer in time" })), ms);
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  out.catch(() => undefined);
  try {
    return await Promise.race([work(), out]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/** The root's marker no longer holds the id that was checked: the folder is gone, was swapped, or cannot be read. */
async function assertSameRoot(root: string, rootId: string): Promise<void> {
  const marker = await readRootId(root);
  if (marker.rootId === rootId) return;
  if (marker.rootId === null && marker.code !== "ENOENT" && marker.code !== "ENOTDIR" && marker.code !== "invalid") {
    throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: `the export folder's marker could not be read (${marker.code})` });
  }
  throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "the export folder is not the one that was checked" });
}

/** The real timer of one commit's deadline: the handle is the timer itself, kept here so nothing has to be cast. */
function realDeadlineTimer(): NonNullable<VideoRenderDeps["deadlineTimers"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    set: (fn, ms) => (timer = setTimeout(fn, ms)),
    clear: () => clearTimeout(timer),
  };
}

export function createRenderExecute(deps: VideoRenderDeps): (plan: RenderPlan) => (context: RenderContext) => Promise<RenderResult> {
  if (deps.renderTmpDir === "") throw new TypeError("createRenderExecute: renderTmpDir is required (no os.tmpdir fallback).");
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  const runJob = deps.runJob ?? runRenderJob;
  const createTemp = deps.createTemp ?? createTempExclusive;
  const deadlineMs = deps.commitDeadlineMs ?? COMMIT_DEADLINE_MS;
  const stepMs = deps.stepDeadlineMs ?? EXPORT_STEP_DEADLINE_MS;

  /**
   * A plan's track, opened through the store FIRST (before the export folder, the intermediates or any ffmpeg exist): the store
   * checks the stored file again, and anything but a pass is the contract's refusal for it, `MONTAGE_INVALID` with
   * `track-unavailable` (or `track-too-short` when it cannot hold `startMs` plus the montage). A cancel comes out as itself.
   */
  const openTrack = async (plan: RenderPlan, signal: AbortSignal): Promise<{ track: RenderTrack; startMs: number } | null> => {
    const refuse = (code: "track-unavailable" | "track-too-short" | "media-unavailable"): RenderFailure => new RenderFailure({ code: "MONTAGE_INVALID", issues: [{ code, path: ["music"] }] });
    const montageMs = plan.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
    // 3f.4: an own track is read by its VERIFIED BYTES (`openOwnTrack`), the same moment and with the same refusals as a trending one. A spec that names
    // an own track and a plan that brought no source for it is never rendered without its music (N9's rule): it is refused.
    if (plan.spec.music?.source === "own" || plan.ownTrack !== undefined) {
      const own = plan.ownTrack;
      if (own === undefined) throw refuse("media-unavailable");
      let opened: RenderTrack;
      try {
        opened = await openOwnTrack(own.source, signal, deps.inspectStreams ?? ((path, checkSignal) => inspectStreams({ path, signal: checkSignal })));
      } catch (error) {
        if (error instanceof OwnTrackUnavailableError) {
          log(`render ${plan.jobId}: the own track was refused (changed or gone)`);
          throw refuse("media-unavailable");
        }
        if (signal.aborted) throw error;
        log(`render ${plan.jobId}: the own track could not be checked (${codeOf(error)})`);
        throw new RenderFailure({ code: "INTERNAL", detail: "the music track could not be checked" });
      }
      if (opened.decodedMs < own.startMs + montageMs) throw refuse("track-too-short");
      return { track: opened, startMs: own.startMs };
    }
    const wanted = plan.track;
    if (wanted === undefined) return null;
    if (deps.tracks === undefined) throw refuse("track-unavailable");
    let opened: RenderTrack;
    try {
      opened = await deps.tracks.openForRender(wanted.trackId, signal);
    } catch (error) {
      if (error instanceof TrackUnavailableError) {
        log(`render ${plan.jobId}: the music track was refused (${error.kind})`);
        throw refuse("track-unavailable");
      }
      // A cancel is the signal's own reason. Anything else (a file-system error) names the owner's userData path: only the code goes on.
      if (signal.aborted) throw error;
      log(`render ${plan.jobId}: the music track could not be checked (${codeOf(error)})`);
      throw new RenderFailure({ code: "INTERNAL", detail: "the music track could not be checked" });
    }
    // The length the store PROVED, against what this montage needs of it: the same rule `videos.render` applied up front.
    if (opened.decodedMs < wanted.startMs + montageMs) throw refuse("track-too-short");
    return { track: opened, startMs: wanted.startMs };
  };

  /**
   * The own videos of a plan, judged FIRST (before the layers, the export folder or any copy): a spec with a video clip needs a source for each, long enough for its
   * `trimStartMs` plus its length. A plan that brought none is never rendered as something else: `media-unavailable` at the clip (N9's rule); a mezzanine too short at
   * THIS render is `video-too-short`, the same function the admission and `montages.get` use.
   */
  const checkOwnVideos = (plan: RenderPlan): Map<string, OwnVideoSource> => {
    const held = new Map((plan.ownVideos ?? []).map((own) => [own.mediaId, own]));
    const issues = ownVideoIssues(plan.spec, (mediaId) => {
      const own = held.get(mediaId);
      return own === undefined ? null : { durationMs: own.durationMs };
    });
    if (issues.length > 0) throw new RenderFailure({ code: "MONTAGE_INVALID", issues: issues.slice(0, MAX_MONTAGE_ISSUES) });
    return held;
  };

  /**
   * Streams the plan's own videos into the job folder, then maps what only the owner can fix: a mezzanine that is gone or changed is the contract's `media-unavailable`
   * at each clip that uses it (`OwnVideoUnavailableError` names the media, never a path). A full disk, a failed write and a cancel come out as they are.
   */
  const stageOwnVideos = async (plan: RenderPlan, sources: readonly OwnVideoSource[], dir: string, signal: AbortSignal, progress: (copied: number, total: number) => void): Promise<void> => {
    try {
      await copyOwnVideos(dir, sources, signal, deps.ownVideoIo, progress);
    } catch (error) {
      if (!(error instanceof OwnVideoUnavailableError)) throw error;
      log(`render ${plan.jobId}: an own video was refused (changed or gone)`);
      const issues = ownVideoClips(plan.spec)
        .filter((clip) => clip.mediaId === error.mediaId)
        .map((clip) => ({ code: "media-unavailable" as const, path: clip.path }));
      throw new RenderFailure({ code: "MONTAGE_INVALID", issues: issues.slice(0, MAX_MONTAGE_ISSUES) });
    }
  };

  const executeJob = async (plan: RenderPlan, context: RenderContext, staging: StagingBound, stagedBytes: number): Promise<RenderResult> => {
    const ownVideos = checkOwnVideos(plan);
    // The layers first, before the export volume or the library is touched: the text is drawn by the engine's own rasteriser and the
    // stickers are checked against the shipped catalogue, so a caption that breaks a rule, or a sticker that is not intact, fails
    // the job here with nothing made. The files are staged later, by the runner, into the job's folder (`<renderTmpDir>/<jobId>`).
    const jobDir = join(deps.renderTmpDir, plan.jobId);
    let layers: Awaited<ReturnType<typeof resolveLayers>> | undefined;
    if (plan.spec.layers.length > 0) {
      if (deps.layers === undefined) throw new RenderFailure({ code: "INTERNAL", detail: "this engine cannot render text or sticker layers" });
      const resolving = deps.layers;
      layers = await staging.run((signal) => resolveLayers(plan.spec.layers, jobDir, resolving, signal, new Map((plan.ownStickers ?? []).map((own) => [own.mediaId, own]))));
    }

    const music = await staging.run((signal) => openTrack(plan, signal));
    const track = music?.track ?? null;
    const audio: RunAudio = music === null ? plan.audio : { kind: "music", startMs: music.startMs, data: music.track.data, check: music.track.check };
    const tile = track === null ? plan.music : { title: track.title, artist: track.artist };
    const { root, rootId } = plan.exportRoot;
    // Everything up to pass 2 touches the export volume, which may be a network drive that has dropped: one bound for the
    // group, and a cancel gives way at once (`guarded`).
    const { caseInsensitive, folder } = await guarded(context.signal, stepMs, async () => {
      // 1. The root is the one that was checked (before this job makes a folder in whatever is at that path now).
      await assertSameRoot(root, rootId);
      let insensitive: boolean;
      try {
        insensitive = await deps.caseProbe.isCaseInsensitive(root);
      } catch (error) {
        // The probe writes a file in the owner's export folder; its error names that path, which reaches the UI: only the code does.
        log(`render ${plan.jobId}: the export folder's case rule could not be probed (${codeOf(error)})`);
        throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: `the export folder could not be probed (${codeOf(error)})` });
      }
      let prepared: PreparedFolder;
      try {
        prepared = await prepareExportFolder({ fs: deps.folderFs ?? NODE_EXPORT_FOLDER_FS, root, safeName: plan.safeName, avatarId: plan.avatarId, caseInsensitive: insensitive });
      } catch (error) {
        if (error instanceof ExportFolderError) throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: error.reason, detail: error.message });
        // Anything else names the owner's export path in its message, which reaches the UI: only the code does.
        log(`render ${plan.jobId}: the export folder could not be prepared (${codeOf(error)})`);
        throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: `the export folder could not be prepared (${codeOf(error)})` });
      }
      // A folder this job just created is an entry in the root: make it durable before anything goes into it.
      await fs.fsyncDir(root).catch((error: unknown) => log(`render ${plan.jobId}: the export folder could not be flushed (${codeOf(error)})`));
      return { caseInsensitive: insensitive, folder: prepared };
    });

    const temp = folder.fileIn(partNameOf(plan.jobId));
    deps.tracker.addJob(plan.jobId, plan.videoId);
    deps.tracker.addTemp(temp);
    let placeholder: string | null = null;
    let commit: Promise<CommittedVideo> | null = null;
    let commitEnded = false;
    try {
      let forbiddenStrings: string[];
      try {
        // The library may sit on a drive that has gone quiet: the read runs under the staging bound (time and cancel), so a silent disk ends the job
        // TIMEOUT or cancelled instead of holding the slot, the holds and the reservations for ever.
        const photoStrings = await staging.run((signal) => collectForbiddenStrings((photoId) => deps.library.readPhotoVerified(photoId), scenePhotoIds(plan.spec.clips), signal));
        // The track's own text joins the photos' (invariant 14), each under its own quota: neither may be found in the finished video.
        forbiddenStrings = track === null ? photoStrings : combineForbiddenStrings(photoStrings, track.forbidden);
      } catch (error) {
        // The bound passing or the owner's cancel is the signal's own reason: the queue maps it (TIMEOUT, cancelled).
        if (staging.signal.aborted) throw error;
        log(`render ${plan.jobId}: a source photo could not be read (${error instanceof Error ? error.name : "error"})`);
        throw new RenderFailure({ code: "INTERNAL", detail: "a source photo could not be read" });
      }

      const outcome = await runJob(
        {
          jobId: plan.jobId,
          tmpRoot: deps.renderTmpDir,
          seed: plan.spec.seed,
          clips: plan.spec.clips,
          resolvePhoto: plan.resolvePhoto,
          // 3f.3b: each own video is STREAMED, verified, into the job folder; `resolveVideo` names the copies and the stored size the cover-crop starts from.
          ...(ownVideos.size === 0
            ? {}
            : {
                resolveVideo: (mediaId: string) => {
                  const own = ownVideos.get(mediaId);
                  return own === undefined ? undefined : { path: join(jobDir, ownVideoCopyName(mediaId)), width: own.width, height: own.height };
                },
                stageOwnVideos: (dir: string, progress: (copied: number, total: number) => void, signal: AbortSignal) => stageOwnVideos(plan, [...ownVideos.values()], dir, signal, progress),
                ownVideoBytes: [...ownVideos.values()].reduce((sum, own) => sum + own.bytes, 0),
              }),
          overlays: layers === undefined ? [] : layers.overlays,
          staging,
          stagingBytes: stagedBytes,
          ...(layers === undefined ? {} : { stageLayers: layers.stage }),
          // 3f.2: each own photo is copied, verified, into the job folder; `resolvePhoto` already names the copies.
          ...(plan.ownPhotos === undefined || plan.ownPhotos.length === 0 ? {} : { stageOwnPhotos: (dir: string, signal: AbortSignal) => copyOwnPhotos(dir, plan.ownPhotos ?? [], signal, deps.ownPhotoOps) }),
          audio,
          output: temp,
          signal: context.signal,
          onProgress: (done) => void context.progress(done),
          // 2. Minutes have passed since the folder was made: look again, then make the temp ourselves.
          beforePass2: () =>
            guarded(context.signal, stepMs, async () => {
              await assertSameRoot(root, rootId);
              try {
                await assertFolderContained(fs, folder, root, caseInsensitive);
              } catch (error) {
                if (error instanceof ContainmentError) throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "the export folder changed while the video was being rendered" });
                log(`render ${plan.jobId}: the export folder could not be checked before pass 2 (${codeOf(error)})`);
                throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: codeOf(error) === "ENOENT" ? "missing" : "not-writable", detail: `the export folder could not be checked (${codeOf(error)})` });
              }
              try {
                await createTemp(temp);
              } catch (error) {
                log(`render ${plan.jobId}: the render's output file could not be created (${codeOf(error)})`);
                throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: codeOf(error) === "ENOSPC" || codeOf(error) === "EDQUOT" ? "not-enough-space" : "not-writable", detail: `the render's output file could not be created (${codeOf(error)})` });
              }
            }),
        },
        deps.runDeps,
      ).catch((error: unknown) => {
        // ffmpeg's own check of the private copy found the track is not one audio stream: the same refusal as the store's.
        if (error instanceof TrackUnavailableError) {
          log(`render ${plan.jobId}: the music track was refused (${error.kind})`);
          // An own track is a media of the library: the code every own media gets when it is not there or not what it was.
          throw new RenderFailure({ code: "MONTAGE_INVALID", issues: [{ code: plan.ownTrack === undefined ? "track-unavailable" : "media-unavailable", path: ["music"] }] });
        }
        throw error;
      });

      const now = deps.now();
      const deadlineTimers = deps.deadlineTimers ?? realDeadlineTimer();
      const stop = new AbortController();
      const commitSignal = AbortSignal.any([context.signal, stop.signal]);
      // Armed until `onSaving`: at the deadline the commit is told to stop (it never claims, then) and the job fails.
      let pastNoReturn = false;
      let deadlineFired = false;
      let deadlineTimer: unknown;
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = deadlineTimers.set(() => {
          if (pastNoReturn) return;
          deadlineFired = true;
          const failure = new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "saving the video took too long: the export folder or the library does not answer" });
          log(`render ${plan.jobId}: the commit passed its deadline of ${deadlineMs} ms before it claimed a name; the job is failed and the commit is asked to stop`);
          stop.abort(failure);
          reject(failure);
        }, deadlineMs);
      });
      deadline.catch(() => undefined);
      commit = commitVideo(
        { folder, root, rootId, caseInsensitive },
        {
          jobId: plan.jobId,
          videoId: plan.videoId,
          avatarId: plan.avatarId,
          videoKind: plan.videoKind,
          date: formatExportDate(now),
          createdAt: now.toISOString(),
          frames: totalFramesOf(plan.spec.clips),
          durationMs: plan.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0),
          montageId: plan.montageId !== null && deps.draftRemoved?.(plan.montageId) === true ? null : plan.montageId,
          title: plan.title,
          music: tile,
          // What the render resolved for the music: where it started, the gain the true-peak pass chose, the file it read.
          ...(track === null || music === null || outcome.music === undefined ? {} : { audio: { trackSha: track.sha256, startMs: music.startMs, gainDb: outcome.music.gainDb } }),
          spec: plan.spec,
          forbiddenStrings,
        },
        {
          fs,
          libraryRoot: deps.library.root,
          library: deps.library,
          ...(deps.numberFs === undefined ? {} : { numberFs: deps.numberFs }),
          signal: commitSignal,
          log,
          onClaimed: (path) => {
            placeholder = path;
            deps.tracker.addPlaceholder(path);
          },
          // 3. The last look, inside the root lock, before the name is claimed.
          beforeClaim: () => assertSameRoot(root, rootId),
          // The point of no return: no deadline and no cancel from here; the window is told the job is saving.
          onSaving: () => {
            pastNoReturn = true;
            deadlineTimers.clear(deadlineTimer);
            context.saving();
          },
          ...(deps.verify === undefined ? {} : { verify: deps.verify }),
          ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
          ...(deps.claimStartAt === undefined ? {} : { claimStartAt: deps.claimStartAt }),
        },
      )
        .then(async (committed) => {
          // The record is on disk; the used index follows it before the job ends and the reservation is released.
          await indexCommittedRecord(deps.library, committed.record, log);
          try {
            deps.onCommitted?.(committed.record);
          } catch (error) {
            log(`render ${plan.jobId}: a listener of the committed video threw (${error instanceof Error ? error.name : "error"})`);
          }
          return committed;
        })
        .finally(() => {
          commitEnded = true;
        });

      // The deadline covers only what comes BEFORE the point of no return. Past it (`onSaving`) the timer is gone: the job
      // stays running until the record lands, holding its queue slot, its photo reservation and the busy state.
      try {
        const committed = await Promise.race([commit, deadline]).finally(() => deadlineTimers.clear(deadlineTimer));
        return committed.result;
      } catch (error) {
        // A commit that failed AFTER writing its intent may have left it, with a file that would not go (a player or an
        // antivirus holds it): settle it HERE, under the root lock, while the queue still holds the photos' reservation.
        // Settled later, the photos would be free for a moment while a video exists, and a second render would take them.
        // A deadline before the claim and a cancel leave nothing to settle.
        const cancelled = context.signal.aborted && error === context.signal.reason;
        if (deadlineFired || cancelled || deps.settleLeftover === undefined) throw error;
        const adopted = await settleBounded(deps.settleLeftover, { avatarId: plan.avatarId, videoId: plan.videoId, jobId: plan.jobId, exportRoot: { root, rootId, caseInsensitive }, photoIds: scenePhotoIds(plan.spec.clips) }, stepMs, log);
        if (adopted === null) throw error;
        // The video exists: the job is done, not failed.
        try {
          deps.onCommitted?.(adopted);
        } catch (listenerError) {
          log(`render ${plan.jobId}: a listener of the committed video threw (${listenerError instanceof Error ? listenerError.name : "error"})`);
        }
        return { kind: "render", videoId: adopted.id, avatarId: adopted.avatarId, bytes: adopted.file.bytes, durationMs: adopted.durationMs, videoKind: adopted.kind, relPath: adopted.file.relPath };
      }
    } finally {
      const release = (): void => {
        deps.tracker.release(temp, ...(placeholder === null ? [] : [placeholder]));
        deps.tracker.releaseJob(plan.jobId);
      };
      if (commit === null || commitEnded) release();
      // A commit stopped at its pre-claim deadline may still be stuck in a call; it stays live for recovery until it really ends.
      else void commit.then(release, release);
    }
  };

  return (plan) => async (context) => {
    // ONE time bound for all the job's staging, from the SUM of the bytes it will read: the own photos', videos' and stickers' copies and a track's bytes. Each read runs raced
    // against it (here, and in the runner for the copies into the job folder), so a read that never returns ends the job TIMEOUT instead of holding the render slot for ever.
    const stagedBytes =
      (plan.scenePhotoBytes ?? 0) +
      (plan.ownPhotos ?? []).reduce((sum, own) => sum + own.bytes, 0) +
      (plan.ownVideos ?? []).reduce((sum, own) => sum + own.bytes, 0) +
      (plan.ownStickers ?? []).reduce((sum, own) => sum + own.bytes, 0) +
      (plan.ownTrack?.source.bytes ?? 0);
    const staging = stagingBound((deps.runDeps?.stagingTimeoutMs ?? stagingTimeoutMs)(stagedBytes), context.signal, deps.runDeps?.stagingTimers);
    try {
      return await executeJob(plan, context, staging, stagedBytes);
    } finally {
      staging.release();
    }
  };
}
