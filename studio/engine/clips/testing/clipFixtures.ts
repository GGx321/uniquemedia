import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { ffmpegPath } from "../../../node/ffmpegBinary";

// Test-only (S5.V4b): small clips made by the bundled ffmpeg from lavfi sources, so no binary is committed. A clip is black until 0.25 s and white after it, which
// lets a test tell the frame at 0 from the frame at 0.5 s. At the sizes used here a 10 s clip is a few tens of KB.

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
}

/** Runs the bundled ffmpeg with an argv array; throws with the stderr tail when it fails. */
export async function runFfmpegForFixture(argv: readonly string[]): Promise<void> {
  const proc = Bun.spawn([ffmpegPath(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...argv], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`);
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
  const { width, height, seconds, fps = 24 } = spec;
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
  if (codec === "h264") args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "libx265", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-x265-params", "log-level=error");
  if (spec.faststart !== false) args.push("-movflags", "+faststart");
  args.push(path);
  await runFfmpegForFixture(args);
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
