import { makeRng, type Rng } from "./rng";
import { PARAMS } from "./presets";
import { round, clamp } from "./util";
import type { CopyOptions, Operation, Recipe } from "./types";

function dev(rng: Rng, key: keyof typeof PARAMS, scalar: number, oneSided = false): number {
  const spec = PARAMS[key];
  const mag = (oneSided ? rng() : rng() * 2 - 1) * spec.dev * scalar;
  return spec.neutral + mag;
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

  // Always draw zoomPct to keep the rng stream stable regardless of keepResolution;
  // only emit the zoomcrop op when the user allows cropping. zoomcrop zooms ~8% then
  // crops back, which visibly eats the frame edges — keepResolution skips it.
  const zoomPct = round(dev(rng, "zoomPct", s, true));
  if (!opts.keepResolution) {
    video.push({ id: "zoomcrop", params: { zoomPct } });
  }

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

  const speed = round(clamp(dev(rng, "speed", s), 0.9, 1.1));
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 26));

  const audio: Operation[] = opts.keepTrendAudio
    ? []
    : [{ id: "aeq", params: { gain: round(dev(rng, "eqGain", s)) } }];

  return {
    seed,
    intensity,
    exportFormat: opts.exportFormat,
    keepTrendAudio: opts.keepTrendAudio,
    spoof: opts.spoofMetadata,
    video: [...video, { id: "speed", params: { speed } }, { id: "encode", params: { crf } }],
    audio,
  };
}
