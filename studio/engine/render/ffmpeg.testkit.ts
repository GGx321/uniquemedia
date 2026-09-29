import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ffprobeStatic from "ffprobe-static";
import { ffmpegPath } from "../../node/ffmpegBinary";

// Test support for the real-ffmpeg suites: a runner, an ffprobe wrapper, and
// the synthetic inputs the checks are built on. Test-only (`.testkit.ts`):
// it is never imported by production code.

export interface RunResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/** Runs a binary with an argv array (never a shell string). Non-zero exit is returned, not thrown. */
export async function runBinary(bin: string, argv: readonly string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...argv], { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const bytes = async (): Promise<Uint8Array> => new Uint8Array(await Bun.readableStreamToArrayBuffer(proc.stdout));
  const [stdout, stderr, code] = await Promise.all([bytes(), Bun.readableStreamToText(proc.stderr), proc.exited]);
  return { code, stdout, stderr };
}

/** Runs the bundled ffmpeg and throws (with the stderr tail) on failure. */
export async function runFfmpegOk(argv: readonly string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const r = await runBinary(ffmpegPath(), argv, opts);
  if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${argv.join(" ")}\n${r.stderr.slice(-1500)}`);
  return r;
}

export interface ProbedStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly profile?: string;
  readonly width?: number;
  readonly height?: number;
  readonly pix_fmt?: string;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly color_range?: string;
  readonly color_space?: string;
  readonly color_transfer?: string;
  readonly color_primaries?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly nb_read_frames?: string;
  readonly duration?: string;
  readonly tags?: Record<string, string>;
}

export interface Probed {
  readonly streams: ProbedStream[];
  readonly format: { readonly format_name?: string; readonly duration?: string; readonly tags?: Record<string, string> };
}

/** ffprobe (test-only, 4.4) as JSON, with the given `-show_entries`-style extra args. */
export async function probeJson(path: string, extra: readonly string[]): Promise<Probed> {
  const r = await runBinary(ffprobeStatic.path, ["-v", "error", "-of", "json", ...extra, path]);
  if (r.code !== 0) throw new Error(`ffprobe exited ${r.code}: ${r.stderr}`);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(r.stdout));
  if (typeof parsed !== "object" || parsed === null) throw new Error("ffprobe printed no object");
  const streams: unknown = Reflect.get(parsed, "streams");
  const format: unknown = Reflect.get(parsed, "format");
  return {
    streams: Array.isArray(streams) ? (streams as ProbedStream[]) : [],
    format: typeof format === "object" && format !== null ? (format as Probed["format"]) : {},
  };
}

/** Stream facts, container facts, and the decoded frame count of the first video stream. */
export async function probeVideo(path: string): Promise<Probed> {
  return probeJson(path, [
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,color_range,color_space,color_transfer,color_primaries,sample_rate,channels,nb_read_frames,duration:stream_tags:format=format_name,duration:format_tags",
  ]);
}

/** The video frame count by a full decode (`nb_read_frames`). */
export async function videoFrames(path: string): Promise<number> {
  const p = await probeJson(path, ["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames"]);
  return Number(p.streams[0]?.nb_read_frames);
}

/** Every video frame's timestamp in ms (ffprobe 4.4 has no `pts_time`; `best_effort_timestamp_time` is the one to read). */
export async function frameTimesMs(path: string): Promise<number[]> {
  const r = await runBinary(ffprobeStatic.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", path]);
  return new TextDecoder()
    .decode(r.stdout)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => Number(l.trim().replace(/,$/, "")) * 1000);
}

/** Frame `indexes` of a video as raw planes, in the requested pixel format, one buffer per frame. */
export async function extractFrames(path: string, indexes: readonly number[], pixFmt: "gray" | "yuv420p" | "rgb24", size: { w: number; h: number }): Promise<Uint8Array[]> {
  const select = indexes.map((i) => `eq(n\\,${i})`).join("+");
  const r = await runFfmpegOk(["-hide_banner", "-nostdin", "-i", path, "-vf", `select=${select},format=${pixFmt}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  const bytes = pixFmt === "gray" ? size.w * size.h : pixFmt === "rgb24" ? size.w * size.h * 3 : size.w * size.h * 1.5;
  const out: Uint8Array[] = [];
  for (let o = 0; o + bytes <= r.stdout.length; o += bytes) out.push(r.stdout.subarray(o, o + bytes));
  if (out.length !== indexes.length) throw new Error(`asked for ${indexes.length} frames, decoded ${out.length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic inputs
// ---------------------------------------------------------------------------

/** A fixed, well-known full-range BT.601 JPEG shape: a camera JPEG (`yuvj420p`). */
async function rawGrayToJpeg(raw: Uint8Array, w: number, h: number, dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const rawPath = join(dir, `${name}.gray`);
  const out = join(dir, `${name}.jpg`);
  writeFileSync(rawPath, raw);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-i", rawPath, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "1", "-pix_fmt", "yuvj420p", out]);
  return out;
}

export const STRIPE_LOW = 30;
export const STRIPE_STEP = 80;

/**
 * A `w` x `h` JPEG whose luma is ADDITIVELY separable, `30 + 80 * sx(x) + 80 *
 * sy(y)`, with `sx` and `sy` square waves of the given periods (in source
 * pixels; a full period is two stripes). Additive matters: every linear
 * resampler keeps it separable, so the horizontal differences of a row carry
 * only the x edges and the vertical differences of a column only the y edges.
 */
export async function makeStripeJpeg(dir: string, name: string, w: number, h: number, periodX: number, periodY: number): Promise<string> {
  const raw = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / periodY) % 2;
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / periodX) % 2;
      raw[y * w + x] = STRIPE_LOW + STRIPE_STEP * sx + STRIPE_STEP * sy;
    }
  }
  return rawGrayToJpeg(raw, w, h, dir, name);
}

/** Where a stripe image's edges are, in source pixels: `period, 2 * period, ...` below `length`. */
export function stripeEdges(period: number, length: number): number[] {
  const edges: number[] = [];
  for (let e = period; e < length; e += period) edges.push(e);
  return edges;
}

// ---------------------------------------------------------------------------
// Edge measurement (sub-pixel) and window fitting
// ---------------------------------------------------------------------------

/**
 * Sub-pixel positions of the edges in a 1-D profile of `d[j] = v[j + 1] -
 * v[j]`: a blob is a run of same-signed differences above `floor`, and its
 * position is the |d|-weighted centroid of `j + 1` (an edge between pixel
 * centres j + .5 and j + 1.5 sits at the area coordinate j + 1).
 */
export function edgePositions(diff: readonly number[], floor: number): number[] {
  const edges: number[] = [];
  let j = 0;
  while (j < diff.length) {
    const d = diff[j] ?? 0;
    if (Math.abs(d) < floor) {
      j++;
      continue;
    }
    const sign = Math.sign(d);
    let weight = 0;
    let moment = 0;
    while (j < diff.length && Math.sign(diff[j] ?? 0) === sign && Math.abs(diff[j] ?? 0) >= floor) {
      const a = Math.abs(diff[j] ?? 0);
      weight += a;
      moment += a * (j + 1);
      j++;
    }
    edges.push(moment / weight);
  }
  return edges;
}

/** Row-averaged horizontal differences of a gray region: only the x edges survive (see `makeStripeJpeg`). */
export function horizontalDiff(gray: Uint8Array, stride: number, region: { x: number; y: number; w: number; h: number }): number[] {
  const diff = new Array<number>(region.w - 1).fill(0);
  for (let y = region.y; y < region.y + region.h; y++) {
    const row = y * stride + region.x;
    for (let j = 0; j < region.w - 1; j++) diff[j] = (diff[j] ?? 0) + ((gray[row + j + 1] ?? 0) - (gray[row + j] ?? 0));
  }
  return diff.map((v) => v / region.h);
}

/** Column-averaged vertical differences of a gray region: only the y edges survive. */
export function verticalDiff(gray: Uint8Array, stride: number, region: { x: number; y: number; w: number; h: number }): number[] {
  const diff = new Array<number>(region.h - 1).fill(0);
  for (let y = 0; y < region.h - 1; y++) {
    const a = (region.y + y) * stride + region.x;
    const b = a + stride;
    for (let x = 0; x < region.w; x++) diff[y] = (diff[y] ?? 0) + ((gray[b + x] ?? 0) - (gray[a + x] ?? 0));
  }
  return diff.map((v) => v / region.w);
}

export interface AxisFit {
  /** Where the window starts on the canvas, in canvas pixels. */
  readonly start: number;
  /** How long the window is on the canvas, in canvas pixels. */
  readonly length: number;
  /** How many edges the fit used. */
  readonly edges: number;
  /** Worst residual of the fit, in output pixels. */
  readonly residual: number;
}

/**
 * Fits `out = a * canvasEdge + b` through the detected edges (least squares),
 * matching each canvas edge to the detected edge nearest its PREDICTED output
 * position (`predict`), and reads the window off the line: `length = outLength
 * / a`, `start = -b / a`. The prediction only pairs edges up; the window comes
 * from the pixels.
 */
export function fitAxis(detected: readonly number[], canvasEdges: readonly number[], predict: (canvasEdge: number) => number, outLength: number, matchWithin: number): AxisFit {
  const pairs: Array<[number, number]> = [];
  for (const c of canvasEdges) {
    const p = predict(c);
    let best: number | undefined;
    for (const d of detected) if (best === undefined || Math.abs(d - p) < Math.abs(best - p)) best = d;
    if (best !== undefined && Math.abs(best - p) <= matchWithin) pairs.push([c, best]);
  }
  if (pairs.length < 4) throw new Error(`only ${pairs.length} edges matched`);
  const n = pairs.length;
  const sx = pairs.reduce((s, [c]) => s + c, 0);
  const sy = pairs.reduce((s, [, o]) => s + o, 0);
  const sxx = pairs.reduce((s, [c]) => s + c * c, 0);
  const sxy = pairs.reduce((s, [c, o]) => s + c * o, 0);
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  const residual = Math.max(...pairs.map(([c, o]) => Math.abs(o - (a * c + b))));
  return { start: -b / a, length: outLength / a, edges: n, residual };
}
