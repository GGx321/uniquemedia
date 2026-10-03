import { spawn } from "node:child_process";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { configuredFfmpegEnv } from "../../node/ffmpegEnv";
import { FfmpegError, FfmpegTimeoutError, STDERR_ERROR_TAIL, type FfmpegSpawner } from "../../node/runFfmpeg";
import { parseTruePeak, type MusicMeasureJob } from "../render/musicChain";

// Runs the true-peak pass of a render's music (3c.5): ffmpeg over the stored track's clip segment with ebur128, to a null
// output, and the peak read from its summary on stderr. Once per render, before pass 1, so a track ffmpeg cannot read fails
// the job in a second rather than after the photos were rendered.
//
// The input is untrusted media: the argv carries the store's hardening (`musicChain.ts`), the child gets the engine's
// allowlisted environment (S4), and the run is bounded in time, in what it reads and in the stderr it keeps. ffmpeg's text can
// carry the track's path, so a failure here reaches the caller as the exit code and a tail the RUNNER scrubs, like pass 2's.

/** Only the end of stderr is kept: the summary is at the end, and a long track's per-block lines are not wanted. */
const KEEP_STDERR_CHARS = 16 * 1024;

const nodeSpawner: FfmpegSpawner = (command, args, options) => {
  const { env, ...rest } = options;
  return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
};

export interface MeasureOptions {
  readonly signal: AbortSignal;
  /** The child is killed (`SIGKILL`) and the call rejects with an `FfmpegTimeoutError` after this long. */
  readonly timeoutMs: number;
  /** Node's `spawn` unless a test scripts the child. */
  readonly spawner?: FfmpegSpawner;
}

/**
 * The true peak, in dBTP, of the segment `job` describes (`-inf` for silence). Rejects with the signal's own reason for a cancel,
 * an `FfmpegTimeoutError` past `timeoutMs`, an `FfmpegError` when ffmpeg cannot start or exits non-zero, and a
 * `RenderGraphError("BAD_AUDIO")` when it exits 0 with no peak to read.
 */
export function measureTruePeak(job: MusicMeasureJob, options: MeasureOptions): Promise<number> {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(signal.reason);
  const spawner = options.spawner ?? nodeSpawner;
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<FfmpegSpawner>;
    try {
      child = spawner(ffmpegPath(), job.argv, { cwd: undefined, env: configuredFfmpegEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // A spawn error names the binary's path in its text.
      return reject(new FfmpegError("ffmpeg could not be started", null, ""));
    }
    let stop: (() => Error) | null = null;
    const halt = (error: () => Error): void => {
      stop ??= error;
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => halt(() => new FfmpegTimeoutError(options.timeoutMs, tail())), options.timeoutMs);
    const onAbort = (): void => halt(() => (signal.reason instanceof Error ? signal.reason : new Error("the render was cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });

    let text = "";
    const tail = (): string => text.slice(-STDERR_ERROR_TAIL);
    child.stderr?.on("data", (chunk: Uint8Array) => {
      text += Buffer.from(chunk).toString("utf8");
      if (text.length > KEEP_STDERR_CHARS * 2) text = text.slice(-KEEP_STDERR_CHARS);
    });
    child.stdout?.on("data", () => undefined);
    child.on("error", () => halt(() => new FfmpegError("ffmpeg could not be run", null, "")));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (stop !== null) return reject(stop());
      if (code !== 0) return reject(new FfmpegError(`ffmpeg exited with ${code === null ? "a signal" : `code ${code}`} while measuring the music`, code, tail()));
      try {
        resolve(parseTruePeak(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}
