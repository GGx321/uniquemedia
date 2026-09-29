import { cosTurns, sinTurns, type Contour, type Raster, type Rgb } from "./raster";
import { beat, circle, cubicShape, ellipse, frac, hash32, place, unitRect, unitStar } from "./shapes";

// The ten built-in sticker designs. Each draws frame `i` of a loop of `n`
// frames with t = i / n in [0, 1). Every motion is a function of t that has
// the same value at t = 0 and t = 1 (whole turns, integer multiples of t, or
// symmetry), so the loop closes without a jump, except where a design says a
// restart is the point (the lightning strike).

export type Design = (r: Raster, i: number, n: number) => void;

const WHITE: Rgb = [255, 255, 255];

// ---- heart-pulse ----------------------------------------------------------
const HEART: Contour = cubicShape(
  [0, 0.95],
  [
    [-0.25, 0.7, -1.0, 0.25, -1.0, -0.25],
    [-1.0, -0.75, -0.35, -0.85, 0, -0.4],
    [0.35, -0.85, 1.0, -0.75, 1.0, -0.25],
    [1.0, 0.25, 0.25, 0.7, 0, 0.95],
  ],
);

const heartPulse: Design = (r, i, n) => {
  const b = beat(i / n);
  const s = 0.9 + 0.14 * b;
  const k = 34 * s;
  r.glow(50, 52, 46, [255, 77, 109], 0.25 + 0.3 * b);
  r.fill([place(HEART, 50, 52, k)], { kind: "vertical", y0: 52 - 0.85 * k, y1: 52 + 0.95 * k, from: [255, 120, 140], to: [201, 24, 74] });
  r.fill([ellipse(50 - 13 * s, 52 - 13 * s, 7 * s, 4.2 * s, -0.12)], { kind: "solid", rgb: WHITE, alpha: 0.45 }, 1.5);
};

// ---- sparkle-twinkle ------------------------------------------------------
const STAR4 = unitStar(4, 0.22);

const sparkleTwinkle: Design = (r, i, n) => {
  const t = i / n;
  const turns = t * 0.25;
  const paint = (cy: number, size: number) =>
    ({ kind: "vertical", y0: cy - size, y1: cy + size, from: [255, 252, 225], to: [255, 208, 60] }) as const;
  const stars: readonly (readonly [number, number, number, number])[] = [
    [50, 50, 32, 0],
    [24, 27, 10, 1 / 3],
    [77, 72, 12, 2 / 3],
    [79, 24, 7, 0.5],
    [23, 74, 6, 0.17],
  ];
  r.glow(50, 50, 40, [255, 210, 80], 0.15 + 0.3 * beat(t));
  for (const [x, y, size, phase] of stars) {
    const s = size * (0.55 + 0.45 * beat(t + phase));
    r.fill([place(STAR4, x, y, s, s, turns)], paint(y, s));
  }
};

// ---- star-spin ------------------------------------------------------------
const STAR5 = unitStar(5, 0.46);

const starSpin: Design = (r, i, n) => {
  const t = i / n;
  const flip = Math.max(0.1, Math.abs(cosTurns(t)));
  const wobble = 0.02 * sinTurns(t);
  r.glow(50, 52, 46, [255, 200, 40], 0.3);
  r.fill([place(STAR5, 50, 54, 42 * flip, 42, wobble)], { kind: "vertical", y0: 12, y1: 92, from: [255, 176, 20], to: [230, 119, 0] });
  r.fill([place(STAR5, 50, 55, 33 * flip, 33, wobble)], { kind: "vertical", y0: 22, y1: 86, from: [255, 240, 130], to: [255, 200, 30] });
  r.fill([ellipse(50 - 8 * flip, 40, 4 * flip, 6, -0.04)], { kind: "solid", rgb: WHITE, alpha: 0.5 }, 1.5);
};

