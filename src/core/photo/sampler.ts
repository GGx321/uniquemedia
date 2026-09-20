import { makeRng, rngPick, type Rng } from "../rng";
import { clamp, round } from "../util";
import { JPEG_QUALITIES, PHOTO_LIMITS, PHOTO_PARAMS, SUBSAMPLINGS } from "./presets";
import type { Operation } from "../types";
import type { PhotoRecipe, ResolvedPhotoOptions } from "./types";

type Key = keyof typeof PHOTO_PARAMS;

/** Symmetric deviation around the neutral value, scaled by the strength budget. */
function dev(rng: Rng, key: Key, scalar: number): number {
  const spec = PHOTO_PARAMS[key];
  return spec.neutral + (rng() * 2 - 1) * spec.dev * scalar;
}

/** One-sided deviation: `+1` grows away from neutral, `-1` shrinks below it. */
function devOneSided(rng: Rng, key: Key, scalar: number, sign: 1 | -1): number {
  const spec = PHOTO_PARAMS[key];
  return spec.neutral + sign * rng() * spec.dev * scalar;
}

export function samplePhotoRecipe(
  opts: ResolvedPhotoOptions,
  seed: number,
  intensity = 1
): PhotoRecipe {
  const rng = makeRng(seed);
  const s = opts.strength * intensity;
  const LIM = PHOTO_LIMITS;

  /** Draw a symmetric deviation, then clamp it to its hard safety ceiling. The
   *  ceiling is what keeps auto-strengthen from producing visible garbage. */
  const draw = (key: Key, min: number, max: number, digits = 4): number =>
    round(clamp(dev(rng, key, s), min, max), digits);

  /** Same, for a lever that may only move one way. Consumes exactly one rng
   *  value, like `draw`, so switching a lever between the two forms does not
   *  shift the sequence for everything after it. */
  const drawOneSided = (key: Key, sign: 1 | -1, min: number, max: number, digits = 4): number =>
    round(clamp(devOneSided(rng, key, s, sign), min, max), digits);

  const ops: Operation[] = [
    {
      // Shaped so that nothing here can lift pure black, which is what a story
      // is built on. No `brightness` at all — `eq`'s is additive and shifts the
      // whole scale including zero. `contrast` only upward and `gamma` only
      // downward — `eq` is multiplicative about mid-grey, so the other half of
      // each range raises the floor (measured 24/255 at contrast 0.8, 13/255 at
      // gamma 1.25). `saturation` keeps both halves: it scales chroma and
      // leaves a grey of any level where it was. See PHOTO_PARAMS.
      id: "eq",
      params: {
        contrast: drawOneSided("contrast", 1, LIM.minContrast, LIM.maxContrast),
        saturation: draw("saturation", LIM.minSaturation, LIM.maxSaturation),
        gamma: drawOneSided("gamma", -1, LIM.minGamma, LIM.maxGamma),
      },
    },
    { id: "hue", params: { h: draw("hueDeg", -LIM.maxHueDeg, LIM.maxHueDeg) } },
  ];

  // Primary lever, drawn once and applied in whichever direction the edge mode
  // asks for: `pancrop` cuts the window out and scales it back up, `fitpad`
  // shrinks the picture into the same window and fills the margin. One draw for
  // both, so flipping the mode moves the same part of the frame and the safety
  // ceiling below binds either way.
  const windowPct = round(clamp(devOneSided(rng, "windowPct", s, -1), LIM.minWindowPct, 1));
  const panX = draw("pan", -LIM.maxPan, LIM.maxPan);
  const panY = draw("pan", -LIM.maxPan, LIM.maxPan);
  const edge = opts.edge;
  const preserveEdges = edge.mode === "fit";
  ops.push(
    edge.mode === "fit"
      ? { id: "fitpad", params: { scalePct: windowPct, panX, panY, padColor: edge.padColor } }
      : { id: "pancrop", params: { windowPct, panX, panY } }
  );

  // Both of these need the graph's cover step: `rotate` widens the canvas and
  // `lenscorrection` samples past the source edge, and the cover crops the
  // largest guaranteed-real rectangle and scales it back — measured at ~2% of
  // the frame for a baseline draw, 11 px off a 1080-wide still. That crop is
  // centred, so on the side `fitpad` pushed flush against the frame it takes
  // real picture, which is exactly what preserving the edge is meant to stop.
  // So they are drawn either way — the rng sequence must not depend on the
  // mode — and then applied only when the edge is being cropped anyway.
  const rotateDeg = draw("rotateDeg", -LIM.maxRotateDeg, LIM.maxRotateDeg);
  const lensK1 = draw("lensK1", -LIM.maxLensK1, LIM.maxLensK1, 5);
  ops.push(
    { id: "rotate", params: { deg: preserveEdges ? 0 : rotateDeg } },
    { id: "lenscorrection", params: { k1: preserveEdges ? 0 : lensK1 } }
  );

  // Primary lever: the vignette centre is drawn per copy. A fixed one would
  // separate copies from the original but leave them sharing a signature.
  ops.push({
    id: "vignette",
    params: {
      angle: draw("vignetteAngle", LIM.minVignetteAngle, LIM.maxVignetteAngle),
      x0: draw("vignetteCentre", LIM.minVignetteCentre, LIM.maxVignetteCentre),
      y0: draw("vignetteCentre", LIM.minVignetteCentre, LIM.maxVignetteCentre),
    },
  });

  // Secondary: spatial-only noise. `temporal: false` drops ffmpeg's `t` flag,
  // which is meaningless for a single frame.
  ops.push({
    id: "noise",
    params: {
      strength: Math.round(clamp(devOneSided(rng, "noise", s, 1), 0, LIM.maxNoise)),
      temporal: false,
    },
  });

  // Determinism invariant: same seed + same opts => same recipe. This draw is
  // conditional, so toggling `allowMirror` shifts the encode draws below —
  // intentional, same as the video sampler.
  if (opts.allowMirror && rng() < 0.5) {
    ops.push({ id: "hflip", params: { on: true } });
  }

  // Encoder fingerprint: drawn independently of `s` so escalating the visual
  // budget never drags the file signature with it.
  const quality = rngPick(rng, JPEG_QUALITIES);
  const subsampling = rngPick(rng, SUBSAMPLINGS);

  return {
    seed,
    intensity,
    exportFormat: opts.exportFormat,
    ops,
    encode: { quality, subsampling },
  };
}
