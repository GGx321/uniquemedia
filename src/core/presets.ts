export interface ParamSpec {
  neutral: number;
  dev: number; // base max absolute deviation at scalar 1.0
}

export const PARAMS = {
  brightness: { neutral: 0, dev: 0.05 },
  contrast: { neutral: 1, dev: 0.06 },
  saturation: { neutral: 1, dev: 0.08 },
  gamma: { neutral: 1, dev: 0.06 },
  hueDeg: { neutral: 0, dev: 6 },
  zoomPct: { neutral: 0, dev: 8 }, // one-sided (positive zoom) — invisible but shifts the hash
  rotateDeg: { neutral: 0, dev: 0.05 }, // effectively invisible rotation
  perspective: { neutral: 0, dev: 0.002 }, // effectively invisible tilt
  lens: { neutral: 0, dev: 0.015 }, // barely-there lens distortion
  noise: { neutral: 0, dev: 14 }, // one-sided strength — invisible grain, strong hash shift
  speed: { neutral: 1, dev: 0.05 },
  eqGain: { neutral: 0, dev: 2.5 },
  crf: { neutral: 21, dev: 2 },
  resampleAmt: { neutral: 5, dev: 8 }, // one-sided floor, 5..13% × strength; used when keepResolution
  lumashiftBr: { neutral: 0, dev: 0.4 }, // brightness component of the luma hash-breaker (±0.4)
  lumashiftCt: { neutral: 1, dev: 0.35 }, // contrast component of the luma hash-breaker (0.65..1.35)
} satisfies Record<string, ParamSpec>;

