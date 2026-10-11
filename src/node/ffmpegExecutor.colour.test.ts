import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor, ffmpegFilters } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { sourceToBt709 } from "../core/colour";
import type { ResolvedCopyOptions } from "../core/types";

/**
 * A copy is written as BT.709, limited range, 8-bit, and now says so — so the
 * source has to be brought into that form first, whatever it was. Each case
 * below is a tiny clip of four flat bands built here with the bundled ffmpeg
 * from known sRGB values, rendered through the real probe and graph at
 * strength 0 (no tone change of the recipe's own), and read back the way a
 * player reads a BT.709 file. What the copy shows is compared with the values
 * the clip was made from, by CIEDE2000.
 *
 * Measured before the conversion existed: an iPhone-style HLG clip came out
 * washed grey (white 240 -> 183, dE00 13), PQ worse (dE00 25), and untagged
 * BT.601 SD read as BT.709 moved a saturated green by dE00 7.4.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

const W = 144;
const BAND = 64;
const H = BAND * 4;
const TRUTH = [
  [240, 240, 240], // white
  [224, 172, 140], // skin
  [30, 190, 40], // saturated green
  [0, 0, 0], // black
] as const;
const WHITE = 0;
const GREEN = 2;

/** The four bands as one gbrp picture, 1 s at 15 fps. */
const BANDS =
  TRUTH.map(
    (rgb, i) =>
      `color=c=0x${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}:s=${W}x${BAND}:d=1:r=15[b${i}]`
  ).join(";") + `;${TRUTH.map((_, i) => `[b${i}]`).join("")}vstack=${TRUTH.length},format=gbrp`;

function ffmpeg(args: string[]): Buffer {
  const r = spawnSync(FFMPEG, ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  return r.stdout;
}

/** Encodes the bands as `vf` makes them, with `tags` on the stream, losslessly. */
function makeClip(path: string, vf: string, tags: string[], codec = ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast"]): void {
  ffmpeg(["-filter_complex", `${BANDS},${vf}`, ...codec, ...tags, path]);
}

const HDR_IN = (transfer: string) =>
  `zscale=rin=full:tin=709:pin=709:t=${transfer}:p=2020:m=2020_ncl:r=tv:npl=203:dither=ordered,format=yuv420p10le`;
const HDR_TAGS = (transfer: string) => [
  "-color_trc", transfer, "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_range", "tv",
];

// ── CIEDE2000 ───────────────────────────────────────────────────────────────

function lab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE2000(c1: readonly number[], c2: readonly number[]): number {
  return deltaE2000Lab(lab(c1), lab(c2));
}

function deltaE2000Lab([L1, a1, b1]: readonly number[], [L2, a2, b2]: readonly number[]): number {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) % 360 + 360) % 360);
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T =
    1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dth * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

test("CIEDE2000 matches Sharma, Wu and Dalal's reference pairs", () => {
  const pairs: Array<[number[], number[], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  for (const [a, b, want] of pairs) expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 3);
  expect(deltaE2000([128, 128, 128], [128, 128, 128])).toBe(0);
});

// ── reading a copy back ─────────────────────────────────────────────────────

/** Mean RGB of each band's middle, read off frame 0.5 s as a BT.709 player
 *  reads it. The rows are the band centres after the recipe's fixed 5% zoom
 *  about the frame centre (strength 0 keeps the zoom at its neutral value). */
function bandsOf(file: string, chain = ""): number[][] {
  const rgb = ffmpeg([
    "-ss", "0.5", "-i", file, "-frames:v", "1",
    "-vf", `${chain ? chain + "," : ""}scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24`,
    "-f", "rawvideo", "-",
  ]);
  expect(rgb.length).toBe(W * H * 3);
  return TRUTH.map((_, k) => {
    const cy = Math.round(H / 2 + (BAND * k + BAND / 2 - H / 2) * 1.05);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = cy - 6; y < cy + 6; y++) {
      for (let x = W / 2 - 16; x < W / 2 + 16; x++) {
        for (let c = 0; c < 3; c++) sum[c] += rgb[(y * W + x) * 3 + c];
        n++;
      }
    }
    return sum.map((v) => v / n);
  });
}

/** Mean of the luma plane around each of `rows` (source rows; `zoom` is the
 *  recipe's, 1 for the source itself) — the stored numbers, not the colour.
 *  Dumped in the decoder's own 8-bit 4:2:0 format, so nothing converts the
 *  range on the way out (`format=gray` would: it is full range). */
