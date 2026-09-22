import { makeRng, type Rng } from "./rng";
import { PARAMS } from "./presets";
import { round, clamp } from "./util";
import { samplePhotoRecipe } from "./photo/sampler";
import type { FirstFrame, Operation, Recipe, ResolvedCopyOptions } from "./types";

function dev(rng: Rng, key: keyof typeof PARAMS, scalar: number, oneSided = false): number {
  const spec = PARAMS[key];
  const mag = (oneSided ? rng() : rng() * 2 - 1) * spec.dev * scalar;
  return spec.neutral + mag;
}

const FPS_CHOICES = [24, 25, 30] as const;
const GOP_SECONDS = [2, 3, 4] as const;
// Slower presets compress better at equal quality, which is what fits a 15-30 s
// clip inside the 3500k ceiling without lowering crf; the random pick stays
// because the preset is part of the encoder fingerprint.
const PRESET_CHOICES = ["medium", "slow"] as const;
const AUDIO_KBPS_CHOICES = [96, 112, 128, 160] as const;
const SEGMENT_COUNTS = [3, 4, 5] as const;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * What frame 0 will be. The mode is copied; the cover, when there is one, is
 * DRAWN — by the photo sampler, from the same seed and intensity as the copy,
 * on an rng instance of its own. That is what lets every copy open on a
 * different rendition of the same picture while the video draws stay exactly
 * what they are with the mode off: the cover consumes nothing from the video's
 * generator. (Seeded the same, the two instances replay one sequence, so the
 * cover's first draws are correlated with the video's first draws. That is a
 * known property, not independence — the invariant pinned in the tests is
 * only that the video recipe does not move.)
 *
 * The cover's options are not the video's. It is never mirrored (a flipped
 * cover flips its text) and it keeps its own framing (`original`): the graph
 * fits it to the video afterwards, and sampling it to EXPORT_DIMS first would
 * crop it twice. Strength and edge are the video's and the route's.
 */
function firstFrameOf(opts: ResolvedCopyOptions, seed: number, intensity: number): FirstFrame {
  const ff = opts.firstFrame;
  if (ff.mode !== "photo") return { mode: ff.mode };
  const { path, edge, info } = ff.cover;
  const recipe = samplePhotoRecipe(
    {
      strength: opts.strength,
      exportFormat: "original",
      allowMirror: false,
      targetDistance: opts.targetDistance,
      identity: opts.identity,
      edge,
    },
    seed,
    intensity
  );
  return { mode: "photo", path, info, recipe };
}

export function sampleRecipe(opts: ResolvedCopyOptions, seed: number, intensity = 1): Recipe {
  const rng = makeRng(seed);
  const s = opts.strength * intensity;

  const video: Operation[] = [
    {
      id: "eq",
      params: {
        brightness: round(dev(rng, "brightness", s)),
        contrast: round(dev(rng, "contrast", s)),
        saturation: round(dev(rng, "saturation", s)),
        gamma: round(clamp(dev(rng, "gamma", s), 0.5, 2)),
      },
    },
    { id: "hue", params: { h: round(dev(rng, "hueDeg", s)) } },
  ];

  // Always apply a small zoom-crop (~3%) — visually a thin edge crop but shifts
  // the PDQ hash meaningfully via spatial resampling.
  const zoomPct = round(dev(rng, "zoomPct", s, true));
  video.push({ id: "zoomcrop", params: { zoomPct } });

  video.push(
    { id: "rotate", params: { deg: round(dev(rng, "rotateDeg", s)) } },
    { id: "perspective", params: { off: round(dev(rng, "perspective", s, true)) } },
    { id: "lenscorrection", params: { k1: round(dev(rng, "lens", s)) } },
    { id: "noise", params: { strength: Math.round(dev(rng, "noise", s, true)) } },
    { id: "vignette", params: { on: rng() < 0.6 * Math.min(1, s) } },
  );

  // Determinism invariant: same seed + same opts => same recipe. The mirror draw
  // below is conditional, so changing `allowMirror` shifts the rng stream for the
  // speed/crf/eqGain draws — that's intentional and acceptable.
  if (opts.allowMirror && rng() < 0.5) {
    video.push({ id: "hflip", params: { on: true } });
  }

  // Per-segment speed changes break the temporal fingerprint. Non-uniform
  // fractions so segment boundaries aren't a fixed pattern and no segment is
  // vanishingly small; each keeps the subtle PARAMS.speed spread (~±5%).
  const segCount = pick(rng, SEGMENT_COUNTS);
  const weights = Array.from({ length: segCount }, () => 0.5 + rng());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const segments = weights.map((w) => ({
    fraction: w / weightSum,
    speed: round(clamp(dev(rng, "speed", s), 0.9, 1.1)),
  }));
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 22));

  // Container/bitstream signature spread. Drawn here (before the conditional
  // audio draw) so they stay independent of `keepTrendAudio`, and they ignore
  // `s` so the encoder fingerprint is decoupled from the visual-change budget.
  const fps = pick(rng, FPS_CHOICES);
  const gop = fps * pick(rng, GOP_SECONDS);
  const keyintMin = fps;
  const preset = pick(rng, PRESET_CHOICES);
  const audioKbps = pick(rng, AUDIO_KBPS_CHOICES);

  const audio: Operation[] = opts.keepTrendAudio
    ? []
    : [{ id: "aeq", params: { gain: round(dev(rng, "eqGain", s)) } }];

  return {
    seed,
    intensity,
    exportFormat: opts.exportFormat,
    keepTrendAudio: opts.keepTrendAudio,
    identity: opts.identity,
    firstFrame: firstFrameOf(opts, seed, intensity),
    segments,
    video: [...video, { id: "encode", params: { crf, fps, gop, keyintMin, preset, audioKbps } }],
    audio,
  };
}
