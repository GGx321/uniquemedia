import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";

// Stage 5, 5b.1, S5.V4b (plan s5b1 §5.10 and §5.11): the two things the engine takes out of a stored clip with ffmpeg. The frames the face check looks at (one every half second, at
// t = 0, 0.5, 1, ..., each a 720 x 1280 JPEG) and the poster (the frame at 0.5 s, 720 x 1280). Both read the library's own file, which the app's walker has already judged
// (validate.ts), and both run under the same bounds as every other ffmpeg that reads a file the app did not make:
// - `-protocol_whitelist file`, so nothing in the file can make ffmpeg open a URL, a pipe or another file;
// - `-f mov`, so neither the name nor the content can pick another demuxer;
// - no sound, subtitle or data stream is read, one decoder thread, a cap on one allocation, and a time bound after which ffmpeg is killed and waited for.

/** The frames the face check looks at are this far apart. */
export const FRAME_STEP_MS = 500;
export const FRAME_WIDTH = 720;
export const FRAME_HEIGHT = 1280;

/** A clip is at most 10 s, so at most 21 frames; a stray extra is never worth more than this. */
const MAX_FRAMES = 40;
const FRAMES_TIMEOUT_MS = 90_000;
const POSTER_TIMEOUT_MS = 30_000;
const POSTER_AT_SECONDS = 0.5;
/** One 1080 x 1920 frame is 3 MiB as 4:2:0; this is far above what a decode needs and far below what a hostile header could ask for. */
const MAX_ALLOC_BYTES = 512 * 1024 * 1024;

export interface FfmpegRunOptions {
  /** Aborting kills ffmpeg and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** ffmpeg is killed and the call rejects with `FfmpegTimeoutError` after this long. */
  readonly timeoutMs?: number;
  /** Test seam: a scripted child instead of the real ffmpeg. */
  readonly spawner?: FfmpegSpawner;
}

/** The head every call shares: the hardening, then the input. */
function inputHead(clipPath: string, extra: readonly string[] = []): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-threads", "1",
    "-max_alloc", String(MAX_ALLOC_BYTES),
    "-protocol_whitelist", "file",
    ...extra,
    "-f", "mov",
    "-i", clipPath,
    "-an", "-sn", "-dn",
  ];
}

const JPEG_OUTPUT = ["-pix_fmt", "yuvj420p", "-q:v", "3"];
// The providers' files are BT.709 limited range and a JPEG is read as BT.601 full range. `yuvj420p` alone changes only the range, which tints every frame, so the matrix is converted here.
const SCALE = `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc`;

function supervision(options: FfmpegRunOptions, timeoutMs: number): { timeoutMs: number; signal?: AbortSignal; spawner?: FfmpegSpawner } {
  return {
    timeoutMs: options.timeoutMs ?? timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
  };
}

export interface SampleFramesOptions extends FfmpegRunOptions {
  readonly clipPath: string;
  /** The probed length: the decode is cut a second after it. */
  readonly durationMs: number;
  /** A folder that exists (the clips folder). A temp folder is made in it and removed whatever happens. */
  readonly scratchDir: string;
}

/**
 * One frame every half second, in time order, each a 720 x 1280 JPEG: at least 10 from a 5 s clip and 20 from a 10 s one. Rejects when ffmpeg fails, is killed at its time bound
 * (`FfmpegTimeoutError`) or is aborted (the signal's reason); the temp folder is gone in every case.
 */
export async function sampleFrames(options: SampleFramesOptions): Promise<Uint8Array[]> {
  const folder = await mkdtemp(join(options.scratchDir, ".frames-"));
  try {
    const pattern = join(folder, "f%03d.jpg");
    await runFfmpegArgv({
      argv: [
        ...inputHead(options.clipPath, ["-t", String(options.durationMs / 1000 + 1)]),
        "-vf", `fps=${1000 / FRAME_STEP_MS},${SCALE}`,
        "-frames:v", String(MAX_FRAMES),
        ...JPEG_OUTPUT,
        pattern,
      ],
      output: pattern,
      ...supervision(options, FRAMES_TIMEOUT_MS),
    });
    const names = (await readdir(folder)).filter((name) => name.endsWith(".jpg")).sort();
    return await Promise.all(names.map(async (name) => new Uint8Array(await readFile(join(folder, name)))));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export interface MakePosterOptions extends FfmpegRunOptions {
  readonly clipPath: string;
  /** Where the JPEG is written; the caller names it (a temp name, renamed once the clip's file is durable) and owns it. */
  readonly outPath: string;
}

/** The poster: the frame at 0.5 s as a 720 x 1280 JPEG (a 1080p clip is scaled down). On any failure no file is left at `outPath`. */
export async function makePoster(options: MakePosterOptions): Promise<void> {
  try {
    await runFfmpegArgv({
      argv: [
        ...inputHead(options.clipPath, ["-ss", String(POSTER_AT_SECONDS)]),
        "-frames:v", "1",
        "-vf", SCALE,
        ...JPEG_OUTPUT,
        "-f", "mjpeg",
        options.outPath,
      ],
      output: options.outPath,
      ...supervision(options, POSTER_TIMEOUT_MS),
    });
  } catch (error) {
    await rm(options.outPath, { force: true });
    throw error;
  }
}
