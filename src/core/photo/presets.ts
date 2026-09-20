import type { ParamSpec } from "../presets";
import type { Subsampling } from "./types";

/** Photo deviations. Deliberately soft: PDQ sensitivity is strongly
 *  content-dependent (a gradient moves 42 where a texture moves 2), so the
 *  baseline aims at the easy case and the pipeline's auto-strengthen loop
 *  (`intensity *= 1.4`) climbs for the hard one.
 *
 *  Geometry and large-scale luminance restructuring lead, because they are the
 *  only levers measured to work on detailed content. Tone and noise stay small:
 *  on texture they buy almost nothing while inflating the file. */
export const PHOTO_PARAMS = {
  // Primary levers.
  windowPct: { neutral: 0.965, dev: 0.02 }, // one-sided downward: larger intensity = tighter crop
  pan: { neutral: 0, dev: 1.0 }, // window position inside the free margin, -1..1
  rotateDeg: { neutral: 0, dev: 0.15 },
  lensK1: { neutral: 0, dev: 0.01 },
  vignetteAngle: { neutral: 0.45, dev: 0.15 },
  vignetteCentre: { neutral: 0.5, dev: 0.12 }, // fraction of width/height

  // Secondary: ~0.6x the video deviations. They carry smooth content and keep
  // copies apart from each other; they are not relied on for the hash.
  //
  // The tonal block is shaped by one rule the video path does not have to obey:
  // NOTHING MAY LIFT PURE BLACK. A story sits on a flat black background, and
  // on the AMOLED screen it is read on a black pixel is an unlit pixel, so a
  // floor of 7/255 glows. A real copy measured exactly that — mean 7.07 over a
  // background the original had at 0.00 — while every hash check passed.
  //
  // `brightness` is therefore absent, unlike the video spread: `eq`'s is
  // additive and shifts the whole scale including zero (5/255 at 0.03, 43/255
  // at the 0.15 ceiling it used to have).
  //
  // `contrast` and `gamma` are drawn ONE-SIDED, which is what `devOneSided` in
  // the sampler is for. `eq` is multiplicative about mid-grey, not about zero,
  // so the floor becomes (0 - 0.5)*c + 0.5: any contrast below 1 lifts it, and
  // 0.8 was measured at 24/255 — worse than the brightness that sat beside it,
  // and reachable by auto-strengthen. gamma is the mirror image, 13/255 at
  // 1.25 and 0 at 0.8. Probing from above alone hides both: contrast 1.06
  // clamps the floor back to 0 and reads perfectly clean.
  //
  // The cost is half the range on two levers, and it is close to nothing: the
  // whole eq block moves PDQ by 0 on real content and by 2 at its strongest,
  // and on the smooth gradient where tone does work, half a range still works.
  contrast: { neutral: 1, dev: 0.036 }, // one-sided UP
  saturation: { neutral: 1, dev: 0.048 }, // two-sided: chroma never touches a grey
  gamma: { neutral: 1, dev: 0.036 }, // one-sided DOWN
  hueDeg: { neutral: 0, dev: 3.6 },
  noise: { neutral: 0, dev: 6 }, // one-sided
} satisfies Record<string, ParamSpec>;

/** Hard ceilings, enforced regardless of intensity. Auto-strengthen must never
 *  turn a photo into visible garbage, so every escalating lever saturates here.
 *  None of these bind at intensity 1 — they only cap the climb. */
export const PHOTO_LIMITS = {
  minWindowPct: 0.88, // a 12% crop is the most that stays unremarkable
  maxPan: 1, // the window can touch an edge, never leave the frame
  maxRotateDeg: 0.6,
  minVignetteAngle: 0.15, // ffmpeg needs angle >= 0; 0 would drop the lever entirely
  // 0.8 measured at 64/255 corner luma on a white frame — plainly visible. The
  // vignette is worth only ~4-10 bits of hash movement once it is artefact-free,
  // so it is not worth that risk.
  maxVignetteAngle: 0.6,
  // An off-centre vignette renders on a padded canvas (see the `vignette`
  // fragment); the pad grows with the offset, so ±0.12 keeps the intermediate
  // frame at ~1.6x the source pixels. It is exactly the intensity-1 draw range,
  // so the clamp only bites once auto-strengthen climbs.
  minVignetteCentre: 0.38,
  maxVignetteCentre: 0.62,
  maxNoise: 12,
  maxLensK1: 0.04,
  // The two floors that keep black at zero. They hold by arithmetic rather than
  // by measurement — (0 - 0.5)*c + 0.5 <= 0 for every c >= 1 — so they are the
  // neutral value itself, not a soft limit.
  minContrast: 1,
  maxContrast: 1.25,
  minSaturation: 0.7,
  maxSaturation: 1.3,
  minGamma: 0.8,
  maxGamma: 1,
  maxHueDeg: 12,
} as const;

/** mjpeg `-q:v`: 3..7 is visually indistinguishable while the quantisation
 *  tables differ, so it is a free file-level signature. */
export const JPEG_QUALITIES = [3, 4, 5, 6, 7] as const;

export const SUBSAMPLINGS: readonly Subsampling[] = ["420", "444"];
