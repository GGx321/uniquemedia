import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Id } from "../../shared/engine";
import { freeBytesOf } from "../freeBytes";
import type { Clip } from "../../shared/engine/montage";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { totalFrames as framesOfTimeline } from "../../shared/montage";
import { buildLayerPass, buildMusicMeasure, buildPass1, buildPass2, musicGainDb, RenderGraphError, type MusicMeasureJob, type OverlayInput, type Pass2Job, type PhotoResolver, type VideoResolver } from "../render";
import { clipFrames } from "../render/durations";
import { TRACK_FILE_NAME } from "../render/names";
import { measureTruePeak } from "./musicMeasure";
import { ProgressFold, renderTimeoutMs, stagingTimeoutMs } from "./progress";
import { RenderFailure } from "./queue";
import { scrubber, scrubStderrTail, type ScrubInput } from "./scrubber";

// The runner of ONE render job (task 3a.6): pass 1 once per visual clip into
// the job's own folder, then the layer pass (3b.6: the text and sticker layers
// composited onto one lossless file, in chained calls when they do not fit one),
// then pass 2 into the temp output it is given, one ffmpeg at a time. It owns
// the job folder and the temp output's cleanup; it does not know about the
// queue, the registry or the reserved photos.

/** The music of a job: the verified bytes, where to start, and the store's check of the private copy (ffmpeg sees exactly one audio stream). */
export type RunAudio =
  | { readonly kind: "silent" }
  | {
      readonly kind: "music";
      readonly startMs: number;
      readonly data: Uint8Array;
      readonly check?: (path: string, signal: AbortSignal) => Promise<void>;
    };

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
  /**
   * Where each own video clip's private copy is (in the job folder, where `stageOwnVideos` writes it) and the mezzanine's STORED size (3f.3b). Absent: a spec with a
   * video clip is refused by the builder (`VIDEO_UNRESOLVED`).
   */
  readonly resolveVideo?: VideoResolver;
  /**
   * The text and sticker layers in z-order, later on top, as files INSIDE the job folder (`<tmpRoot>/<jobId>/...`, which is
   * where `stageLayers` writes them). They go through the layer pass; pass 2 overlays the one file that comes out.
   */
  readonly overlays: readonly OverlayInput[];
  /**
   * Writes the files `overlays` name into the job folder, which the runner has just made (`dir`). Called once, before any ffmpeg,
   * and only when there are overlays. A `RenderFailure` it throws reaches the job unchanged; any other error is scrubbed of
   * the user's folders like a file-system error of the runner's own.
   */
  readonly stageLayers?: (dir: string) => Promise<void>;
  /**
   * Writes the private copies of the own photos the clips name into the job folder (3f.2; `resolvePhoto` already points at those names),
   * after checking each against its record. Called once, right after the folder is made and before anything else is staged or run. A
   * `RenderFailure` it throws reaches the job unchanged; the cancel's reason comes out as it is; any other error is scrubbed of the
   * user's folders like a file-system error of the runner's own.
   */
  readonly stageOwnPhotos?: (dir: string) => Promise<void>;
  /**
   * Writes the private copies of the own videos the clips name into the job folder (3f.3b; `resolveVideo` already points at those names): each mezzanine is STREAMED
   * in, checked against its record as it goes. Called once, after `stageOwnPhotos` and before the layers are staged or anything is run; the same rules for what it throws.
   * `progress(copied, total)` says how many bytes of all the copies are made: the job's own progress moves with it (a copy of hundreds of MiB must not look frozen), and the
   * ffmpeg budget starts only when the staging has ended (the copies' time is the disk's, not ffmpeg's). The staging has a bound of its own (`stagingTimeoutMs` of `ownVideoBytes`):
   * past it the job ends TIMEOUT even while a read is stuck, and the `signal` given (the job's cancel, or that bound) tells the abandoned copy to stop and remove itself when its read returns.
   */
  readonly stageOwnVideos?: (dir: string, progress: (copied: number, total: number) => void, signal: AbortSignal) => Promise<void>;
  /** The bytes of all the own videos' copies (the sum of their records' sizes): what the staging's own time bound is sized from. */
  readonly ownVideoBytes?: number;
  /**
   * Silence, or one stored track as the VERIFIED BYTES the track store handed over (never a path: a file on disk can change
   * between the store's check and ffmpeg's read). The runner writes them to `<job folder>/track.m4a`, has `check` look at that
   * copy, and runs the measurement and pass 2 on it. The gain is not known yet: the runner measures the clip segment first
   * and builds pass 2 with the gain the rule gives.
   */
  readonly audio: RunAudio;
  /** Absolute: the temp output on the export volume (`.studio-part-<jobId>.mp4`). Removed here when the job does not succeed. */
  readonly output: string;
  readonly signal: AbortSignal;
  /** Frames of the FINAL video done so far: monotonic, always below the total. A throw stops the job with that error. */
  readonly onProgress: (done: number) => void;
  /**
   * Called once, after pass 1 and right before pass 2 starts (never for a job cancelled before that). Pass 2
   * writes `output` BY PATH for the whole render, minutes after the export folder was checked, so the caller
   * uses this to look at the folder again and to create the output itself. A throw stops the job with that error:
   * the job folder and the output are removed as on any failure, and no pass 2 runs. Errors that reach the UI
   * should be a `RenderFailure` with a clean detail; a plain error is masked, not scrubbed of export paths.
   */
  readonly beforePass2?: () => void | Promise<void>;
}

