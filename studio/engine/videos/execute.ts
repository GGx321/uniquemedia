import { resolve } from "node:path";
import type { z } from "zod";
import type { RenderResult } from "../../shared/engine";
import type { MontageShape } from "../../shared/engine/montage";
import { totalFrames } from "../../shared/montage";
import { ExportFolderError, formatExportDate, NODE_EXPORT_FOLDER_FS, prepareExportFolder, type ExportFolderFs } from "../exportName";
import type { Library } from "../library";
import type { AudioSource, OverlayInput, PhotoResolver } from "../render";
import { RenderFailure, type RenderContext } from "../renderQueue/queue";
import { runRenderJob, type RenderRunDeps } from "../renderQueue/runner";
import type { VerifiedFile, VerifyExpected } from "../verify";
import { commitVideo, type CommitStep } from "./commit";
import { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
import { collectForbiddenStrings } from "./forbiddenStrings";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { partNameOf, scenePhotoIds, type VideoRecord } from "./record";

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

/** The frame count of a timeline: what the queue submission's `totalFrames` and the verifier's expectation both come from, so they cannot disagree. */
export function totalFramesOf(clips: readonly { readonly durationMs: number }[]): number {
  return totalFrames(clips);
}

/**
 * The renders running now, as absolute paths in `path.resolve` form: the recovery
 * that runs when a library opens must not take a live job's temp or its claimed
 * placeholder for a crash's leftovers.
 */
export class CommitTracker {
  readonly #temps = new Set<string>();
  readonly #placeholders = new Set<string>();

  tempPaths(): ReadonlySet<string> {
    return new Set(this.#temps);
  }

  placeholderPaths(): ReadonlySet<string> {
    return new Set(this.#placeholders);
  }

  addTemp(path: string): void {
    this.#temps.add(resolve(path));
  }

  addPlaceholder(path: string): void {
    this.#placeholders.add(resolve(path));
  }

  release(...paths: string[]): void {
    for (const path of paths) {
      this.#temps.delete(resolve(path));
      this.#placeholders.delete(resolve(path));
    }
  }
}

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
}

export function createRenderExecute(deps: VideoRenderDeps): (plan: RenderPlan) => (context: RenderContext) => Promise<RenderResult> {
  if (deps.renderTmpDir === "") throw new TypeError("createRenderExecute: renderTmpDir is required (no os.tmpdir fallback).");
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  const runJob = deps.runJob ?? runRenderJob;

  return (plan) => async (context) => {
    const { root, rootId } = plan.exportRoot;
    const caseInsensitive = await deps.caseProbe.isCaseInsensitive(root);
    let folder;
    try {
      folder = await prepareExportFolder({ fs: deps.folderFs ?? NODE_EXPORT_FOLDER_FS, root, safeName: plan.safeName, avatarId: plan.avatarId, caseInsensitive });
    } catch (error) {
      if (error instanceof ExportFolderError) throw new RenderFailure({ code: "EXPORT_UNAVAILABLE", exportReason: error.reason, detail: error.message });
      throw error;
    }

    const temp = folder.fileIn(partNameOf(plan.jobId));
    deps.tracker.addTemp(temp);
    let placeholder: string | null = null;
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
        },
        deps.runDeps,
      );

      const now = deps.now();
      const committed = await commitVideo(
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
          signal: context.signal,
          log,
          onClaimed: (path) => {
            placeholder = path;
            deps.tracker.addPlaceholder(path);
          },
          ...(deps.verify === undefined ? {} : { verify: deps.verify }),
          ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
          ...(deps.claimStartAt === undefined ? {} : { claimStartAt: deps.claimStartAt }),
        },
      );

      // The record is on disk; the used index follows it before the job ends and the reservation is released.
      await indexCommittedRecord(deps.library, committed.record, log);
      return committed.result;
    } finally {
      deps.tracker.release(temp, ...(placeholder === null ? [] : [placeholder]));
    }
  };
}
