export interface ParamSpec {
  neutral: number;
  dev: number; // base max absolute deviation at scalar 1.0
}

export const PARAMS = {
  contrast: { neutral: 1, dev: 0.06 },
  saturation: { neutral: 1, dev: 0.08 },
  zoomPct: { neutral: 5, dev: 3 }, // guaranteed 5..8% zoom — enough crop to shift the hash on static content
  rotateDeg: { neutral: 0, dev: 0.05 }, // effectively invisible rotation
  perspective: { neutral: 0, dev: 0.002 }, // effectively invisible tilt
  lens: { neutral: 0, dev: 0.015 }, // barely-there lens distortion
  noise: { neutral: 0, dev: 14 }, // one-sided strength — invisible grain, strong hash shift
  speed: { neutral: 1, dev: 0.05 },
  eqGain: { neutral: 0, dev: 2.5 },
  crf: { neutral: 18.5, dev: 1.5 }, // 17..20 at scalar 1 — Instagram re-encodes every upload, so deliver high quality
} satisfies Record<string, ParamSpec>;

