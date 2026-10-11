import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { FRAGMENTS } from "../core/filters";
import type { MediaInfo } from "../core/types";

/**
 * A still's noise is uniform and lifts pure black; the fragment follows it with
 * a knee that takes that lift back out. The knee must only touch the lifted
 * floor: a version that rescaled the whole range darkened every shadow, which
 * is the complaint this mode of change exists to avoid.
 */

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");
const info: MediaInfo = { kind: "photo", durationSec: 0, width: 1080, height: 1920, hasAudio: false };
const W = 1080;
const H = 1920;

/** Mean and peak of the gray plane after `chain`, on `source` (a lavfi graph). */
function measure(source: string, chain: string, pix = "yuv420p"): { mean: number; max: number } {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-f", "lavfi", "-i", source, "-frames:v", "1", "-vf", `format=${pix},${chain}format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: W * H + 1024 }
  );
  expect(r.status).toBe(0);
  const d = r.stdout;
  let sum = 0;
  let max = 0;
  for (const v of d) {
    sum += v;
    if (v > max) max = v;
  }
  return { mean: sum / d.length, max };
}

const noiseChain = (strength: number): string => `${FRAGMENTS.noise({ strength, temporal: false }, info)},`;
const BLACK = `color=c=black:s=${W}x${H}:d=1`;
/** A dark horizontal ramp, 0..60: the shadows a black-point crush would eat. */
const DARK_RAMP = `nullsrc=s=${W}x${H}:d=1,geq=lum='X*60/${W}':cb=128:cr=128`;

test.each(["yuv420p", "yuvj420p"])("pure black stays exactly black under noise of any strength (%s)", (pix) => {
  for (let strength = 1; strength <= 12; strength++) {
    const { mean, max } = measure(BLACK, noiseChain(strength), pix);
    expect(max).toBe(0);
    expect(mean).toBe(0);
  }
});

test.each([[6, 0.5], [12, 1.1]])("a dark ramp keeps its mean under noise of strength %i, to within %f levels", (strength, tolerance) => {
  const source = measure(DARK_RAMP, "").mean;
  const noised = measure(DARK_RAMP, noiseChain(strength)).mean;
  // The noise alone moves the mean a little (clamping at black); the knee must
  // not add to it.
  expect(Math.abs(noised - source)).toBeLessThan(tolerance);
});

test("mid and light tones are untouched by the knee", () => {
  const frag = FRAGMENTS.noise({ strength: 12, temporal: false }, info) ?? "";
  // The knee ends at twice the lift: nothing above it is remapped.
  expect(frag).toContain("if(lt(val,minval+12),max(minval,minval+2*(val-minval-6)),val)");
});

test("strengths too small to lift black get no knee at all", () => {
  expect(FRAGMENTS.noise({ strength: 2, temporal: false }, info)).toBe("noise=c0s=2:c0f=u");
});

test("a still's noise is luma only, so it speckles no colour onto the picture", () => {
  const frag = FRAGMENTS.noise({ strength: 8, temporal: false }, info) ?? "";
  expect(frag).toContain("noise=c0s=8:c0f=u");
  expect(frag).not.toContain("alls");
});
