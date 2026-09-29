import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Id } from "../../shared/engine";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { buildPass1, buildPass2, type AudioSource, type OverlayInput, type PhotoResolver } from "../render";
import { ProgressFold, renderTimeoutMs } from "./progress";
import { scrubber, scrubStderrTail, type ScrubInput } from "./scrubber";

// The runner of ONE render job (task 3a.6): pass 1 once per visual clip into
// the job's own folder, then pass 2 into the temp output it is given, one
// ffmpeg at a time. It owns the job folder and the temp output's cleanup; it
// does not know about the queue, the registry or the reserved photos.

export interface RenderRunInput {
  /** Names the job folder `<tmpRoot>/<jobId>`; letters, digits, `-` and `_` only. */
  readonly jobId: string;
  /** `userData/render-tmp`. Local: the intermediates are near-lossless and large. */
  readonly tmpRoot: string;
  readonly seed: number;
  readonly clips: readonly Clip[];
  /**
   * Where each photo is and its STORED size (what the library's sidecar reports):
   * the builder reads every photo with `-noautorotate`, so the size is the
   * stored orientation, never an oriented one. The runner passes it on untouched.
   */
  readonly resolvePhoto: PhotoResolver;
  readonly overlays: readonly OverlayInput[];
  readonly audio: AudioSource;
  /** Absolute: the temp output on the export volume (`.studio-part-<jobId>.mp4`). Removed here when the job does not succeed. */
  readonly output: string;
  readonly signal: AbortSignal;
  /** Frames of the FINAL video done so far: monotonic, always below the total. A throw stops the job with that error. */
  readonly onProgress: (done: number) => void;
}

export interface RenderRunDeps {
  /** Runs one ffmpeg argv; `runFfmpegArgv` unless a test scripts it. */
  readonly run?: (opts: RunFfmpegArgvOptions) => Promise<void>;
  /** Monotonic ms for the job's deadline. */
  readonly now?: () => number;
  /** Removes the job folder, tolerating one that is not there. A rejection is reported, never thrown. */
  readonly removeTree?: (path: string) => Promise<void>;
  /** Removes the temp output (a file only, never a folder), tolerating one that is not there. A rejection is reported, never thrown. */
  readonly removeFile?: (path: string) => Promise<void>;
  /** Where a cleanup that failed is reported (`what` names it); the render's own outcome is unchanged. */
  readonly warn?: (what: "job folder" | "unfinished output", error: unknown) => void;
  /** The user's home folder, masked as `~` in errors; `os.homedir()` unless a test fakes it. */
  readonly home?: string;
}

export interface RenderRunOutcome {
  /** Frames of the final video: `Σ durationMs × 3 / 100`. */
  readonly totalFrames: number;
}

/** The name of the temp output a job may write and, on failure, remove; nothing else. */
const partName = (jobId: string): string => `.studio-part-${jobId}.mp4`;

const defaultRemoveTree = (path: string): Promise<void> => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const defaultRemoveFile = (path: string): Promise<void> => rm(path, { force: true, maxRetries: 5, retryDelay: 100 });

/**
 * Renders one job. Resolves once pass 2 has written `output`; rejects with
 * what stopped it: the abort reason for a cancel, an `FfmpegTimeoutError` (of
 * the WHOLE budget) for a timeout, an `FfmpegError` (with a short stderr tail)
 * for a failing ffmpeg. Whichever way it ends, the job folder is removed, and
 * on any failure so is the temp output. The timeout is one deadline for the
 * job, `max(90 s, 30 × its seconds)`, shared by its calls.
 */
