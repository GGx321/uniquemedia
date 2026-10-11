import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import type { ResolvedCopyOptions } from "../core/types";

/**
 * Frame mode rendered for real: a 320x240 clip goes onto a 1080x1920 canvas,
 * smaller than it, over a solid-colour background standing in for a pack
 * photo. Solid so that "this pixel is background" is one comparison.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

const BG_RGB = [32, 160, 64] as const;
const W = 1080;
const H = 1920;

let dir: string;
let output: string;
let spec: NonNullable<ReturnType<typeof sampleRecipe>["frame"]>;
const exec = new FfmpegExecutor();

const opts = (bg: string): ResolvedCopyOptions => ({
  strength: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 38,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
  frame: { backgrounds: [bg] },
});

/** The RGB of one pixel of the frame at 1 s, read off a raw dump of that frame. */
function pixelAt(file: string, x: number, y: number): number[] {
  const r = spawnSync(
    FFMPEG,
    [
      "-v", "error", "-ss", "1", "-i", file, "-frames:v", "1",
      // Read it the way a player reads an untagged HD file: BT.709, limited range.
      "-vf", "scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24",
      "-f", "rawvideo", "-",
    ],
    { maxBuffer: W * H * 3 + 1024 }
  );
  expect(r.status).toBe(0);
  const at = (y * W + x) * 3;
  return [r.stdout[at], r.stdout[at + 1], r.stdout[at + 2]];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-frame-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input, 3);
  const bg = join(dir, "bg.jpg");
  const made = spawnSync(FFMPEG, [
    "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x${BG_RGB.map((v) => v.toString(16).padStart(2, "0")).join("")}:s=${W}x${H}`,
    "-frames:v", "1", "-q:v", "2", bg,
  ]);
  expect(made.status).toBe(0);

  const info = await exec.probe(input);
  const recipe = sampleRecipe(opts(bg), 11, 1);
  spec = recipe.frame!;
  output = join(dir, "out.mp4");
  await exec.render(input, info, recipe, output);
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a framed copy is a full 1080x1920 canvas", () => {
  const r = spawnSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0", output,
  ], { encoding: "utf8" });
  expect(r.stdout.trim()).toBe(`${W},${H}`);
});

test("a framed copy ends with the footage, not with the endless background", () => {
  const r = spawnSync(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output,
  ], { encoding: "utf8" });
  const duration = Number(r.stdout.trim());
  expect(duration).toBeGreaterThan(2);
  expect(duration).toBeLessThan(4.5);
});

test("the canvas corners are the background picture", () => {
  const corners = ([[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]] as const).filter(
    ([x, y]) => x < spec.x || x >= spec.x + spec.w || y < spec.y || y >= spec.y + spec.h
  );
  expect(corners.length).toBeGreaterThan(0);
  for (const [x, y] of corners) {
    const px = pixelAt(output, x, y);
    // Read as BT.709 (above); the JPEG and the 8-bit round trips cost a few levels.
    px.forEach((v, i) => expect(Math.abs(v - BG_RGB[i])).toBeLessThan(6));
  }
});

test("the middle of the canvas is the footage, inside the frame the recipe drew", () => {
  const cx = spec.x + Math.floor(spec.w / 2);
  const cy = spec.y + Math.floor(spec.h / 2);
  const px = pixelAt(output, cx, cy);
  const distance = px.reduce((acc, v, i) => acc + Math.abs(v - BG_RGB[i]), 0);
  expect(distance).toBeGreaterThan(30);
});

// ── a 16:9 clip in the original format ──────────────────────────────────────

test("a 16:9 clip in the original format keeps its full width and never touches an edge", async () => {
  const wide = join(dir, "wide.mp4");
  const made = spawnSync(FFMPEG, [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", wide,
  ]);
  expect(made.status).toBe(0);
  const info = await exec.probe(wide);
  const recipe = sampleRecipe({ ...opts(join(dir, "bg.jpg")), exportFormat: "original" }, 11, 1);
  const box = recipe.frame!;
  expect(box.fit).toBe(true);
  const out = join(dir, "wide_out.mp4");
  await exec.render(wide, info, recipe, out);

  const farFromBg = (px: number[]) => px.reduce((acc, v, i) => acc + Math.abs(v - BG_RGB[i]), 0) > 30;
  const midY = box.y + Math.floor(box.h / 2);
  // Full width: the footage reaches both sides of its box on the middle row.
  expect(farFromBg(pixelAt(out, box.x + 3, midY))).toBe(true);
  expect(farFromBg(pixelAt(out, box.x + box.w - 4, midY))).toBe(true);
  // Fitted, not cropped: the box's top rows are background, the letterbox.
  expect(farFromBg(pixelAt(out, box.x + Math.floor(box.w / 2), box.y + 2))).toBe(false);
  // And the box itself clears every edge of the canvas.
  expect(box.x).toBeGreaterThan(0);
  expect(box.y).toBeGreaterThan(0);
  expect(box.x + box.w).toBeLessThan(W);
  expect(box.y + box.h).toBeLessThan(H);
});
