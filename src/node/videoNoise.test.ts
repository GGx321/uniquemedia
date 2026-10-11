import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { FRAGMENTS } from "../core/filters";
import type { MediaInfo } from "../core/types";

/**
 * ffmpeg's uniform noise of an even strength S draws from [-S/2, S/2 - 1], so
 * its mean is -0.5. Put on the chroma planes, that is half a level off Cb and
 * Cr on every pixel of every frame — measured at strength 8 as R-G -1.05 and
 * B-G -1.2, a green cast. The video's grain goes on luma alone, as a still's
 * already does: PDQ reads luma only, so the chroma grain bought no distance.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const info: MediaInfo = { kind: "video", durationSec: 1, width: 256, height: 256, hasAudio: false };
const W = 256;
const H = 256;
const GREY = `color=c=0x808080:s=${W}x${H}:d=1`;

/** Mean Cb and Cr of one yuv420p frame of `source` after `chain`. */
function chroma(chain: string): { u: number; v: number } {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-f", "lavfi", "-i", GREY, "-frames:v", "1", "-vf", `format=yuv420p,${chain}format=yuv420p`, "-f", "rawvideo", "-"],
    { maxBuffer: W * H * 2 + 1024 }
  );
  expect(r.status).toBe(0);
  const d = r.stdout;
  const luma = W * H;
  const n = luma / 4;
  expect(d.length).toBe(luma + 2 * n);
  let u = 0;
  let v = 0;
  for (let i = 0; i < n; i++) {
    u += d[luma + i];
    v += d[luma + n + i];
  }
  return { u: u / n, v: v / n };
}

test.each([7, 8, 13, 14])("the video's noise leaves the chroma means where they were (strength %i)", (strength) => {
  const before = chroma("");
  const after = chroma(`${FRAGMENTS.noise({ strength }, info)},`);
  expect(Math.abs(after.u - before.u)).toBeLessThanOrEqual(0.25);
  expect(Math.abs(after.v - before.v)).toBeLessThanOrEqual(0.25);
});
