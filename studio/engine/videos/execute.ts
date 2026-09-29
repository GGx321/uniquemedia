import type { z } from "zod";
import type { RenderResult } from "../../shared/engine";
import type { MontageShape } from "../../shared/engine/montage";
import { totalFrames } from "../../shared/montage";
import { ExportFolderError, formatExportDate, NODE_EXPORT_FOLDER_FS, prepareExportFolder, type ExportFolderFs, type PreparedFolder } from "../exportName";
import type { Library } from "../library";
import type { AudioSource, OverlayInput, PhotoResolver } from "../render";
import { RenderFailure, type RenderContext } from "../renderQueue/queue";
import { runRenderJob, type RenderRunDeps } from "../renderQueue/runner";
import type { VerifiedFile, VerifyExpected } from "../verify";
import { assertFolderContained, commitVideo, ContainmentError, type CommitStep, type CommittedVideo } from "./commit";
import { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
import { collectForbiddenStrings } from "./forbiddenStrings";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { CommitTracker } from "./live";
import { partNameOf, scenePhotoIds, type VideoRecord } from "./record";
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
  readonly overlays: readonly OverlayInput[];
  readonly audio: AudioSource;
  readonly montageId: string | null;
  /** The kind token of the file name. */
  readonly videoKind: string;
  readonly music: VideoRecord["music"];
}

export interface VideoRenderDeps {
  readonly library: Pick<Library, "root" | "readPhotoVerified"> & IndexPort;
  readonly tracker: CommitTracker;
  /** `userData/render-tmp`. Required: there is no `os.tmpdir` fallback. */
  readonly renderTmpDir: string;
  readonly caseProbe: { isCaseInsensitive(root: string): Promise<boolean> };
  readonly now: () => Date;
  readonly fs?: CommitFs;
  readonly folderFs?: ExportFolderFs;
  /** `runRenderJob` unless a test plays the runner. */
  readonly runJob?: typeof runRenderJob;
  readonly runDeps?: RenderRunDeps;
  readonly verify?: (path: string, expected: VerifyExpected) => Promise<VerifiedFile>;
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
  /** `COMMIT_DEADLINE_MS` unless a test says otherwise. */
  readonly commitDeadlineMs?: number;
  /** `EXPORT_STEP_DEADLINE_MS` unless a test says otherwise. */
  readonly stepDeadlineMs?: number;
  /** Creates the empty temp exclusively (no link followed); the real one unless a test plays a volume. */
  readonly createTemp?: (path: string) => Promise<void>;
}

export { CommitTracker } from "./live";

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

export function createRenderExecute(deps: VideoRenderDeps): (plan: RenderPlan) => (context: RenderContext) => Promise<RenderResult> {
  if (deps.renderTmpDir === "") throw new TypeError("createRenderExecute: renderTmpDir is required (no os.tmpdir fallback).");
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  const runJob = deps.runJob ?? runRenderJob;
  const createTemp = deps.createTemp ?? createTempExclusive;
  const deadlineMs = deps.commitDeadlineMs ?? COMMIT_DEADLINE_MS;
  const stepMs = deps.stepDeadlineMs ?? EXPORT_STEP_DEADLINE_MS;

  return (plan) => async (context) => {
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
        forbiddenStrings = await collectForbiddenStrings((photoId) => deps.library.readPhotoVerified(photoId), scenePhotoIds(plan.spec.clips));
      } catch (error) {
        log(`render ${plan.jobId}: a source photo could not be read (${error instanceof Error ? error.name : "error"})`);
        throw new RenderFailure({ code: "INTERNAL", detail: "a source photo could not be read" });
      }

      await runJob(
        {
          jobId: plan.jobId,
          tmpRoot: deps.renderTmpDir,
          seed: plan.spec.seed,
          clips: plan.spec.clips,
          resolvePhoto: plan.resolvePhoto,
          overlays: plan.overlays,
          audio: plan.audio,
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
      );

      const now = deps.now();
      const stop = new AbortController();
      const commitSignal = AbortSignal.any([context.signal, stop.signal]);
      // Armed until `onSaving`: at the deadline the commit is told to stop (it never claims, then) and the job fails.
      let pastNoReturn = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          if (pastNoReturn) return;
          const failure = new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", detail: "saving the video took too long: the export folder does not answer" });
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
          montageId: plan.montageId,
          music: plan.music,
          spec: plan.spec,
          forbiddenStrings,
        },
        {
          fs,
          libraryRoot: deps.library.root,
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
            clearTimeout(deadlineTimer);
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
      const committed = await Promise.race([commit, deadline]).finally(() => clearTimeout(deadlineTimer));
      return committed.result;
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
}
