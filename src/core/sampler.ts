import { makeRng, type Rng } from "./rng";
import { PARAMS } from "./presets";
import { round, clamp } from "./util";
import type { CopyOptions, Operation, Recipe } from "./types";

function dev(rng: Rng, key: keyof typeof PARAMS, scalar: number, oneSided = false): number {
  const spec = PARAMS[key];
  const mag = (oneSided ? rng() : rng() * 2 - 1) * spec.dev * scalar;
  return spec.neutral + mag;
}

const FPS_CHOICES = [24, 25, 30] as const;
const GOP_SECONDS = [2, 3, 4] as const;
const PRESET_CHOICES = ["faster", "veryfast"] as const;
const AUDIO_KBPS_CHOICES = [96, 112, 128, 160] as const;
const SEGMENT_COUNTS = [3, 4, 5] as const;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function sampleRecipe(opts: CopyOptions, seed: number, intensity = 1): Recipe {
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
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 26));

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
    spoof: opts.spoofMetadata,
    segments,
    video: [...video, { id: "encode", params: { crf, fps, gop, keyintMin, preset, audioKbps } }],
    audio,
  };
}