function lumaAt(file: string, rows: number[], zoom: number): number[] {
  const y = ffmpeg(["-ss", "0.5", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-"]);
  expect(y.length).toBe(W * H * 1.5);
  return rows.map((row0) => {
    const cy = Math.round(H / 2 + (row0 - H / 2) * zoom);
    let sum = 0;
    let n = 0;
    for (let row = cy - 6; row < cy + 6; row++) {
      for (let x = W / 2 - 16; x < W / 2 + 16; x++) {
        sum += y[row * W + x];
        n++;
      }
    }
    return sum / n;
  });
}

function streamTags(file: string): string {
  const r = spawnSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range",
    "-of", "default=nw=1", file,
  ], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
}

// ── fixtures and renders ────────────────────────────────────────────────────

let dir: string;
const exec = new FfmpegExecutor();
const out: Record<string, string> = {};
const src: Record<string, string> = {};

const opts: ResolvedCopyOptions = {
  strength: 0,
  exportFormat: "original",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 38,
  identity: "clean",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};

async function render(name: string): Promise<void> {
  const info = await exec.probe(src[name]);
  out[name] = join(dir, `${name}_out.mp4`);
  await exec.render(src[name], info, sampleRecipe(opts, 5, 1), out[name]);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-colour-"));
  src.hlg = join(dir, "hlg.mp4");
  makeClip(src.hlg, HDR_IN("arib-std-b67"), HDR_TAGS("arib-std-b67"));
  src.pq = join(dir, "pq.mp4");
  makeClip(src.pq, HDR_IN("smpte2084"), HDR_TAGS("smpte2084"));
  // What ffmpeg writes by default: BT.601 numbers and no colour tag at all.
  src.sd = join(dir, "sd601.mp4");
  makeClip(src.sd, "scale=out_color_matrix=bt601:out_range=tv,format=yuv420p", []);
  for (const name of Object.keys(src)) await render(name);

  // Full range, BT.709: pure white over pure black, decoded as plain yuv420p
  // with the range in a tag — 10-bit phone footage, FFV1 and ProRes arrive
  // like this. (An 8-bit H.264 or HEVC full-range stream decodes as yuvj420p,
  // a format the range travels with.)
  src.full = join(dir, "full709.mkv");
  ffmpeg([
    "-filter_complex",
    `color=c=white:s=${W}x${H / 2}:d=1:r=15[w];color=c=black:s=${W}x${H / 2}:d=1:r=15[k];[w][k]vstack=2,format=gbrp,` +
      "zscale=rin=full:m=709:r=full:dither=ordered,format=yuv420p",
    "-c:v", "ffv1", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "pc",
    src.full,
  ]);
  await render("full");
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the fixtures say what they are", () => {
  expect(streamTags(src.hlg)).toContain("color_transfer=arib-std-b67");
  expect(streamTags(src.pq)).toContain("color_transfer=smpte2084");
  expect(streamTags(src.sd)).not.toContain("color_space=bt709");
  expect(streamTags(src.full)).toContain("color_range=pc");
});

test.each(["hlg", "pq"])("an %s source keeps its white, skin and green within dE00 2", (name) => {
  const bands = bandsOf(out[name]);
  bands.forEach((rgb, k) => expect(deltaE2000(TRUTH[k], rgb)).toBeLessThan(2));
});

test.each(["hlg", "pq"])("an %s source's white is neutral, not grey-green", (name) => {
  const [r, g, b] = bandsOf(out[name])[WHITE];
  expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
  expect(Math.abs(b - g)).toBeLessThanOrEqual(1);
});

test("an untagged BT.601 SD source keeps its saturated green within dE00 2", () => {
  const bands = bandsOf(out.sd);
  expect(deltaE2000(TRUTH[GREEN], bands[GREEN])).toBeLessThan(2);
  bands.forEach((rgb, k) => expect(deltaE2000(TRUTH[k], rgb)).toBeLessThan(2));
});

test("a full-range source's black and white land on 16 and 235", () => {
  const rows = [H / 4, (3 * H) / 4]; // the middle of the white half, then the black one
  // The source's own numbers are the full-range ones...
  expect(lumaAt(src.full, rows, 1)).toEqual([255, 0]);
  // ...and the copy's are limited range.
  const [white, black] = lumaAt(out.full, rows, 1.05);
  expect(Math.abs(white - 235)).toBeLessThanOrEqual(1);
  expect(Math.abs(black - 16)).toBeLessThanOrEqual(1);
});

test.each(["hlg", "pq", "sd", "full"])("a copy of the %s source is tagged BT.709 limited range", (name) => {
  const tags = streamTags(out[name]);
  for (const line of ["color_space=bt709", "color_primaries=bt709", "color_transfer=bt709", "color_range=tv"]) {
    expect(tags).toContain(line);
  }
});

test("clean in a frame is tagged BT.709, not the background JPEG's BT.601", async () => {
  const clip = join(dir, "clip.mp4");
  makeTestClip(clip, 1);
  const bg = join(dir, "bg.jpg");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x20A040:s=1080x1920", "-frames:v", "1", "-q:v", "2", bg]);
  const framed = join(dir, "framed.mp4");
  const info = await exec.probe(clip);
  await exec.render(clip, info, sampleRecipe({ ...opts, strength: 1, exportFormat: "reels", frame: { backgrounds: [bg] } }, 7, 1), framed);
  const tags = streamTags(framed);
  for (const line of ["color_space=bt709", "color_primaries=bt709", "color_transfer=bt709", "color_range=tv"]) {
    expect(tags).toContain(line);
  }
});

// ── the filters it needs ────────────────────────────────────────────────────

test("the bundled ffmpeg has zscale and tonemap", async () => {
  const filters = await ffmpegFilters();
  expect(filters.has("zscale")).toBe(true);
  expect(filters.has("tonemap")).toBe(true);
});

test("the colorspace fallback, used only without zscale, converts SD as well", async () => {
  const chain = sourceToBt709(await exec.probe(src.sd), false);
  expect(chain).toContain("colorspace=");
  const fallback = join(dir, "fallback.mp4");
  ffmpeg(["-i", src.sd, "-vf", `${chain}`, "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", fallback]);
  // No recipe zoom here, so the band centres are read unscaled.
  const rgb = ffmpeg([
    "-ss", "0.5", "-i", fallback, "-frames:v", "1",
    "-vf", "scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24", "-f", "rawvideo", "-",
  ]);
  const at = ((BAND * GREEN + BAND / 2) * W + W / 2) * 3;
  expect(deltaE2000(TRUTH[GREEN], [rgb[at], rgb[at + 1], rgb[at + 2]])).toBeLessThan(2);
});
