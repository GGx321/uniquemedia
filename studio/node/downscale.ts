import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { ffmpegPath } from "./ffmpegBinary";
import { FfmpegError } from "./runFfmpeg";

/**
 * The slice of `node:child_process`'s `spawn` (and the `ChildProcess` it
 * returns) `downscaleToJpeg` actually uses. A test seam: the real `spawn`
 * satisfies this structurally, so production code never passes it; tests
 * inject a scripted fake instead of a real ffmpeg process — a shell stub
 * would not behave the same way on Windows, which is exactly the platform
 * the retry below exists for.
 */
export interface SpawnLike {
  (command: string, args: string[], options: { env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean }): {
    stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
    stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
    stdin: { on(event: "error", listener: () => void): void; end(bytes: Uint8Array): void };
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
    kill(signal: string): void;
    exitCode: number | null;
  };
}

export interface DownscaleOptions {
  /** The longest side of the result, in px; a smaller image keeps its size. */
  maxSide: number;
  /** Aborting kills ffmpeg and rejects with the signal's reason (a cancel, or the caller's timeout). */
  signal?: AbortSignal;
  /** The decoder refuses an image of more pixels than this (it counts its aligned buffer, a few px wider than the image). */
  maxPixels?: number;
  /** Test seam: defaults to `node:child_process`'s real `spawn`. */
  spawn?: SpawnLike;
}

/**
 * 16 MP (4096²): far above any image a job asks for (a 2K 9:16 frame is
 * 4.5 MP), far below what would let a hostile header make ffmpeg allocate gigabytes.
 */
export const MAX_SOURCE_PIXELS = 16_777_216;

/** A 768 px JPEG is a few hundred KB; anything near this is not one. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL = 2_000;

/** Exported so other decoders that pipe an in-memory image through ffmpeg (pdqPixels.ts's PDQ decode) sniff it the same way, instead of a second, possibly drifting copy of this check. */
export type InputFormat = "png_pipe" | "jpeg_pipe" | "webp_pipe";

