import type { PresetName } from "./types";

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
  zoomPct: { neutral: 0, dev: 5 }, // one-sided (positive zoom)
  rotateDeg: { neutral: 0, dev: 0.6 },
  perspective: { neutral: 0, dev: 0.012 }, // one-sided corner offset fraction
  lens: { neutral: 0, dev: 0.04 },
  noise: { neutral: 0, dev: 10 }, // one-sided strength
  speed: { neutral: 1, dev: 0.05 },
  eqGain: { neutral: 0, dev: 2.5 },
  crf: { neutral: 21, dev: 2 },
} satisfies Record<string, ParamSpec>;

export const PRESET_SCALAR: Record<PresetName, number> = {
  light: 0.5,
  medium: 1.0,
  aggressive: 1.7,
};
