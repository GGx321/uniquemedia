import { stat } from "node:fs/promises";
import { runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";
import { MEDIA_BYTE_CAPS } from "../../shared/engine";
import type { MediaImporter } from "./imports";
import { openFileSource } from "./video/fileSource";
import { expectedFrames, judgeVideo, VIDEO_LIMITS, videoArgs, type VideoJudgement, type VideoPlan } from "./video/videoPlan";
import { probeVideo, type VideoInfo } from "./video/videoProbe";

// The own-video importer (Stage 3 plan, 3f.3a). It turns an owner's MP4 or MOV into the mezzanine the render and the preview read: H.264 at
// CRF 16, 4:2:0, a constant 30 fps, BT.709 limited range, inside 1080 x 1920, upright, with no sound and no metadata.
//
//   the staged copy -> Studio's own box walker (`video/videoProbe.ts`) -> the limits and the plan (`video/videoPlan.ts`)
//     -> ffmpeg in a child process, under a wall-clock limit and the signal -> the walker again, on what ffmpeg wrote -> the record's facts
//
// WHAT IT TRUSTS. Nothing of the file but what its own boxes say after the walker has bounded them, and nothing of ffmpeg's but its exit
// status: the facts of the record come from the walker's reading of the OUTPUT, which must be what the plan asked for (size, codec, colour,
// constant 30 fps, no audio) or the import fails. ffmpeg's text (its stderr names paths and prints what the file wrote) never leaves this
// module: a refusal is a reason from the contract, never a message.
//
// WHAT IT OWES THE JOB. The `signal` (3f.1b review): on an abort ffmpeg is killed, and the call settles only once the child has exited
// (`runFfmpegArgv`), so a late importer cannot go on writing a multi-GB file nobody owns. The work file is the job's name inside the staging
// folder (`request.workFile()`), released here on every way out that is not a success; the job releases it again whatever happens.

/** A 30 fps clip of this many frames is the longest the mezzanine can be; a bit over, for the rounding of the last frame. */
const MAX_OUTPUT_FRAMES = VIDEO_LIMITS.maxSeconds * VIDEO_LIMITS.fps + 1;
/** The rate the mezzanine is written at; its own `stts` may round it a little. */
const RATE_TOLERANCE = 0.05;

export interface VideoImporterOptions {
  /** Starts ffmpeg; Node's `spawn` by default (a test injects a wrapper). */
  readonly spawner?: FfmpegSpawner;
  /** Runs one ffmpeg argv under supervision; `runFfmpegArgv` by default (a test injects a fake). */
  readonly run?: typeof runFfmpegArgv;
  /** Overrides the plan's wall-clock limit (a test). */
  readonly timeoutMs?: number;
}

/** Whether what ffmpeg wrote is what the plan asked for; the walker's reading of it, never ffmpeg's. */
function isPlannedOutput(info: VideoInfo, plan: VideoPlan): boolean {
  const { video } = info;
  const expected = expectedFrames(plan.info);
  return (
    video.codec === "h264" &&
    video.width === plan.outWidth &&
    video.height === plan.outHeight &&
    video.rotation === 0 &&
    video.dynamicRange === "sdr" &&
    video.colour.tagged &&
    video.colour.primaries === 1 &&
    video.colour.transfer === 1 &&
    video.colour.matrix === 1 &&
    !video.colour.fullRange &&
    !video.variableFrameRate &&
    Math.abs(video.sourceFps - VIDEO_LIMITS.fps) <= RATE_TOLERANCE &&
    video.samples >= 1 &&
    video.samples <= MAX_OUTPUT_FRAMES &&
    // The decode must be the clip that was judged: its frame count is what ffmpeg makes of the samples AND the edit list the walker read (see
    // `expectedFrames`). A different stream, or a table that lied, lands outside it.
    video.samples >= expected.min &&
    video.samples <= expected.max &&
    info.audioTracks === 0
  );
}

export function createVideoImporter(options: VideoImporterOptions = {}): MediaImporter {
  const run = options.run ?? runFfmpegArgv;
  return async ({ staged, signal, workFile }) => {
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    // The container is the BYTES' (the staging sniffed it); only MP4 and MOV walk here. A WebM never gets this far: its bytes are no MP4.
    if (staged.format !== "mp4" && staged.format !== "mov") return { ok: false, reason: "format" };
    if (staged.bytes > MEDIA_BYTE_CAPS.video) return { ok: false, reason: "too-large" };

    const opened = await openFileSource(staged.path);
    let judged: VideoJudgement;
    try {
      // The job copied exactly `staged.bytes`; a different size means the copy is not the one it made.
      if (opened.source.size !== staged.bytes) return { ok: false, reason: "failed" };
      judged = judgeVideo(await probeVideo(opened.source), staged.bytes);
    } finally {
      await opened.close();
    }
    if (!judged.ok) return { ok: false, reason: judged.reason };
    const { plan } = judged;
    if (signal.aborted) return { ok: false, reason: "cancelled" };

    const work = await workFile();
    const fail = async (reason: "failed" | "cancelled"): Promise<{ ok: false; reason: "failed" | "cancelled" }> => {
      await work.release();
      return { ok: false, reason };
    };
    try {
      await run({
        argv: videoArgs(staged.path, plan, work.path),
        output: work.path,
        signal,
        timeoutMs: options.timeoutMs ?? plan.timeoutMs,
        ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      });
    } catch {
      // ffmpeg's own words (a path, a string the file wrote) stay here: the owner is told a reason, never a message.
      return fail(signal.aborted ? "cancelled" : "failed");
    }
    if (signal.aborted) return fail("cancelled");

    // What ffmpeg wrote is judged by the same walker that judged what it read.
    let made: VideoInfo | undefined;
    const written = await openFileSource(work.path).catch(() => undefined);
    if (written === undefined) return fail("failed");
    try {
      const probe = await probeVideo(written.source);
      if (probe.ok) made = probe.info;
    } finally {
      await written.close();
    }
    if (made === undefined || !isPlannedOutput(made, plan)) return fail("failed");
    if (!((await stat(work.path).then((info) => info.size, () => 0)) > 0)) return fail("failed");

    return {
      ok: true,
      facts: {
        width: made.video.width,
        height: made.video.height,
        durationMs: Math.max(1, Math.round((made.video.samples * 1000) / VIDEO_LIMITS.fps)),
        sourceFps: plan.info.video.sourceFps,
        hdrToSdr: plan.hdrToSdr,
        loopFrames: null,
        delayFrames: null,
      },
      output: { file: work, format: "mp4" },
    };
  };
}