export interface RenderRunDeps {
  /** Runs one ffmpeg argv; `runFfmpegArgv` unless a test scripts it. */
  readonly run?: (opts: RunFfmpegArgvOptions) => Promise<void>;
  /** Measures the true peak of a music segment (dBTP); `measureTruePeak` (ffmpeg's ebur128) unless a test scripts it. */
  readonly measure?: (job: MusicMeasureJob, options: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<number>;
  /**
   * Free bytes on the volume of `dir` (the job's folder), or null when it cannot be read; `statfs` unless a test scripts it. The layer pass
   * checks it against what its files can take, and a volume that does not say is not refused.
   */
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /** How long the own videos' staging may take for this many bytes; `stagingTimeoutMs` by default. */
  readonly stagingTimeoutMs?: (bytes: number) => number;
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
  /** What the true-peak pass found and the gain it chose (dB, never positive). Absent for a silent video. */
  readonly music?: { readonly gainDb: number; readonly truePeakDb: number };
}

/** The name of the temp output a job may write and, on failure, remove; nothing else. */
const partName = (jobId: string): string => `.studio-part-${jobId}.mp4`;

const MIB = 1024 * 1024;
/** The copies of the own videos fill up to this part of the timeline's frames in pass 1's slice of the progress. */
const COPY_SHARE = 0.3;

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
  const resolveVideo: VideoResolver | undefined =
    input.resolveVideo === undefined
      ? undefined
      : (mediaId) => {
          const source = input.resolveVideo?.(mediaId);
          if (source !== undefined) scrubInputs.push({ path: source.path, label: "<video>" });
          return source;
        };
  for (const overlay of input.overlays) scrubInputs.push({ path: overlay.path, label: "<overlay>" });
  const trackCopy = join(clipDir, TRACK_FILE_NAME);
  if (input.audio.kind === "music") scrubInputs.push({ path: trackCopy, label: "<audio>" });

