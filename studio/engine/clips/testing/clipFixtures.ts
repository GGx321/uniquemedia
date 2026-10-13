import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { ffmpegPath } from "../../../node/ffmpegBinary";

// Test-only (S5.V4b): small clips made by the bundled ffmpeg from lavfi sources, so no binary is committed. A clip is black until 0.25 s and white after it, which
// lets a test tell the frame at 0 from the frame at 0.5 s. At the sizes used here a 10 s clip is a few tens of KB.

const TAGS_709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** The matrix and range the pixels are really converted with, and the tags the file carries about them (they agree, except where a name says `untagged`). */
const ENCODINGS = {
  "709tv": { matrix: "bt709", range: "tv", tags: [...TAGS_709, "-color_range", "tv"] },
  /** An HD file that says nothing: its pixels are BT.709, and readers must assume so. */
  "709untagged": { matrix: "bt709", range: "tv", tags: [] },
  "601tv": { matrix: "bt601", range: "tv", tags: ["-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-color_range", "tv"] },
  "709pc": { matrix: "bt709", range: "pc", tags: [...TAGS_709, "-color_range", "pc"] },
  /** PQ HDR tags over BT.2020 pixels. */
  pq: { matrix: "bt2020", range: "tv", tags: ["-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-color_range", "tv"] },
} as const;

export interface ClipSpec {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps?: number;
  readonly codec?: "h264" | "hevc";
  /** An AAC track, as Grok's files carry. */
  readonly audio?: boolean;
  /** Two video streams in one file. */
  readonly secondVideo?: boolean;
  /** Default true: `moov` before `mdat`, as the providers' files and the app's exports have it. */
  readonly faststart?: boolean;
  /** A flat colour (`0xRRGGBB`) tagged BT.709 limited range, as the providers' files are. */
  readonly patch?: string;
  /** How the patch is encoded and what the file says about it. Default `709tv`. */
  readonly encoding?: keyof typeof ENCODINGS;
  /** The picture is stored turned and shown upright by a rotation in the track header (the width and height are the SHOWN ones). */
  readonly rotate?: 90;
}

/** Runs the bundled ffmpeg with an argv array; throws with the stderr tail when it fails. */
export async function runFfmpegForFixture(argv: readonly string[]): Promise<void> {
  const proc = Bun.spawn([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...argv], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`);
}

/** The colour of a flat JPEG as a viewer reads it (a JPEG is BT.601 full range), by ffmpeg: [r, g, b]. */
export async function meanRgb(jpeg: Uint8Array): Promise<[number, number, number]> {
  const proc = Bun.spawn([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "jpeg_pipe", "-i", "pipe:0", "-vf", "crop=2:2:100:100,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], {
    stdin: jpeg,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([Bun.readableStreamToArrayBuffer(proc.stdout), Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0 || out.byteLength !== 12) throw new Error(`ffmpeg exited ${code} with ${out.byteLength} bytes: ${stderr.slice(-400)}`);
  const px = new Uint8Array(out);
  return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
}

/** The mean brightness (0-255) of a JPEG, by ffmpeg: a black frame is near 0 and a white one near 255. */
export async function meanLuma(jpeg: Uint8Array): Promise<number> {
  const proc = Bun.spawn([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "jpeg_pipe", "-i", "pipe:0", "-vf", "scale=1:1,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], {
    stdin: jpeg,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([Bun.readableStreamToArrayBuffer(proc.stdout), Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0 || out.byteLength !== 1) throw new Error(`ffmpeg exited ${code} with ${out.byteLength} bytes: ${stderr.slice(-400)}`);
  return new Uint8Array(out)[0] ?? 0;
}

function lavfiVideo(spec: ClipSpec): string {
  const { seconds, fps = 24 } = spec;
  const [width, height] = spec.rotate === undefined ? [spec.width, spec.height] : [spec.height, spec.width];
  // A flat colour from the first frame, converted with the BT.709 matrix and tagged so: a grey fixture cannot show a wrong matrix, a coloured one does.
  if (spec.patch !== undefined) {
    const { matrix, range } = ENCODINGS[spec.encoding ?? "709tv"];
    return `color=c=${spec.patch}:s=${width}x${height}:r=${fps}:d=${seconds},format=rgb24,scale=out_color_matrix=${matrix}:out_range=${range},format=yuv420p`;
  }
  return `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,0.25)'`;
}

/** Writes the clip `spec` describes to `path`. */
export async function writeClip(path: string, spec: ClipSpec): Promise<void> {
  const codec = spec.codec ?? "h264";
  const args: string[] = ["-f", "lavfi", "-i", lavfiVideo(spec)];
  if (spec.secondVideo === true) args.push("-f", "lavfi", "-i", lavfiVideo(spec));
  if (spec.audio === true) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${spec.seconds}`);
  args.push("-map", "0:v");
  if (spec.secondVideo === true) args.push("-map", "1:v");
  if (spec.audio === true) args.push("-map", spec.secondVideo === true ? "2:a" : "1:a", "-c:a", "aac", "-b:a", "32k");
  if (codec === "h264") args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", spec.patch === undefined ? "35" : "12", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "libx265", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-x265-params", "log-level=error");
  if (spec.patch !== undefined) args.push(...ENCODINGS[spec.encoding ?? "709tv"].tags);
  if (spec.faststart !== false) args.push("-movflags", "+faststart");
  if (spec.rotate === undefined) {
    args.push(path);
    await runFfmpegForFixture(args);
    return;
  }
  // Stored as height x width, then the rotation is written into the header without touching the samples.
  const stored = `${path}.stored.mp4`;
  args.push(stored);
  await runFfmpegForFixture(args);
  await runFfmpegForFixture(["-display_rotation", String(360 - spec.rotate), "-i", stored, "-c", "copy", "-movflags", "+faststart", path]);
  await rm(stored, { force: true });
}

/**
 * A folder of generated clips that lives until the end of the file, and a function that makes (or reuses) the clip a spec describes.
 * Call it at the top level of a test file.
 */
export function useClipFixtures(): (spec: ClipSpec) => Promise<string> {
  let dir: Promise<string> | undefined;
  const made = new Map<string, Promise<string>>();
  afterAll(async () => {
    if (dir !== undefined) await rm(await dir, { recursive: true, force: true });
  });
  return (spec) => {
    dir ??= mkdtemp(join(tmpdir(), "studio-clip-fixtures-")).then(async (d) => {
      await mkdir(d, { recursive: true });
      return d;
    });
    const key = JSON.stringify(spec);
    let path = made.get(key);
    if (path === undefined) {
      const index = made.size;
      path = dir.then(async (d) => {
        const file = join(d, `clip-${index}.mp4`);
        await writeClip(file, spec);
        return file;
      });
      made.set(key, path);
    }
    return path;
  };
}