// ---- fire-flicker ---------------------------------------------------------
const FLAME: Contour = cubicShape(
  [0, -1],
  [
    [0.15, -0.5, 0.9, 0.05, 0.75, 0.5],
    [0.65, 0.85, 0.35, 0.98, 0, 0.98],
    [-0.35, 0.98, -0.65, 0.85, -0.75, 0.5],
    [-0.9, 0.05, -0.15, -0.5, 0, -1],
  ],
);

const EMBER_DRIFT: readonly number[] = [12, -14, 6];

const fireFlicker: Design = (r, i, n) => {
  const t = i / n;
  const sway = 0.28 * sinTurns(t);
  const h = 1 + 0.06 * sinTurns(2 * t + 0.3);
  // Bends the flame's tip sideways: the higher a point, the further it moves.
  const shear = (c: Contour, amount: number): Contour => c.map((p) => ({ x: p.x + amount * (p.y < 0 ? -p.y : 0) * 0.5, y: p.y }));
  r.glow(50, 60, 46, [255, 120, 20], 0.32 + 0.1 * sinTurns(2 * t));
  r.fill([place(shear(FLAME, sway), 50, 56, 29, 37 * h)], { kind: "vertical", y0: 18, y1: 94, from: [255, 176, 40], to: [214, 40, 40] });
  r.fill([place(shear(FLAME, -sway), 30, 74, 9, 15 * (1 + 0.15 * sinTurns(t + 0.2)))], { kind: "vertical", y0: 58, y1: 90, from: [255, 150, 40], to: [230, 60, 30] });
  r.fill([place(shear(FLAME, sway), 70, 72, 10, 17 * (1 + 0.12 * sinTurns(t + 0.6)))], { kind: "vertical", y0: 55, y1: 90, from: [255, 150, 40], to: [230, 60, 30] });
  r.fill([place(shear(FLAME, sway * 1.3), 50, 68, 17, 22 * (1 - 0.05 * sinTurns(2 * t)))], { kind: "vertical", y0: 44, y1: 90, from: [255, 240, 120], to: [255, 170, 30] });
  r.fill([place(shear(FLAME, sway * 1.6), 50, 78, 8, 11)], { kind: "solid", rgb: [255, 252, 220], alpha: 0.9 }, 1);
  for (let e = 0; e < 3; e++) {
    const phase = e / 3;
    const f = frac(t + phase);
    const x = 50 + (EMBER_DRIFT[e] ?? 0) * sinTurns(t + phase * 0.7);
    r.fill([circle(x, 64 - 52 * f, 1.4 + 0.9 * (1 - f))], { kind: "solid", rgb: [255, 200, 70], alpha: 0.9 * (1 - f) }, 0.6);
  }
};

// ---- lightning-flash ------------------------------------------------------
const BOLT: Contour = [
  { x: 4, y: -42 },
  { x: -20, y: 6 },
  { x: -3, y: 6 },
  { x: -12, y: 42 },
  { x: 22, y: -10 },
  { x: 5, y: -10 },
  { x: 20, y: -42 },
];

const lightningFlash: Design = (r, i, n) => {
  const t = i / n;
  // A strike at t = 0 that decays: the loop restarts on purpose.
  const strike = (1 - t) * (1 - t) * (1 - t);
  const s = 1 + 0.05 * strike;
  r.glow(50, 50, 48, [255, 226, 80], 0.15 + 0.6 * strike);
  r.fill([place(BOLT, 50, 50, 1.05 * s)], { kind: "solid", rgb: [255, 170, 0], alpha: 0.9 }, 2);
  r.fill([place(BOLT, 50, 50, 0.97 * s)], { kind: "vertical", y0: 8, y1: 92, from: [255, 250, 190], to: [255, 205, 30] });
  r.fill([place(BOLT, 50, 49, 0.55 * s)], { kind: "solid", rgb: WHITE, alpha: 0.35 + 0.5 * strike }, 1);
};