  const pass1 = buildPass1({ seed: input.seed, clips: input.clips, resolvePhoto, ...(resolveVideo === undefined ? {} : { resolveVideo }), clipDir });
  const finalClips = input.clips.map((c) => ({ clipId: c.clipId, durationMs: c.durationMs }));
  // The layer pass is planned after pass 1 (which refuses a bad duration first) and before anything runs: a layer past the montage's end is refused here.
  const timelineFrames = framesOfTimeline(input.clips);
  const layerPlan = buildLayerPass({ layers: input.overlays, totalFrames: timelineFrames, clipDir });
  // What pass 2 overlays, silent or with music: the layer pass's ONE file, never the layers themselves (pass 2's memory grows by a constant per overlay input).
  const layerOverlays = layerPlan.final === null ? [] : [layerPlan.final];
  // Silence is built now, so a refused graph fails before anything is created. Music needs the gain the measurement gives (below).
  let pass2: Pass2Job | null = input.audio.kind === "silent" ? buildPass2({ clips: finalClips, clipDir, output: input.output, overlays: layerOverlays, audio: { kind: "silent" } }) : null;
  const totalFrames = pass2?.totalFrames ?? finalClips.reduce((sum, c) => sum + clipFrames(c.durationMs), 0);
  // Everything before pass 2 (the clips, then the layer calls) shares pass 1's slice of the progress, in proportion to its frames.
  const stageFrames = timelineFrames * (1 + layerPlan.jobs.length);
  const fold = new ProgressFold(totalFrames);
  const budgetMs = renderTimeoutMs(totalFrames);
  // The ffmpeg budget starts when the staging is over (below): the copies of the own videos can take as long as a slow disk takes.
  let deadline = now() + budgetMs;

  const measure = deps.measure ?? measureTruePeak;

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

