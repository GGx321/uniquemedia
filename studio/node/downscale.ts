import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { ffmpegPath } from "./ffmpegBinary";
import { FfmpegError } from "./runFfmpeg";

export interface DownscaleOptions {
  /** The longest side of the result, in px; a smaller image keeps its size. */
  maxSide: number;
  /** Aborting kills ffmpeg and rejects with the signal's reason (a cancel, or the caller's timeout). */
  signal?: AbortSignal;
  /** The decoder refuses an image of more pixels than this (it counts its aligned buffer, a few px wider than the image). */
  maxPixels?: number;
}

/**
 * 16 MP (4096²): far above any image a job asks for (a 2K 9:16 frame is
 * 4.5 MP), far below what would let a hostile header make ffmpeg allocate gigabytes.
 */
export const MAX_SOURCE_PIXELS = 16_777_216;

/** A 768 px JPEG is a few hundred KB; anything near this is not one. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL = 2_000;

type InputFormat = "png_pipe" | "jpeg_pipe" | "webp_pipe";

function inputFormat(bytes: Uint8Array): InputFormat | null {
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "png_pipe";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg_pipe";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp_pipe";
  return null;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * The ffmpeg command line and environment: one input read from stdin in the
 * sniffed format only (`-protocol_whitelist pipe`, so nothing inside the
 * image can make ffmpeg open a file or a URL), a decoder pixel cap, one
 * frame out as a JPEG on stdout. The environment is explicitly empty: the
 * app's (OPENROUTER_* included) never reaches the child (invariant 10).
 */
export function downscaleCommand(input: InputFormat, maxSide: number, maxPixels: number): { args: string[]; env: Record<string, string> } {
  return {
    args: [
      "-hide_banner",
      "-loglevel", "error",
      "-protocol_whitelist", "pipe",
      "-max_pixels", String(maxPixels),
      "-f", input,
      "-i", "pipe:0",
      "-frames:v", "1",
      "-vf", `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
      "-pix_fmt", "yuvj420p",
      "-q:v", "3",
      "-f", "mjpeg",
      "pipe:1",
    ],
    // Passed empty. On Windows libuv adds the system variables a process
    // needs (SYSTEMROOT, TEMP, ...) from the parent when they are missing, so
    // ffmpeg gets only those there; elsewhere it gets none.
    env: {},
  };
}

/**
 * An image (PNG, JPEG or WebP) as a JPEG no larger than `maxSide` on its long
 * side, aspect kept, never upscaled (the spike's `downscaledJpeg`, q≈90). The
 * bytes go to ffmpeg through its stdin and come back through its stdout:
 * an image no age check has seen yet is never written to disk, so a crash
 * cannot leave one behind.
 */
export function downscaleToJpeg(bytes: Uint8Array, opts: DownscaleOptions): Promise<Uint8Array> {
  const { maxSide, signal } = opts;
  if (!Number.isSafeInteger(maxSide) || maxSide < 1) return Promise.reject(new RangeError(`maxSide must be a positive integer, got ${maxSide}`));
  const format = inputFormat(bytes);
  if (format === null) return Promise.reject(new TypeError("the image is not a PNG, JPEG or WebP"));
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { args, env } = downscaleCommand(format, maxSide, opts.maxPixels ?? MAX_SOURCE_PIXELS);

  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrTail = "";
    // Why the child was stopped or could not start; `close` settles with it, since it always follows.
    let failure: { reason: unknown } | null = null;
    const stop = (reason: unknown): void => {
      failure ??= { reason };
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const onAbort = (): void => stop(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) stop(new Error(`ffmpeg wrote more than ${MAX_OUTPUT_BYTES} bytes for a ${maxSide} px JPEG`));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    // EPIPE when ffmpeg exits before it read all of stdin (e.g. a refused image): its exit code says why.
    child.stdin.on("error", () => {});
    child.on("error", (error) => stop(error));
    child.on("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (failure !== null) return reject(failure.reason);
      if (code !== 0) {
        const how = code !== null ? `code ${code}` : `signal ${closeSignal ?? "unknown"}`;
        return reject(new FfmpegError(`ffmpeg exited with ${how}`, code, stderrTail));
      }
      const out = new Uint8Array(Buffer.concat(chunks));
      if (!isJpeg(out)) return reject(new Error("ffmpeg did not write a JPEG"));
      resolve(out);
    });
    child.stdin.end(bytes);
  });
}
