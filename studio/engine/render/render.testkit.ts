import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpegOk } from "./ffmpeg.testkit";
import type { Pass1Job, Pass2Job } from "./types";

// Test support for the real-ffmpeg render suites: temp folders, running the
// builder's argv arrays the way the runner (3a.6) will, and the fixed inputs.

/** A fresh temp folder; the caller removes it. */
export function makeWorkDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `studio-render-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Runs every pass-1 call, one after another, as the runner does within a job. */
export async function runPass1(jobs: readonly Pass1Job[]): Promise<void> {
  for (const job of jobs) await runFfmpegOk(job.argv);
}

/** Writes the concat list into the job folder and runs the pass-2 call there. */
export async function runPass2(job: Pass2Job): Promise<void> {
  mkdirSync(job.cwd, { recursive: true });
  writeFileSync(join(job.cwd, job.listFileName), job.listFileContents);
  await runFfmpegOk(job.argv, { cwd: job.cwd });
}

/** The graph string of an argv, for tests that tamper with it. */
export function graphIndex(argv: readonly string[]): number {
  const i = argv.indexOf("-filter_complex");
  if (i < 0) throw new Error("no -filter_complex in argv");
  return i + 1;
}

/** A copy of `argv` with `from` replaced by `to` in its filter graph; throws if `from` is not there (a tamper that changed nothing proves nothing). */
export function tamperGraph(argv: readonly string[], from: string, to: string): string[] {
  const at = graphIndex(argv);
  const graph = argv[at] ?? "";
  if (!graph.includes(from)) throw new Error(`the graph does not contain ${from}`);
  return argv.map((a, i) => (i === at ? graph.replace(from, to) : a));
}

/** A solid-colour still, as JPEG (full-range BT.601, like a camera) or PNG. */
export async function makeSolid(path: string, colour: string, w: number, h: number, kind: "jpeg" | "png-rgba"): Promise<void> {
  const codec = kind === "jpeg" ? ["-c:v", "mjpeg", "-q:v", "1", "-pix_fmt", "yuvj420p"] : ["-c:v", "png", "-pix_fmt", "rgba"];
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", `color=c=${colour}:s=${w}x${h}`, "-frames:v", "1", ...codec, path]);
}

/**
 * A two-frame APNG that loops forever: white for 0.1 s, then black for 0.1 s.
 * At 30 fps that is 3 frames of each, a period of 6.
 */
export async function makeBlinkApng(path: string, size: number): Promise<void> {
  await runFfmpegOk([
    "-hide_banner", "-y", "-nostdin",
    "-f", "lavfi", "-i", `color=c=white:s=${size}x${size}:r=10:d=0.1`,
    "-f", "lavfi", "-i", `color=c=black:s=${size}x${size}:r=10:d=0.1`,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=rgba",
    "-plays", "0", "-f", "apng", path,
  ]);
}

// ---------------------------------------------------------------------------
// The colour chart (invariant 36)
// ---------------------------------------------------------------------------

export type RGB = readonly [number, number, number];

/** 24 patches, 4 columns by 6 rows of 180x160 source pixels, then two uniform blocks (360x320 each) under them. */
export const CHART_GRID: readonly RGB[] = [
  [255, 255, 255], [191, 191, 0], [0, 191, 191], [0, 191, 0],
  [191, 0, 191], [191, 0, 0], [0, 0, 191], [0, 0, 0],
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
  [0, 255, 255], [255, 0, 255], [64, 64, 64], [128, 128, 128],
  [192, 192, 192], [224, 172, 105], [141, 85, 36], [198, 134, 66],
  [241, 194, 125], [255, 219, 172], [16, 16, 16], [235, 235, 235],
];
export const CHART_BLOCK_L: RGB = [90, 140, 200];
export const CHART_BLOCK_R: RGB = [200, 120, 60];
export const STICKER_COLOURS: readonly RGB[] = [[220, 40, 40], [40, 180, 60], [40, 80, 220], [250, 180, 30]];
export const STICKER_W = 400;
export const STICKER_H = 300;

const CHART_CELL_W = 180;
const CHART_CELL_H = 160;

/** The chart as a full-range BT.601 JPEG, 720x1280, the shape of a real 1K photo. */
export async function makeChartJpeg(dir: string, name: string): Promise<string> {
  const w = 720;
  const h = 1280;
  const buf = new Uint8Array(w * h * 3);
  const put = (x0: number, y0: number, cw: number, ch: number, c: RGB): void => {
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) buf.set(c, (y * w + x) * 3);
  };
  CHART_GRID.forEach((c, i) => put((i % 4) * CHART_CELL_W, Math.floor(i / 4) * CHART_CELL_H, CHART_CELL_W, CHART_CELL_H, c));
  put(0, 960, 360, 320, CHART_BLOCK_L);
  put(360, 960, 360, 320, CHART_BLOCK_R);
  const rawPath = join(dir, `${name}.rgb`);
  const out = join(dir, `${name}.jpg`);
  writeFileSync(rawPath, buf);
  // RGB to full-range BT.601 explicitly, so the JPEG carries what a camera JPEG carries.
  await runFfmpegOk([
    "-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", rawPath,
    "-vf", "scale=out_color_matrix=bt601:out_range=full,format=yuvj420p", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "1", out,
  ]);
  return out;
}

/** A 400x300 RGBA sticker: row 0 opaque, row 1 alpha 128, row 2 an alpha ramp; four colours across. */
export async function makeStickerPng(dir: string, name: string): Promise<string> {
  const buf = new Uint8Array(STICKER_W * STICKER_H * 4);
  for (let y = 0; y < STICKER_H; y++) {
    for (let x = 0; x < STICKER_W; x++) {
      const c = STICKER_COLOURS[Math.floor(x / 100)] ?? STICKER_COLOURS[0] ?? [0, 0, 0];
      const row = Math.floor(y / 100);
      const a = row === 0 ? 255 : row === 1 ? 128 : Math.round((x / (STICKER_W - 1)) * 255);
      buf.set([c[0], c[1], c[2], a], (y * STICKER_W + x) * 4);
    }
  }
  const rawPath = join(dir, `${name}.rgba`);
  const out = join(dir, `${name}.png`);
  writeFileSync(rawPath, buf);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${STICKER_W}x${STICKER_H}`, "-i", rawPath, "-frames:v", "1", "-c:v", "png", out]);
  return out;
}