export function inputFormat(bytes: Uint8Array): InputFormat | null {
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
 * A tiny (48×64, 160-byte) solid-grey PNG for a cheap preflight (M8) — real,
 * if small; never a degenerate 1×1. A 1×1 pixel used to sit here and failed
 * deterministically on Windows CI (run 36272376999: ffmpeg exit 5/116, empty
 * stderr even after the retry, while every real-size PNG/JPEG/WebP
 * downscale test passed there) — most likely a pipe/EOF race in the Windows
 * ffmpeg build once the whole 68-byte input (and then some) fits in a
 * single read. A 1×1 input is not a production case either way: every real
 * portrait this pipeline actually downscales is 1K.
 */
export const PREFLIGHT_IMAGE = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAUklEQVR4nO3OoQEAIAzAsF3O7fiZSBDNBZnzmXkd2ApJISkkhaSQFJJCUkgKSSEpJIWkkBSSQlJICkkhKSSFpJAUkkJSSApJISkkhaSQFJJCcgH2l7kA8mp9OAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * Downscales `PREFLIGHT_IMAGE` through the exact same ffmpeg spawn a paid
 * image would take (M8): a broken or missing ffmpeg binary, or one that
 * cannot write pipe:1 for any other reason, is caught here — cheaply,
 * before a single request is sent — instead of discovered one paid image at
 * a time mid-batch. Resolves on a healthy decoder; otherwise rejects with
 * the same error a real slot's downscale would raise.
 */
export function preflightDownscale(signal?: AbortSignal): Promise<void> {
  return downscaleToJpeg(PREFLIGHT_IMAGE, { maxSide: 64, signal }).then(() => undefined);
}

/** One spawn's outcome: success, or a failure with whether it is worth retrying (see `downscaleToJpeg`'s retry comment). */
type Attempt = { ok: true; bytes: Uint8Array } | { ok: false; retryable: boolean; error: unknown };

/** How long a Windows-only, AV-or-handle-release flake (see `downscaleToJpeg`'s comment) needs before a retry has a real chance. */
const RETRY_DELAY_MS = 200;

/** Resolves after `ms`, or rejects with the signal's reason as soon as it fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One ffmpeg spawn: never rejects for an ordinary ffmpeg failure (an `Attempt`, for the caller to decide whether it is worth retrying); still rejects for a signal abort, so the caller's own cancel/timeout is never swallowed. */
function attemptDownscale(doSpawn: SpawnLike, args: string[], env: Record<string, string>, bytes: Uint8Array, maxSide: number, signal: AbortSignal | undefined): Promise<Attempt> {
  return new Promise<Attempt>((resolve, reject) => {
    const child = doSpawn(ffmpegPath(), args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrTail = "";
    let aborted = false;
    // Why the child was stopped or could not start; `close` settles with it, since it always follows.
    let failure: { reason: unknown } | null = null;
    const stop = (reason: unknown): void => {
      failure ??= { reason };
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const onAbort = (): void => {
      aborted = true;
      stop(signal?.reason);
    };
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
      if (aborted) return reject(failure?.reason);
      if (failure !== null) return resolve({ ok: false, retryable: false, error: failure.reason });
      if (code !== 0) {
        const how = code !== null ? `code ${code}` : `signal ${closeSignal ?? "unknown"}`;
        const error = new FfmpegError(`ffmpeg exited with ${how}`, code, stderrTail);
        // A real decode failure always prints something with -loglevel
        // error; a non-zero exit with NOTHING on stderr at all is a
        // Windows-only flake's own signature (most likely a pipe/EOF race in
        // the Windows ffmpeg build, not — as first suspected — an AV lock
        // after another process's ffmpeg.exe was SIGKILLed: real-size
        // PNG/JPEG/WebP downscales never showed it, only a 1×1 input did) —
        // worth one retry, never a second (see downscaleToJpeg).
        return resolve({ ok: false, retryable: stderrTail.trim() === "", error });
      }
      const out = new Uint8Array(Buffer.concat(chunks));
      if (!isJpeg(out)) return resolve({ ok: false, retryable: false, error: new Error("ffmpeg did not write a JPEG") });
      resolve({ ok: true, bytes: out });
    });
    child.stdin.end(bytes);
  });
}

/**
 * An image (PNG, JPEG or WebP) as a JPEG no larger than `maxSide` on its long
 * side, aspect kept, never upscaled (the spike's `downscaledJpeg`, q≈90). The
 * bytes go to ffmpeg through its stdin and come back through its stdout:
 * an image no age check has seen yet is never written to disk, so a crash
 * cannot leave one behind.
 *
 * Retries once, after `RETRY_DELAY_MS`, when ffmpeg exited non-zero with no
 * stderr output at all — a Windows-only flake, most likely a pipe/EOF race
 * in the Windows ffmpeg build rather than the AV-lock theory first suspected
 * (see PREFLIGHT_IMAGE's own comment); never a genuine decode failure (a
 * real one always prints something with `-loglevel error`), and never after
 * an abort or the caller's own timeout: the delay and the retried attempt
 * both still run under the same `signal`.
 */
export async function downscaleToJpeg(bytes: Uint8Array, opts: DownscaleOptions): Promise<Uint8Array> {
  const { maxSide, signal } = opts;
  if (!Number.isSafeInteger(maxSide) || maxSide < 1) throw new RangeError(`maxSide must be a positive integer, got ${maxSide}`);
  const format = inputFormat(bytes);
  if (format === null) throw new TypeError("the image is not a PNG, JPEG or WebP");
  if (signal?.aborted) throw signal.reason;
  const { args, env } = downscaleCommand(format, maxSide, opts.maxPixels ?? MAX_SOURCE_PIXELS);
  // node:child_process's real spawn is overloaded far beyond the one 3-arg
  // shape used here, which TypeScript's overload matching does not resolve
  // against a single-signature interface — the cast is only that mismatch;
  // the real function satisfies SpawnLike for every call this file makes.
  const doSpawn: SpawnLike = opts.spawn ?? (spawn as SpawnLike);

  const first = await attemptDownscale(doSpawn, args, env, bytes, maxSide, signal);
  if (first.ok) return first.bytes;
  if (!first.retryable || signal?.aborted) throw first.error;
  await delay(RETRY_DELAY_MS, signal);
  const second = await attemptDownscale(doSpawn, args, env, bytes, maxSide, signal);
  if (second.ok) return second.bytes;
  throw second.error;
}