  /**
   * The own videos' staging under a bound of its own, raced: the job ends the moment the bound passes or the owner cancels, whatever the copy is stuck in (an abort is only seen
   * between two chunks, and a `read` on a dead disk never returns). The copy is handed a signal that carries both reasons; it removes what it made when it wakes. A late
   * failure of the abandoned copy is swallowed: the job has ended.
   */
  const stageVideosBounded = async (work: NonNullable<RenderRunInput["stageOwnVideos"]>, dir: string, progress: (copied: number, total: number) => void): Promise<void> => {
    const ms = (deps.stagingTimeoutMs ?? stagingTimeoutMs)(input.ownVideoBytes ?? 0);
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(new FfmpegTimeoutError(ms, "")), ms);
    const given = AbortSignal.any([signal, bound.signal]);
    const ended = new Promise<never>((_resolve, reject) => {
      const stop = (): void => reject(given.reason);
      if (given.aborted) stop();
      else given.addEventListener("abort", stop, { once: true });
    });
    ended.catch(() => undefined);
    const copying = work(dir, progress, given);
    copying.catch(() => undefined);
    try {
      await Promise.race([copying, ended]);
    } finally {
      clearTimeout(timer);
    }
  };

  const reportStage = (doneFrames: number): void => report(fold.pass1(Math.floor((doneFrames * timelineFrames) / stageFrames)));

  /** Staging the layers: the engine's own answer (a `RenderFailure`) reaches the job as it is, anything else is scrubbed like a file-system error. */
  const stage = async (work: Promise<unknown>): Promise<void> => {
    try {
      await work;
    } catch (error) {
      // The cancel's own reason is not a file-system error and comes out as it is (the queue ends the job as cancelled).
      if (error instanceof Error && !(error instanceof RenderFailure) && !(error instanceof FfmpegTimeoutError) && !(signal.aborted && error === signal.reason)) throw scrubbedCopy(error);
      throw error;
    }
  };

  const scrubFs = async (work: Promise<unknown>): Promise<void> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof Error) throw scrubbedCopy(error);
      throw error;
    }
  };

  /** What a failed ffmpeg call (or measurement) reaches the job as: the tail scrubbed of the user's paths, a timeout named after the whole budget. */
  const failure = (error: unknown): unknown => {
    // A refusal of the builders or of the peak's reading names no path: it comes out as it is, like the builders' own.
    if (error instanceof RenderGraphError) return error;
    // The tail may name the user's folders and files; what reaches the job's error says <tmp>, <export>, <photo>... instead.
    if (error instanceof FfmpegTimeoutError) return new FfmpegTimeoutError(budgetMs, scrubStderrTail(scrub, error.stderrTail), { cause: error });
    if (error instanceof FfmpegError) return new FfmpegError(scrub(error.message), error.exitCode, scrubStderrTail(scrub, error.stderrTail), { cause: error });
    // Anything else that is not the cancel itself (whose reason must come out as it is) is a plain error: a spawn error names the binary's path.
    if (error instanceof Error && !signal.aborted && error !== listenerError) return scrubbedCopy(error);
    return error;
  };

  /** One ffmpeg call on what is left of the job's budget; a timeout is named after the whole budget. */
  const call = async (job: { argv: readonly string[]; output: string }, options: { cwd?: string; onFrames: (frames: number) => void }): Promise<void> => {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new FfmpegTimeoutError(budgetMs, "");
    try {
      await run({ argv: job.argv, output: job.output, signal, timeoutMs: remaining, onFrames: options.onFrames, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    } catch (error) {
      throw failure(error);
    }
  };

  /**
   * The true-peak pass over the music's clip segment, on what is left of the job's budget (invariant 21): the gain is the
   * rule's, `min(0, -1.5 - TP)`. A failure reaches the job as any ffmpeg failure does; a peak that is not a number is BAD_AUDIO.
   */
  const measureMusic = async (music: { readonly startMs: number }): Promise<{ gainDb: number; truePeakDb: number }> => {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw new FfmpegTimeoutError(budgetMs, "");
    const job = buildMusicMeasure({ path: trackCopy, startMs: music.startMs, durationMs: finalClips.reduce((sum, c) => sum + c.durationMs, 0) });
    let truePeakDb: number;
    try {
      truePeakDb = await measure(job, { signal, timeoutMs: remaining });
    } catch (error) {
      throw failure(error);
    }
    return { gainDb: musicGainDb(truePeakDb), truePeakDb };
  };

  let succeeded = false;
  try {
    await scrubFs(mkdir(clipDir, { recursive: true }));
    if (input.stageOwnPhotos !== undefined) await stage(input.stageOwnPhotos(clipDir));
    if (input.stageOwnVideos !== undefined) {
      // The copies share the start of the bar with pass 1: up to a third of pass 1's own slice, so it moves but never reaches what pass 1 will report.
      await stage(stageVideosBounded(input.stageOwnVideos, clipDir, (copied, total) => report(total > 0 ? fold.pass1(Math.floor((Math.min(copied, total) / total) * COPY_SHARE * timelineFrames)) : null)));
    }
    if (input.stageLayers !== undefined && input.overlays.length > 0) await stage(input.stageLayers(clipDir));
    deadline = now() + budgetMs;
    // The layer files can take real room (a 15 s file with heavy captions and stickers is 300 MiB, and two exist at once): ask the volume
    // BEFORE anything is rendered, and refuse cleanly rather than fail an ffmpeg half way with a full disk.
    if (layerPlan.jobs.length > 0) {
      const free = await (deps.freeBytes ?? freeBytesOf)(clipDir);
      if (free !== null && free < layerPlan.peakDiskBytes) {
        throw new RenderFailure({ code: "RENDER_FAILED", detail: `not enough free space for the render's temporary files: about ${Math.ceil(layerPlan.peakDiskBytes / MIB)} MiB are needed` });
      }
    }

    // Music is measured BEFORE pass 1: a track ffmpeg cannot read ends the job in a second, not after the photos were rendered.
    let music: { gainDb: number; truePeakDb: number } | null = null;
    if (input.audio.kind === "music") {
      // The private copy: the store verified THESE bytes, and nothing that happens to the stored file from here on reaches the
      // render. `wx`: the job folder is new, so a file already there is not ours.
      await scrubFs(writeFile(trackCopy, input.audio.data, { flag: "wx" }));
      // The store's own refusal (a `TrackUnavailableError`, whose text names no path) or the cancel comes out as it is.
      await input.audio.check?.(trackCopy, signal);
      music = await measureMusic(input.audio);
      pass2 = buildPass2({ clips: finalClips, clipDir, output: input.output, overlays: layerOverlays, audio: { kind: "music", path: trackCopy, startMs: input.audio.startMs, gainDb: music.gainDb } });
    }
    const finalPass = pass2;
    if (finalPass === null) throw new TypeError("runRenderJob: pass 2 was not built");

    let framesOfDoneClips = 0;
    for (const job of pass1) {
      // The frames ffmpeg reports for this clip's file (null: it reported none, which only a scripted ffmpeg in a test does).
      let wrote: number | null = null;
      await call(job, {
        onFrames: (frames) => {
          wrote = Math.max(wrote ?? 0, frames);
          reportStage(framesOfDoneClips + Math.min(frames, job.frames));
        },
      });
      // An own video clip is checked, not trusted: its length comes from the file it is cut from, and a mezzanine that gave fewer (or more) frames than the clip asks
      // for would make a SHORTER clip without a sound. `-xerror` and a constant rate should make it exact; a file that is not is refused here, before it is joined to the rest.
      // A count nobody saw is no count: an ffmpeg that reported no frames at all fails a video clip closed (a real one always reports them).
      if (input.clips[job.index]?.kind === "video" && wrote !== job.frames) {
        throw new RenderFailure({ code: "RENDER_FAILED", detail: wrote === null ? "an own video's clip file was not counted: ffmpeg reported no frames" : `an own video's clip file has ${wrote} frames, the clip is ${job.frames}` });
      }
      framesOfDoneClips += job.frames;
      reportStage(framesOfDoneClips);
    }

    // The layer calls, one after another: each composites its layers onto the file the call before wrote.
    let framesOfDoneLayers = 0;
    for (const job of layerPlan.jobs) {
      // null: ffmpeg reported nothing (only a scripted ffmpeg in a test does; the real one always reports its frames, which a real-ffmpeg test pins).
      let wrote: number | null = null;
      await call(job, {
        onFrames: (frames) => {
          wrote = Math.max(wrote ?? 0, frames);
          reportStage(timelineFrames + framesOfDoneLayers + Math.min(frames, job.frames));
        },
      });
      // A layer file is checked, not trusted: `-xerror` and a constant frame rate should make it exact, and a file with the wrong number of frames would
      // put the layers out of step with the video without a sound.
      if (wrote !== null && wrote !== job.frames) throw new RenderFailure({ code: "RENDER_FAILED", detail: `a layer file has ${wrote} frames, the timeline has ${job.frames}` });
      framesOfDoneLayers += job.frames;
      reportStage(timelineFrames + framesOfDoneLayers);
      // The call before this one wrote the file this one read: it is not needed any more, so at most two layer files exist at once.
      const earlier = layerPlan.jobs[job.index - 1];
      if (earlier !== undefined) await removeFile(earlier.output).catch((error: unknown) => warn("job folder", error));
    }

    signal.throwIfAborted();
    await scrubFs(writeFile(join(clipDir, finalPass.listFileName), finalPass.listFileContents));
    await input.beforePass2?.();
    signal.throwIfAborted();
    await call(finalPass, { cwd: finalPass.cwd, onFrames: (frames) => report(fold.pass2(frames)) });

    succeeded = true;
    return music === null ? { totalFrames } : { totalFrames, music };
  } finally {
    // The job folder goes on every way out. The temp output goes on every way
    // out but success. A cleanup that fails is reported and never replaces
    // the error (or the success) the job is ending with; the next start's
    // sweep gets what was left.
    await removeTree(clipDir).catch((error: unknown) => warn("job folder", error));
    if (!succeeded) await removeFile(input.output).catch((error: unknown) => warn("unfinished output", error));
  }
}
