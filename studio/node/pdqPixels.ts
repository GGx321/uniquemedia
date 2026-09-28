import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { ffmpegPath } from "./ffmpegBinary";
import { FfmpegError } from "./runFfmpeg";
import { inputFormat, MAX_SOURCE_PIXELS, type SpawnLike } from "./downscale";

export type { SpawnLike };

// T7a: the pdq gate's own decoder. PDQ's algorithm (src/core/pdq/pdq.ts's
// computePdqHash) takes exactly one 64x64 grayscale frame — the same shape
// the uniquifier's own gray-frame extraction already feeds it
// (src/node/ffmpegExecutor.ts, src/node/photoExecutor.ts:
// `scale=64:64,format=gray`), a plain non-aspect-preserving downscale, which
// is what PDQ's own algorithm expects (it does not letterbox). This is a
// second decoder, not a reuse of `downscale.ts`'s own JPEG one, because the
// output shape is entirely different (a fixed-size raw frame, not a
// variable-size JPEG) — but it shares `downscale.ts`'s input sniffing
// (`inputFormat`) and its exact ffmpeg spawn/retry shape (pipe in, pipe out,
// nothing written to disk, one retry on an empty-stderr non-zero exit — a
// Windows-only ffmpeg pipe/EOF flake, never a genuine decode failure; see
// downscale.ts's own PREFLIGHT_IMAGE comment for the full story).

/** 64x64, one byte per pixel: exactly what `computePdqHash` requires. */
export const PDQ_GRAY_FRAME_BYTES = 64 * 64;

export interface Gray64Options {
  signal?: AbortSignal;
  /** The decoder refuses an image of more pixels than this (it counts its aligned buffer, so the cap is approximate). */
  maxPixels?: number;
  /** Test seam: defaults to `node:child_process`'s real `spawn`. */
  spawn?: SpawnLike;
}

const STDERR_TAIL = 2_000;
/** However ffmpeg's raw output framing pads a 64x64 gray frame, it never comes close to this; well past it means something is badly wrong. */
const MAX_OUTPUT_BYTES = PDQ_GRAY_FRAME_BYTES * 16;
const RETRY_DELAY_MS = 200;

function isGray64(bytes: Uint8Array): boolean {
  return bytes.length === PDQ_GRAY_FRAME_BYTES;
}

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

/** One ffmpeg spawn: never rejects for an ordinary ffmpeg failure (an `Attempt`, for the caller to decide whether it is worth retrying); still rejects for a signal abort. */
type Attempt = { ok: true; bytes: Uint8Array } | { ok: false; retryable: boolean; error: unknown };

function attemptDecode(doSpawn: SpawnLike, args: string[], env: Record<string, string>, bytes: Uint8Array, signal: AbortSignal | undefined): Promise<Attempt> {
  return new Promise<Attempt>((resolve, reject) => {
    const child = doSpawn(ffmpegPath(), args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrTail = "";
    let aborted = false;
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
      if (outputBytes > MAX_OUTPUT_BYTES) stop(new Error(`ffmpeg wrote more than ${MAX_OUTPUT_BYTES} bytes for a 64x64 grayscale frame`));
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
        // Same Windows-only flake as downscale.ts's own decoder: a non-zero exit with
        // NOTHING on stderr at all (a real decode failure always prints something with
        // -loglevel error) is worth one retry, never a second.
        return resolve({ ok: false, retryable: stderrTail.trim() === "", error });
      }
      const out = new Uint8Array(Buffer.concat(chunks));
      if (!isGray64(out)) return resolve({ ok: false, retryable: false, error: new Error(`expected ${PDQ_GRAY_FRAME_BYTES} grayscale bytes, got ${out.length}`) });
      resolve({ ok: true, bytes: out });
    });
    child.stdin.end(bytes);
  });
}

/**
 * Decodes a PNG, JPEG or WebP (in memory; never written to disk) to a 64x64
 * grayscale frame for PDQ hashing. Rejects with a `TypeError` for bytes that
 * are none of those three, before ffmpeg ever runs; with the signal's own
 * reason on an abort (before spawning, or by killing ffmpeg mid-decode); and
 * otherwise with whatever ffmpeg's own failure was (`FfmpegError` for a
 * non-zero exit, a spawn error such as ENOENT when ffmpeg itself is missing).
 */
export async function decodeGray64(bytes: Uint8Array, opts: Gray64Options = {}): Promise<Uint8Array> {
  const { signal } = opts;
  const format = inputFormat(bytes);
  if (format === null) throw new TypeError("the image is not a PNG, JPEG or WebP");
  if (signal?.aborted) throw signal.reason;
  const maxPixels = opts.maxPixels ?? MAX_SOURCE_PIXELS;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-protocol_whitelist", "pipe",
    "-max_pixels", String(maxPixels),
    "-f", format,
    "-i", "pipe:0",
    "-frames:v", "1",
    "-vf", "scale=64:64,format=gray",
    "-f", "rawvideo",
    "pipe:1",
  ];
  // Passed empty, like downscale.ts's own command: no OPENROUTER_* (or anything
  // else of the app's) reaches this child process (invariant 10).
  const env: Record<string, string> = {};
  const doSpawn: SpawnLike = opts.spawn ?? (spawn as SpawnLike);

  const first = await attemptDecode(doSpawn, args, env, bytes, signal);
  if (first.ok) return first.bytes;
  if (!first.retryable || signal?.aborted) throw first.error;
  await delay(RETRY_DELAY_MS, signal);
  const second = await attemptDecode(doSpawn, args, env, bytes, signal);
  if (second.ok) return second.bytes;
  throw second.error;
}
