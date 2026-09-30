import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { configuredFfmpegEnv } from "../../node/ffmpegEnv";
import { ffmpegPath } from "../../node/ffmpegBinary";
import type { FfmpegSpawner } from "../../node/runFfmpeg";

// The second gate of invariant 31's acceptance: the box walker (`mp4aProbe.ts`) says the container holds one AAC stream,
// and this proves the samples are audio of about the length the list claimed. ffmpeg decodes the staged file to raw mono
// samples on a pipe, and the same pass yields the waveform `music.peaks` serves (one value per 50 ms, 0..1000).
//
// What bounds it, because the file is untrusted:
// - it reads a FILE the store wrote (an absolute path built from an id, never from the network), never a URL;
// - `-f mov` forces the MP4 demuxer, so neither the extension nor the content can select another one, and
//   `-protocol_whitelist file` allows only the file protocol, so a data reference cannot make ffmpeg open a URL, a pipe
//   or another file (the walker refuses those too: this is the second line);
// - `-t` cuts the decode at the claimed length plus a margin, the output is capped at the same bound, and the whole run
//   has a time limit after which ffmpeg is killed (SIGKILL) and waited for;
// - only the first audio stream is read, and no video, subtitle or data stream;
// - the child gets the engine's allowlisted environment (S4), never the parent's.

export const PEAK_STEP_MS = 50;
const SAMPLE_RATE = 4000;
const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_BUCKET = (SAMPLE_RATE * PEAK_STEP_MS) / 1000;
/** No track is longer than ten minutes; the decode is never asked for more than a quarter hour. */
const MAX_DECODE_SECONDS = 900;
export const DECODE_TIMEOUT_MS = 30_000;
/** One allocation may take at most this much: 64 MiB is far above what a real track needs and far below a container bomb. */
const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

export type DecodeFailureKind = "spawn" | "exit" | "timeout" | "aborted" | "too-long" | "no-audio" | "duration-mismatch";

/** A decode that did not prove the file is audio of the claimed length. `message` names the kind, never a path or ffmpeg's own text. */
export class DecodeError extends Error {
  readonly kind: DecodeFailureKind;
  constructor(kind: DecodeFailureKind, detail = "") {
    super(detail === "" ? kind : `${kind}: ${detail}`);
    this.name = "DecodeError";
    this.kind = kind;
  }
}

export interface DecodeResult {
  /** The decoded length, from the number of samples ffmpeg wrote. */
  readonly decodedMs: number;
  /** One value per 50 ms of the track, 0..1000: the largest sample in that step. */
  readonly peaks: readonly number[];
}

export interface DecodeOptions {
  /** Absolute path of the staged file. */
  path: string;
  /** The length the list claimed (`duration_in_ms`). */
  expectedMs: number;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Starts ffmpeg; Node's `spawn` by default (a test injects a scripted one). */
  spawner?: FfmpegSpawner;
}

const nodeSpawner: FfmpegSpawner = (command, args, options) => {
  const { env, ...rest } = options;
  return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
};

/** The tolerance between the claim and the decode: an AAC file's priming and padding are tens of ms; a claim can be a little rounded. */
export function durationTolerance(expectedMs: number): number {
  return Math.max(2000, expectedMs * 0.05);
}

export function decodeAudio(options: DecodeOptions): Promise<DecodeResult> {
  if (!isAbsolute(options.path)) return Promise.reject(new TypeError("decodeAudio: the path must be absolute"));
  if (options.signal.aborted) return Promise.reject(new DecodeError("aborted"));
  const timeoutMs = options.timeoutMs ?? DECODE_TIMEOUT_MS;
  const seconds = Math.min(MAX_DECODE_SECONDS, Math.ceil((options.expectedMs / 1000) * 1.05) + 5);
  const maxBytes = (seconds + 2) * SAMPLE_RATE * BYTES_PER_SAMPLE;
  const args = [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-threads",
    "1",
    "-max_alloc",
    String(MAX_ALLOC_BYTES),
    "-protocol_whitelist",
    "file",
    "-f",
    "mov",
    // The AAC decoder for the stream, and no other: a stream that is not AAC ends with no output.
    "-c:a",
    "aac",
    "-t",
    String(seconds),
    "-i",
    options.path,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "s16le",
    "pipe:1",
  ];
  const spawner = options.spawner ?? nodeSpawner;

  return new Promise<DecodeResult>((resolve, reject) => {
    let child: ReturnType<FfmpegSpawner>;
    try {
      child = spawner(ffmpegPath(), args, { cwd: undefined, env: configuredFfmpegEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return reject(new DecodeError("spawn", "ffmpeg could not be started"));
    }
    let failure: DecodeError | null = null;
    const stop = (error: DecodeError): void => {
      failure ??= error;
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new DecodeError("timeout", `no result within ${timeoutMs} ms`)), timeoutMs);
    const onAbort = (): void => stop(new DecodeError("aborted"));
    options.signal.addEventListener("abort", onAbort, { once: true });

    const peaks: number[] = [];
    let bucketMax = 0;
    let bucketSamples = 0;
    let samples = 0;
    let written = 0;
    let odd: number | null = null;
    const takeSample = (value: number): void => {
      samples++;
      const magnitude = Math.min(1000, Math.round((Math.abs(value) * 1000) / 32768));
      if (magnitude > bucketMax) bucketMax = magnitude;
      if (++bucketSamples === SAMPLES_PER_BUCKET) {
        peaks.push(bucketMax);
        bucketMax = 0;
        bucketSamples = 0;
      }
    };
    child.stdout?.on("data", (chunk: Uint8Array) => {
      written += chunk.byteLength;
      if (written > maxBytes) return stop(new DecodeError("too-long", `wrote more than ${maxBytes} bytes for a claimed ${options.expectedMs} ms`));
      if (failure !== null) return;
      let at = 0;
      if (odd !== null && chunk.byteLength > 0) {
        takeSample((((chunk[0] ?? 0) << 8) | odd) << 16 >> 16);
        odd = null;
        at = 1;
      }
      for (; at + 1 < chunk.byteLength; at += 2) takeSample((((chunk[at + 1] ?? 0) << 8) | (chunk[at] ?? 0)) << 16 >> 16);
      if (at < chunk.byteLength) odd = chunk[at] ?? 0;
    });
    // Drained and dropped: ffmpeg's own text can carry the path, and a child that fills its stderr pipe would block.
    child.stderr?.on("data", () => undefined);
    child.on("error", () => stop(new DecodeError("spawn", "ffmpeg could not be run")));
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (failure !== null) return reject(failure);
      if (code !== 0) return reject(new DecodeError("exit", `ffmpeg exited with ${code === null ? "a signal" : `code ${code}`}`));
      if (samples === 0) return reject(new DecodeError("no-audio"));
      if (bucketSamples > 0) peaks.push(bucketMax);
      const decodedMs = Math.round((samples * 1000) / SAMPLE_RATE);
      if (Math.abs(decodedMs - options.expectedMs) > durationTolerance(options.expectedMs)) {
        return reject(new DecodeError("duration-mismatch", `decoded ${decodedMs} ms of a claimed ${options.expectedMs} ms`));
      }
      resolve({ decodedMs, peaks });
    });
  });
}
