import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import type { ResolvedCopyOptions } from "../core/types";

/**
 * Frame 0's cover is a JPEG (full-range BT.601) laid into a BT.709 limited-range
 * stream. Without an explicit conversion the overlay reads the JPEG's numbers
 * as BT.709 and the cover comes out in the wrong colour — a measured solid
 * (32,160,64) read back as (19,138,59). Strength 0 keeps the cover recipe from
 * moving the colour on purpose, so what is left is the conversion.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const COVER_RGB = [32, 160, 64] as const;

let dir: string;
let frame0: Buffer;
const W = 320;
const H = 240;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cover-colour-"));
  const clip = join(dir, "in.mp4");
  makeTestClip(clip, 2);
  const cover = join(dir, "cover.jpg");
  const hex = COVER_RGB.map((v) => v.toString(16).padStart(2, "0")).join("");
  const made = spawnSync(FFMPEG, [
    "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x${hex}:s=${W}x${H}`,
    "-frames:v", "1", "-q:v", "2", cover,
  ]);
  expect(made.status).toBe(0);

  const exec = new FfmpegExecutor();
  const info = await exec.probe(clip);
  const coverInfo = await new PhotoExecutor().probe(cover);
  const opts: ResolvedCopyOptions = {
    strength: 0,
    exportFormat: "original",
    keepTrendAudio: false,
    allowMirror: false,
    targetDistance: 38,
    identity: "engine",
    edgeMode: "auto",
    firstFrame: { mode: "photo", cover: { path: cover, edge: { mode: "crop" }, info: coverInfo } },
  };
  const out = join(dir, "out.mp4");
  await exec.render(clip, info, sampleRecipe(opts, 3, 1), out);
  const raw = spawnSync(
    FFMPEG,
    [
      "-v", "error", "-i", out, "-frames:v", "1",
      // Read it the way a player reads an untagged file: BT.709, limited range.
      "-vf", "scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24",
      "-f", "rawvideo", "-",
    ],
    { maxBuffer: W * H * 3 + 1024 }
  );
  expect(raw.status).toBe(0);
  frame0 = raw.stdout;
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Wrong conversion read 12 off on the worst channel; a correct one reads about 6 (JPEG and 8-bit round trips).
test("the cover on frame 0 keeps its colour when it goes into the BT.709 stream", () => {
  const at = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 3;
  const px = [frame0[at], frame0[at + 1], frame0[at + 2]];
  px.forEach((v, i) => expect(Math.abs(v - COVER_RGB[i])).toBeLessThan(8));
});