/** Expected limited-range Y'CbCr (8-bit, not rounded) for full-range R'G'B' under BT.709. */
export function expectedBt709Limited(rgb: RGB): [number, number, number] {
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  const y = kr * rgb[0] + kg * rgb[1] + kb * rgb[2];
  const cb = (rgb[2] - y) / (2 * (1 - kb));
  const cr = (rgb[0] - y) / (2 * (1 - kr));
  return [16 + (219 / 255) * y, 128 + (224 / 255) * cb, 128 + (224 / 255) * cr];
}

export function mixRgb(a: RGB, b: RGB, alpha: number): RGB {
  return [alpha * a[0] + (1 - alpha) * b[0], alpha * a[1] + (1 - alpha) * b[1], alpha * a[2] + (1 - alpha) * b[2]];
}

/** A decoded yuv420p frame split into its planes. */
export function splitYuv420(frame: Uint8Array, w: number, h: number): { y: Uint8Array; u: Uint8Array; v: Uint8Array } {
  const ys = w * h;
  const cs = (w / 2) * (h / 2);
  return { y: frame.subarray(0, ys), u: frame.subarray(ys, ys + cs), v: frame.subarray(ys + cs, ys + 2 * cs) };
}

/** The mean of a square of `2 * r` pixels around (cx, cy). */
export function meanAround(plane: Uint8Array, stride: number, cx: number, cy: number, r: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(cy - r); y < Math.round(cy + r); y++) {
    for (let x = Math.round(cx - r); x < Math.round(cx + r); x++) {
      sum += plane[y * stride + x] ?? 0;
      n++;
    }
  }
  return sum / n;
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