// ---- bubble-float ---------------------------------------------------------
const BUBBLES: readonly (readonly [x: number, r: number, phase: number, wobble: number])[] = [
  [22, 11, 0.0, 0.0],
  [70, 15, 0.17, 0.3],
  [45, 8, 0.42, 0.6],
  [82, 7, 0.63, 0.1],
  [30, 6, 0.8, 0.45],
  [58, 12, 0.9, 0.75],
];

const bubbleFloat: Design = (r, i, n) => {
  const t = i / n;
  for (const [x0, rad, phase, wob] of BUBBLES) {
    // The centre travels from just below the frame to just above it, so a bubble never pops in or out.
    const y = 102 + rad - (104 + 2 * rad) * frac(t + phase);
    const x = x0 + 3 * sinTurns(t + phase + wob);
    r.fill([circle(x, y, rad)], { kind: "solid", rgb: [150, 210, 255], alpha: 0.16 });
    r.fill([circle(x, y, rad), circle(x, y, rad - 1.4)], { kind: "solid", rgb: [190, 235, 255], alpha: 0.75 }, 0.4);
    r.fill([ellipse(x - rad * 0.35, y - rad * 0.4, rad * 0.28, rad * 0.16, -0.12)], { kind: "solid", rgb: WHITE, alpha: 0.85 }, 0.5);
    r.fill([circle(x + rad * 0.4, y + rad * 0.45, rad * 0.1)], { kind: "solid", rgb: WHITE, alpha: 0.5 }, 0.4);
  }
};

// ---- sun-rays -------------------------------------------------------------
const RAY_LONG: Contour = [
  { x: -2.8, y: -27 },
  { x: 2.8, y: -27 },
  { x: 1.5, y: -42 },
  { x: -1.5, y: -42 },
];
const RAY_SHORT: Contour = [
  { x: -2.6, y: -27 },
  { x: 2.6, y: -27 },
  { x: 1.4, y: -36 },
  { x: -1.4, y: -36 },
];

const sunRays: Design = (r, i, n) => {
  const t = i / n;
  // Long and short rays alternate, so the pattern repeats every 1/6 turn.
  const spin = t / 6;
  r.glow(50, 50, 49, [255, 200, 60], 0.3 + 0.12 * sinTurns(t));
  for (let k = 0; k < 12; k++) {
    r.fill([place(k % 2 === 0 ? RAY_LONG : RAY_SHORT, 50, 50, 1, 1, k / 12 + spin)], { kind: "solid", rgb: [255, 190, 40] }, 0.5);
  }
  r.fill([circle(50, 50, 22)], { kind: "vertical", y0: 28, y1: 72, from: [255, 232, 110], to: [255, 146, 43] });
  r.fill([ellipse(42, 41, 8, 5, -0.12)], { kind: "solid", rgb: WHITE, alpha: 0.4 }, 1.5);
};

// ---- confetti-fall --------------------------------------------------------
const CONFETTI_COLOURS: readonly Rgb[] = [
  [255, 89, 94],
  [255, 202, 58],
  [138, 201, 38],
  [25, 130, 196],
  [106, 76, 147],
  [255, 146, 76],
];
const CONFETTI_COUNT = 16;

