import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { FRAGMENTS } from "../core/filters";
import type { MediaInfo } from "../core/types";

/**
 * The recipe's tone op runs on every copy — video, still and cover alike — and
 * its saturation is always drawn above 1. ffmpeg's `eq` does saturation in
 * integer arithmetic that maps neutral chroma 128 to 127 on both planes, so
 * every pixel picked up the same small green-yellow push: a real clip's R-G
 * fell from +8.21 to +5.67 at `saturation=1.005`. The op has to leave a
 * neutral pixel neutral, and pure black on the floor of whatever range the
 * plane is in.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const info: MediaInfo = { kind: "video", durationSec: 1, width: 64, height: 64, hasAudio: false };
const W = 64;
const H = 64;

interface Planes {
  y: number;
  u: number;
  v: number;
  yMin: number;
}

/** Plane means of one frame of `source` in `pix`, after `chain`. Planar 8-bit
 *  only: the planes are read straight off the raw dump. */
function planes(source: string, chain: string, pix: string): Planes {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-f", "lavfi", "-i", source, "-frames:v", "1", "-vf", `format=${pix},${chain}format=${pix}`, "-f", "rawvideo", "-"],
    { maxBuffer: W * H * 3 + 1024 }
  );
  expect(r.status).toBe(0);
  const d = r.stdout;
  const luma = W * H;
  const chroma = pix.includes("444") ? luma : luma / 4;
  expect(d.length).toBe(luma + 2 * chroma);
  const mean = (from: number, n: number) => {
    let sum = 0;
    for (let i = from; i < from + n; i++) sum += d[i];
    return sum / n;
  };
  let yMin = 255;
  for (let i = 0; i < luma; i++) if (d[i] < yMin) yMin = d[i];
  return { y: mean(0, luma), u: mean(luma, chroma), v: mean(luma + chroma, chroma), yMin };
}

const tone = (contrast: number, saturation: number): string =>
  `${FRAGMENTS.eq({ contrast, saturation }, info)},`;

const GREY = `color=c=0x808080:s=${W}x${H}:d=1`;
const WHITE = `color=c=white:s=${W}x${H}:d=1`;
const BLACK = `color=c=black:s=${W}x${H}:d=1`;

// Limited range is the video and the cover's stream; the yuvj forms are a
// JPEG still, which the photo path works on in place.
const FORMATS = ["yuv420p", "yuvj420p", "yuvj444p"];

test.each(FORMATS)("a mid-grey frame stays neutral under contrast and saturation (%s)", (pix) => {
  const out = planes(GREY, tone(1.04, 1.05), pix);
  expect(Math.abs(out.u - 128)).toBeLessThanOrEqual(0.25);
  expect(Math.abs(out.v - 128)).toBeLessThanOrEqual(0.25);
});

test.each(FORMATS)("white stays neutral under contrast and saturation (%s)", (pix) => {
  const out = planes(WHITE, tone(1.04, 1.05), pix);
  expect(Math.abs(out.u - 128)).toBeLessThanOrEqual(0.25);
  expect(Math.abs(out.v - 128)).toBeLessThanOrEqual(0.25);
  // And white is still white: the plane's ceiling, not pulled under it.
  expect(out.y).toBe(planes(WHITE, "", pix).y);
});

test.each(FORMATS)("contrast leaves mid-grey where it was (%s)", (pix) => {
  // Contrast pivots on the middle of the plane's range, so the pivot itself
  // does not move — `eq`'s truncating arithmetic took a level off it.
  const before = planes(GREY, "", pix).y;
  expect(Math.abs(planes(GREY, tone(1.04, 1.05), pix).y - before)).toBeLessThanOrEqual(0.5);
});

test.each([["yuv420p", 16], ["yuvj420p", 0], ["yuvj444p", 0]] as const)(
  "pure black stays on the floor of its range under contrast (%s -> %i)",
  (pix, floor) => {
    const out = planes(BLACK, tone(1.25, 1.3), pix);
    expect(out.yMin).toBe(floor);
    expect(out.y).toBe(floor);
  }
);
