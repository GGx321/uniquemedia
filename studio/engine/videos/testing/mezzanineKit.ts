import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "../../../node/ffmpegBinary";
import { createVideoImporter } from "../../media/videoImporter";
import { requestFor, stage } from "../../media/video/testing/importKit";
import type { OwnVideoSource } from "../ownVideos";

// Test support for the own-video render (3f.3b): MEZZANINES made the way the product makes them, by 3f.3a's real importer, from raw frames written here, so a
// frame's content is known exactly. Test-only (`.testkit` in spirit): production code never imports it.

/** A raw 4:2:0 picture set: planar frames of 8-bit Y, then Cb, then Cr, `frames` of them. */
export interface RawVideo {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly bytes: Uint8Array;
}

type PlaneFill = (frame: number, x: number, y: number) => number;

function raw(width: number, height: number, frames: number, luma: PlaneFill, cb: PlaneFill, cr: PlaneFill): RawVideo {
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const frameSize = ySize + 2 * cSize;
  const bytes = new Uint8Array(frameSize * frames);
  for (let f = 0; f < frames; f++) {
    const base = f * frameSize;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes[base + y * width + x] = luma(f, x, y);
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) {
        bytes[base + ySize + y * (width / 2) + x] = cb(f, x * 2, y * 2);
        bytes[base + ySize + cSize + y * (width / 2) + x] = cr(f, x * 2, y * 2);
      }
    }
  }
  return { width, height, frames, bytes };
}

/** Frame `i` is a flat grey of luma `16 + 2 * i`: a frame's number can be read back from any pixel of it (`lumaOf`), up to 109 frames. */
export const rampFrames = (width: number, height: number, frames: number): RawVideo => raw(width, height, frames, (f) => 16 + 2 * f, () => 128, () => 128);

/** The frame number a decoded luma stands for in `rampFrames` (nearest). */
export const rampIndexOf = (luma: number): number => Math.round((luma - 16) / 2);

/** A flat colour in Y, Cb, Cr for every frame. */
export const flatFrames = (width: number, height: number, frames: number, y: number, cb: number, cr: number): RawVideo => raw(width, height, frames, () => y, () => cb, () => cr);

/**
 * A picture whose luma climbs along one axis, from 16 at the first column (or row) to about 216 at the last, the same in every frame: where a crop of it was taken from shows
 * in the decoded luma.
 */
export const gradientFrames = (width: number, height: number, frames: number, axis: "x" | "y"): RawVideo =>
  raw(width, height, frames, (_f, x, y) => 16 + Math.floor(((axis === "x" ? x : y) * 200) / ((axis === "x" ? width : height) - 1)), () => 128, () => 128);

/** What a made mezzanine is: where it is, its record's facts, its hash. */
export interface Mezzanine extends OwnVideoSource {
  readonly frames: number;
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * `source` (an mp4 the importer takes) through the REAL importer: the mezzanine as the library would store it, copied to `<dir>/<mediaId>.mp4`. The importer's own facts
 * are the source's `width`, `height` and `durationMs`.
 */
export async function importAsMezzanine(dir: string, mediaId: string, source: Uint8Array | Parameters<typeof stage>[1]): Promise<Mezzanine> {
  const workDir = join(dir, `import-${mediaId}`);
  await mkdir(workDir, { recursive: true });
  const rig = requestFor(workDir, await stage(workDir, source));
  const outcome = await createVideoImporter({})(rig.request);
  if (!outcome.ok || outcome.output === undefined) throw new Error(`the importer refused the source: ${outcome.ok ? "no output" : outcome.reason}`);
  const { width, height, durationMs } = outcome.facts;
  if (width === null || height === null || durationMs === null) throw new Error("the importer's facts have no size or length");
  const path = join(dir, `${mediaId}.mp4`);
  await copyFile(outcome.output.file.path, path);
  const bytes = new Uint8Array(await readFile(path));
  return { mediaId, path, sha256: sha(bytes), bytes: bytes.length, width, height, durationMs, frames: Math.round((durationMs * 30) / 1000) };
}

/** Raw frames, written as a near-lossless H.264 mp4 (tagged BT.709 limited), which the importer then takes as a source. */
export async function sourceFromRaw(dir: string, name: string, video: RawVideo): Promise<Uint8Array> {
  await mkdir(dir, { recursive: true });
  const rawPath = join(dir, `${name}.yuv`);
  const out = join(dir, `${name}.source.mp4`);
  await writeFile(rawPath, video.bytes);
  const run = spawnSync(
    ffmpegPath(),
    [
      "-hide_banner", "-loglevel", "error", "-y", "-nostdin",
      "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${video.width}x${video.height}`, "-r", "30", "-i", rawPath,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p", "-threads", "1",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      out,
    ],
    { maxBuffer: 1 << 26 },
  );
  if (run.status !== 0) throw new Error(`ffmpeg could not make the source: ${run.stderr.toString()}`);
  return new Uint8Array(await readFile(out));
}

/** Raw frames through the importer: the mezzanine of a picture whose every pixel is known. */
export async function mezzanineOf(dir: string, mediaId: string, video: RawVideo): Promise<Mezzanine> {
  return importAsMezzanine(dir, mediaId, await sourceFromRaw(dir, mediaId, video));
}

/**
 * The luma (as stored, limited range 16 to 235: no conversion to full range) of every frame of `path`, shrunk to `cols` x `rows` by area (a mean) and read back:
 * `frames[f][row * cols + col]`. `cols` and `rows` are even (4:2:0). ffmpeg decodes and shrinks; nothing else touches the pixels, so a flat frame reads back as its own luma
 * and a gradient reads as its bands.
 */
export function lumaGrid(path: string, cols: number, rows: number): number[][] {
  const run = spawnSync(
    ffmpegPath(),
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-vf", `scale=${cols}:${rows}:flags=area`, "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"],
    { maxBuffer: 1 << 28 },
  );
  if (run.status !== 0) throw new Error(`ffmpeg could not read the frames: ${run.stderr.toString()}`);
  const bytes = new Uint8Array(run.stdout);
  const lumaSize = cols * rows;
  const frameSize = lumaSize + 2 * (lumaSize / 4);
  return Array.from({ length: bytes.length / frameSize }, (_, f) => [...bytes.subarray(f * frameSize, f * frameSize + lumaSize)]);
}

/** The mean Y, Cb and Cr of the FIRST frame of `path` at its own size, decoded with no conversion but the pixel format. */
export function firstFrameMeans(path: string, width: number, height: number): [number, number, number] {
  const run = spawnSync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"], { maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`ffmpeg could not decode the frame: ${run.stderr.toString()}`);
  const bytes = new Uint8Array(run.stdout);
  const ySize = width * height;
  const cSize = ySize / 4;
  const mean = (from: number, length: number): number => {
    let sum = 0;
    for (let i = from; i < from + length; i++) sum += bytes[i] ?? 0;
    return sum / length;
  };
  return [mean(0, ySize), mean(ySize, cSize), mean(ySize + cSize, cSize)];
}