const confettiFall: Design = (r, i, n) => {
  const t = i / n;
  for (let p = 0; p < CONFETTI_COUNT; p++) {
    const h1 = hash32(p * 4 + 1);
    const h2 = hash32(p * 4 + 2);
    const h3 = hash32(p * 4 + 3);
    const h4 = hash32(p * 4 + 4);
    const x0 = 6 + (h1 % 88);
    const phase = (h2 % 1000) / 1000;
    const rot0 = (h3 % 1000) / 1000;
    const spin = 1 + (h3 % 2);
    const size = 2.4 + (h4 % 20) / 10;
    const rgb = CONFETTI_COLOURS[h4 % CONFETTI_COLOURS.length] ?? WHITE;
    const y = -6 + 112 * frac(t + phase);
    const x = x0 + 5 * sinTurns(t + (h2 % 97) / 97);
    const flip = 0.25 + 0.75 * Math.abs(cosTurns(2 * t + phase));
    const shape = h1 % 3;
    if (shape === 0) r.fill([place(unitRect(1, 0.55), x, y, size * 1.6, size * 1.6 * flip, rot0 + spin * t)], { kind: "solid", rgb }, 0.3);
    else if (shape === 1) r.fill([place(unitRect(0.35, 1.5), x, y, size, size * flip, rot0 + spin * t)], { kind: "solid", rgb }, 0.3);
    else r.fill([circle(x, y, size * 0.6 * (0.6 + 0.4 * flip))], { kind: "solid", rgb }, 0.3);
  }
};

// ---- ripple-rings ---------------------------------------------------------
const RING_COLOURS: readonly Rgb[] = [
  [64, 224, 208],
  [124, 92, 255],
  [255, 105, 180],
];

const rippleRings: Design = (r, i, n) => {
  const t = i / n;
  for (let k = 0; k < 3; k++) {
    const f = frac(t + k / 3);
    const radius = 9 + 38 * f;
    const thick = 1 + 3.4 * (1 - f * 0.5);
    // Fade in over the first tenth and out towards the end: no ring pops at the wrap.
    const alpha = Math.min(1, f * 8) * (1 - f) * (1 - f) * 0.95;
    r.fill([circle(50, 50, radius), circle(50, 50, radius - thick)], { kind: "solid", rgb: RING_COLOURS[k] ?? WHITE, alpha }, 0.8);
  }
  const b = beat(t);
  r.glow(50, 50, 20, [120, 240, 230], 0.45);
  r.fill([circle(50, 50, 6 + 1.6 * b)], { kind: "vertical", y0: 42, y1: 58, from: [255, 255, 255], to: [64, 224, 208] });
};

// ---- arrow-bounce ---------------------------------------------------------
const ARROW: Contour = [
  { x: -10, y: -36 },
  { x: 10, y: -36 },
  { x: 10, y: -2 },
  { x: 24, y: -2 },
  { x: 0, y: 30 },
  { x: -24, y: -2 },
  { x: -10, y: -2 },
];

const arrowBounce: Design = (r, i, n) => {
  const t = i / n;
  const air = Math.abs(sinTurns(t / 2));
  const lift = 12 * air;
  const squash = (1 - air) * (1 - air);
  const k = 0.82;
  const sx = k * (1 + 0.07 * squash);
  const sy = k * (1 - 0.09 * squash);
  const cy = 54 - lift;
  r.fill([ellipse(50, 90, 22 * (1 - 0.35 * air), 3.6 * (1 - 0.35 * air))], { kind: "solid", rgb: [0, 0, 0], alpha: 0.28 }, 2);
  r.fill([place(ARROW, 50, cy, 1.17 * sx, 1.17 * sy)], { kind: "solid", rgb: WHITE }, 0.5);
  r.fill([place(ARROW, 50, cy, sx, sy)], { kind: "vertical", y0: cy - 30, y1: cy + 25, from: [255, 96, 118], to: [214, 20, 60] });
  r.fill([ellipse(45, cy - 17, 2.5, 7.5)], { kind: "solid", rgb: WHITE, alpha: 0.3 }, 1);
};

/** The draw function of every built-in sticker, by manifest id. */
export const DESIGNS: Readonly<Record<string, Design>> = {
  "heart-pulse": heartPulse,
  "sparkle-twinkle": sparkleTwinkle,
  "star-spin": starSpin,
  "fire-flicker": fireFlicker,
  "lightning-flash": lightningFlash,
  "bubble-float": bubbleFloat,
  "sun-rays": sunRays,
  "confetti-fall": confettiFall,
  "ripple-rings": rippleRings,
  "arrow-bounce": arrowBounce,
};
