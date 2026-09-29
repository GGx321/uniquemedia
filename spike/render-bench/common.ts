// Shared helpers for the SP1 render bench: ffmpeg/ffprobe runners with peak-RSS
// measurement (/usr/bin/time -l), medians, and the fixed asset paths.
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadavg, cpus, totalmem, platform, arch } from "node:os";
import { createRequire } from "node:module";
import { ffmpegPath } from "../../studio/node/ffmpegBinary";

const require = createRequire(import.meta.url);
export const FFMPEG = ffmpegPath();
export const FFPROBE: string = require("ffprobe-static").path;

export const ROOT = resolve(import.meta.dir, "../..");
export const CACHE = join(ROOT, ".cache", "render-bench");
export const ASSETS = join(CACHE, "assets");
export const OUT = join(CACHE, "out");
export const RESULTS = join(import.meta.dir, "results");
for (const d of [CACHE, ASSETS, OUT, RESULTS]) mkdirSync(d, { recursive: true });

export const FIX = join(ROOT, "studio/engine/face/fixtures/images");
export const PHOTOS = ["render-best-home-1", "render-median-travel-2", "render-worst-fitness-3"].map(
  (n) => join(FIX, `${n}.jpg`),
);
export const CHART = join(ASSETS, "chart.jpg");
export const STICKER = join(ASSETS, "sticker.png");
export const TEXTURE = join(ASSETS, "texture.jpg");

export const W = 1080;
export const H = 1920;
export const FPS = 30;

export type Run = { code: number; stdout: Uint8Array; stderr: string; ms: number; rssMB: number };

const HAS_TIME = existsSync("/usr/bin/time") && platform() === "darwin";

/** Runs a binary; on macOS wraps it in `/usr/bin/time -l` to read the peak RSS (bytes -> MB). */
export async function run(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<Run> {
  const cmd = HAS_TIME ? ["/usr/bin/time", "-l", bin, ...args] : [bin, ...args];
  const t0 = performance.now();
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const ms = performance.now() - t0;
  const m = /(\d+)\s+maximum resident set size/.exec(stderr);
  return { code, stdout: new Uint8Array(stdout), stderr, ms, rssMB: m ? Number(m[1]) / 1048576 : NaN };
}

export async function ff(args: string[], opts: { cwd?: string } = {}): Promise<Run> {
  const r = await run(FFMPEG, ["-hide_banner", "-y", "-nostdin", ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${args.join(" ")}\n${r.stderr.slice(-1500)}`);
  return r;
}

export async function probeJson(path: string, extra: string[] = []): Promise<any> {
  const r = await run(FFPROBE, ["-v", "error", "-of", "json", ...extra, path]);
  const text = new TextDecoder().decode(r.stdout);
  return JSON.parse(text);
}

export async function frameCount(path: string): Promise<number> {
  const j = await probeJson(path, ["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames"]);
  return Number(j.streams[0].nb_read_frames);
}

/** Frame pts deltas in ms (rounded to 0.001) - CFR 30 fps means every delta is 33.333. */
export async function ptsDeltas(path: string): Promise<number[]> {
  const j = await probeJson(path, ["-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time"]);
  const t: number[] = j.frames.map((f: any) => Number(f.best_effort_timestamp_time));
  return t.slice(1).map((v, i) => Math.round((v - t[i]!) * 1e6) / 1e3);
}

export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
export const fmt = (n: number, d = 1) => n.toFixed(d);
export const sizeMB = (p: string) => statSync(p).size / 1048576;

export function machine() {
  return {
    platform: `${platform()}-${arch()}`,
    cores: cpus().length,
    totalMemBytes: totalmem(),
    loadavgStart: loadavg().map((x) => Math.round(x * 10) / 10),
  };
}

export function saveResult(name: string, data: unknown) {
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}
export function loadResult<T>(name: string): T {
  return JSON.parse(readFileSync(join(RESULTS, `${name}.json`), "utf8")) as T;
}

/** Repeats `fn` n times, returns the median time and the max RSS, with the load average at the end. */
export async function bench(n: number, fn: () => Promise<Run>) {
  const ms: number[] = [];
  const rss: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fn();
    ms.push(r.ms);
    rss.push(r.rssMB);
  }
  return {
    medianMs: Math.round(median(ms)),
    runsMs: ms.map(Math.round),
    peakRssMB: Math.round(Math.max(...rss)),
    medianRssMB: Math.round(median(rss)),
    load1: Math.round(loadavg()[0]! * 10) / 10,
  };
}

/** Raw gray8 frames of a video, one Uint8Array per frame (for the motion metric). */
export async function grayFrames(path: string, w: number, h: number, vf = ""): Promise<Uint8Array[]> {
  const r = await ff(["-i", path, "-vf", `${vf}scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"]);
  const size = w * h;
  const out: Uint8Array[] = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push(r.stdout.subarray(o, o + size));
  return out;
}