export async function runRenderJob(input: RenderRunInput, deps: RenderRunDeps = {}): Promise<RenderRunOutcome> {
  // The job id names a folder that is removed, and the output is removed on failure: both are checked before anything is built.
  if (!Id.safeParse(input.jobId).success) throw new TypeError(`runRenderJob: unsafe job id ${JSON.stringify(input.jobId)}.`);
  if (basename(input.output) !== partName(input.jobId)) throw new TypeError(`runRenderJob: the output must be named ${partName(input.jobId)}.`);
  const { signal } = input;
  signal.throwIfAborted();

  const run = deps.run ?? runFfmpegArgv;
  const now = deps.now ?? (() => performance.now());
  const removeTree = deps.removeTree ?? defaultRemoveTree;
  const removeFile = deps.removeFile ?? defaultRemoveFile;
  const warn = deps.warn ?? ((what, error) => console.warn(`studio render: the ${what} could not be removed (${error instanceof Error ? error.message : String(error)})`));

  const clipDir = join(input.tmpRoot, input.jobId);
  // Every path the job hands to ffmpeg as an input, for the scrubber: what the builder resolves is what ffmpeg may print back.
  const scrubInputs: ScrubInput[] = [];
  const resolvePhoto: PhotoResolver = (ref) => {
    const source = input.resolvePhoto(ref);
    if (source !== undefined) scrubInputs.push({ path: source.path, label: "<photo>" });
    return source;
  };
  for (const overlay of input.overlays) scrubInputs.push({ path: overlay.path, label: "<overlay>" });
  // `input.audio` is silence in 3a and has no file; music (3c) adds its path here, labelled `<audio>`.

  const pass1 = buildPass1({ seed: input.seed, clips: input.clips, resolvePhoto, clipDir });
  const pass2 = buildPass2({ clips: input.clips.map((c) => ({ clipId: c.clipId, durationMs: c.durationMs })), clipDir, output: input.output, overlays: input.overlays, audio: input.audio });
  const totalFrames = pass2.totalFrames;
  const fold = new ProgressFold(totalFrames);
  const budgetMs = renderTimeoutMs(totalFrames);
  const deadline = now() + budgetMs;

  const scrub = scrubber(input.tmpRoot, dirname(input.output), scrubInputs, deps.home);

  /** What the caller's own progress listener threw: it stops the job as it is, never wrapped (it is the caller's error, not a path-bearing one). */
  let listenerError: unknown;
  const report = (done: number | null): void => {
    // Nothing is reported once the job is cancelled, even if ffmpeg had already exited 0.
    if (done === null || signal.aborted) return;
    try {
      input.onProgress(done);
    } catch (error) {
      listenerError = error;
      throw error;
    }
  };

  /**
   * A plain error (a file-system error, a spawn error for the ffmpeg binary) names paths in its message, and that
   * message reaches the UI. This copy says <tmp>, ~ ... instead and keeps the errno `code`; the RAW error stays as
   * `cause`, for the log only.
   */
  const scrubbedCopy = (error: Error): Error => {
    const copy = new Error(scrub(error.message), { cause: error });
    if ("code" in error && typeof error.code === "string") Object.assign(copy, { code: error.code });
    return copy;
  };

  const scrubFs = async (work: Promise<unknown>): Promise<void> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof Error) throw scrubbedCopy(error);
      throw error;
    }
  };

  /** One ffmpeg call on what is left of the job's budget; a timeout is named after the whole budget. */
  const call = async (job: { argv: readonly string[]; output: string }, options: { cwd?: string; onFrames: (frames: number) => void }): Promise<void> => {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new FfmpegTimeoutError(budgetMs, "");
    try {
      await run({ argv: job.argv, output: job.output, signal, timeoutMs: remaining, onFrames: options.onFrames, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    } catch (error) {
      // The tail may name the user's folders and files; what reaches the job's error says <tmp>, <export>, <photo>... instead.
      if (error instanceof FfmpegTimeoutError) throw Object.assign(new FfmpegTimeoutError(budgetMs, scrubStderrTail(scrub, error.stderrTail)), { cause: error });
      if (error instanceof FfmpegError) throw Object.assign(new FfmpegError(scrub(error.message), error.exitCode, scrubStderrTail(scrub, error.stderrTail)), { cause: error });
      // Anything else that is not the cancel itself (whose reason must come out as it is) is a plain error: a spawn error names the binary's path.
      if (error instanceof Error && !signal.aborted && error !== listenerError) throw scrubbedCopy(error);
      throw error;
    }
  };

  let succeeded = false;
  try {
    await scrubFs(mkdir(clipDir, { recursive: true }));

    let framesOfDoneClips = 0;
    for (const job of pass1) {
      await call(job, { onFrames: (frames) => report(fold.pass1(framesOfDoneClips + Math.min(frames, job.frames))) });
      framesOfDoneClips += job.frames;
      report(fold.pass1(framesOfDoneClips));
    }

    signal.throwIfAborted();
    await scrubFs(writeFile(join(clipDir, pass2.listFileName), pass2.listFileContents));
    await call(pass2, { cwd: pass2.cwd, onFrames: (frames) => report(fold.pass2(frames)) });

    succeeded = true;
    return { totalFrames };
  } finally {
    // The job folder goes on every way out. The temp output goes on every way
    // out but success. A cleanup that fails is reported and never replaces
    // the error (or the success) the job is ending with; the next start's
    // sweep gets what was left.
    await removeTree(clipDir).catch((error: unknown) => warn("job folder", error));
    if (!succeeded) await removeFile(input.output).catch((error: unknown) => warn("unfinished output", error));
  }
}
