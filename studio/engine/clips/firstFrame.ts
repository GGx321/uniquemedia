import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipModelChoice, ClipQuality } from "../../shared/engine";
import { downscaleToJpeg, inputFormat, MAX_SOURCE_PIXELS } from "../../node/downscale";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";
import { imageSize } from "../library/media";

// Stage 5, 5b.1, S5.V4b (plan s5b1 §5.5, «The first frame»): the photo, as the JPEG the provider is given. It is scaled to fit the clip's output and NEVER upscaled: std and Grok 720 x 1280,
// pro 1080 x 1920 (a 1152 x 2048 Seedream still shrinks, a 720 x 1280 Grok still stays). A photo within 2 % of 9:16 (the catalogue's untested models may be a few pixels off) is
// centre-cropped to exactly 9:16 first; beyond that it is `not-vertical`. Pure over bytes: the only file it makes is a temp pair for the crop, in the folder it is given, removed on every path.

export interface FirstFrameSize {
  readonly width: number;
  readonly height: number;
}

/** The size the provider is shown: 1080 x 1920 for Kling pro, 720 x 1280 for everything else (Kling std, and Grok whatever the sheet said). */
export function firstFrameSize(model: ClipModelChoice, quality: ClipQuality): FirstFrameSize {
  return model === "kling" && quality === "pro" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}

export type FirstFrame =
  | {
      readonly ok: true;
      readonly jpeg: Uint8Array;
      /** The JPEG's real size: smaller than `firstFrameSize` when the photo was smaller. */
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly reason: "photo-unreadable" | "not-vertical" };

export interface MakeFirstFrameOptions {
  readonly photo: Uint8Array;
  readonly model: ClipModelChoice;
  readonly quality: ClipQuality;
  /** A folder that exists, for the crop's two temp files (the clips folder); left as it was found. */
  readonly scratchDir: string;
  /** Aborting rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Test seam: a scripted ffmpeg for the crop. */
  readonly spawner?: FfmpegSpawner;
}

/** How far a photo may be from 9:16 to be cropped rather than refused: 2 % of the ratio. */
const MAX_OFF_PERCENT = 2;
const CROP_TIMEOUT_MS = 30_000;

/** `|w/h - 9/16| / (9/16) <= 2 %`, in whole numbers: `100 |16 w - 9 h| <= 2 * 9 h`. */
function nearNineSixteen(width: number, height: number): boolean {
  return 100 * Math.abs(16 * width - 9 * height) <= MAX_OFF_PERCENT * 9 * height;
}

/** The decoder or the encoder refused the picture; anything else (a missing binary, a full disk) is not a verdict on the photo. */
function refusedPicture(error: unknown): boolean {
  return (error instanceof FfmpegError && !(error instanceof FfmpegTimeoutError)) || error instanceof TypeError;
}

/** The largest exactly-9:16 rectangle inside the photo, centred. */
function centredNineSixteen(width: number, height: number): { width: number; height: number } | null {
  const k = Math.min(Math.floor(width / 9), Math.floor(height / 16));
  return k < 1 ? null : { width: 9 * k, height: 16 * k };
}

async function cropToPng(
  photo: Uint8Array,
  format: string,
  crop: { width: number; height: number },
  scratchDir: string,
  signal: AbortSignal | undefined,
  spawner: FfmpegSpawner | undefined,
): Promise<Uint8Array> {
  // The library's temp convention (a dot, `.tmp` at the end), so a sweep after a crash finds what a killed job left.
  const stem = join(scratchDir, `.${randomBytes(6).toString("hex")}`);
  const input = `${stem}.in.tmp`;
  const output = `${stem}.crop.png.tmp`;
  try {
    await writeFile(input, photo);
    await runFfmpegArgv({
      argv: [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-protocol_whitelist", "file",
        "-max_pixels", String(MAX_SOURCE_PIXELS),
        "-f", format,
        "-i", input,
        "-frames:v", "1",
        "-vf", `crop=${crop.width}:${crop.height}`,
        "-c:v", "png",
        "-update", "1",
        "-f", "image2",
        output,
      ],
      output,
      timeoutMs: CROP_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      ...(spawner === undefined ? {} : { spawner }),
    });
    return new Uint8Array(await readFile(output));
  } finally {
    await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
  }
}

/**
 * Why the photo cannot be a first frame, read from its header alone (no decode, no ffmpeg), or null: `photo-unreadable` for bytes that are not an image the first frame can read,
 * `not-vertical` beyond 2 % of 9:16. `clips.options` and `clips.create` ask it before any money (S5.V4a1); `makeFirstFrame` asks it first, so the two never disagree on a header.
 */
export function firstFrameRefusalOf(photo: Uint8Array): Extract<FirstFrame, { ok: false }>["reason"] | null {
  const size = imageSize(photo);
  if (inputFormat(photo) === null || size === null) return "photo-unreadable";
  return nearNineSixteen(size.width, size.height) ? null : "not-vertical";
}

/** The photo as the first frame of a clip, or why it cannot be one. Rejects only for an abort or a failure that is not a verdict on the photo. */
export async function makeFirstFrame(options: MakeFirstFrameOptions): Promise<FirstFrame> {
  const { photo, signal } = options;
  if (signal?.aborted) throw signal.reason;
  const refusal = firstFrameRefusalOf(photo);
  if (refusal !== null) return { ok: false, reason: refusal };
  const format = inputFormat(photo);
  const size = imageSize(photo);
  if (format === null || size === null) return { ok: false, reason: "photo-unreadable" };
  const target = firstFrameSize(options.model, options.quality);
  try {
    let source = photo;
    if (16 * size.width !== 9 * size.height) {
      const crop = centredNineSixteen(size.width, size.height);
      if (crop === null) return { ok: false, reason: "photo-unreadable" };
      source = await cropToPng(photo, format, crop, options.scratchDir, signal, options.spawner);
    }
    const jpeg = await downscaleToJpeg(source, { maxSide: target.height, ...(signal === undefined ? {} : { signal }) });
    const made = imageSize(jpeg);
    if (made === null) return { ok: false, reason: "photo-unreadable" };
    return { ok: true, jpeg, width: made.width, height: made.height };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (refusedPicture(error)) return { ok: false, reason: "photo-unreadable" };
    throw error;
  }
}
