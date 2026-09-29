// Q1a: motion smoothness of each Ken Burns / pan technique, measured on the filter output
// (no encode in between), on full-resolution gray frames.
//
// Two metrics per clip:
//  1. jitterPx: the horizontal displacement of two 200x200 strips (left and right, on the
//     focus row) between consecutive frames is measured to sub-pixel accuracy (SSD block
//     match + parabola). The per-frame displacement series is fitted with a quadratic
//     (constant-speed pan and a linear zoom are smooth) and the RMS / max residual is the
//     judder in OUTPUT pixels. Integer snapping shows up as residuals of 0.3-1 px.
//  2. frame difference d[n] = mean|F[n+1]-F[n]|: stalls = d < 0.5 median (a repeated
//     picture), doubles = d > 1.6 median.
// It runs on a blurred-noise texture (every pixel carries detail) and on a real photo.
import { ff, PHOTOS, TEXTURE, W, H, saveResult } from "./common";
import { clipPart, FOCUS, type ClipSpec, type Tech, type Motion } from "./graphs";

async function gray(spec: ClipSpec, tech: Tech): Promise<Uint8Array[]> {
  const part = clipPart(spec, tech, 0, "a");
  const r = await ff([
    ...part.inputs, "-filter_complex", `${part.filters.join(";")};[${part.out}]format=gray[g]`,
    "-map", "[g]", "-r", "30", "-fps_mode", "cfr", "-f", "rawvideo", "-",
  ]);
  const size = W * H;
  const out: Uint8Array[] = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push(r.stdout.subarray(o, o + size));
  return out;
}

function mad(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

const PATCH = 200;
const MAXS = 4;
const ROW0 = Math.round(FOCUS.fy * H) - PATCH / 2;

/** Sub-pixel horizontal displacement of the strip at column x0 between frames a and b. */
function shiftX(a: Uint8Array, b: Uint8Array, x0: number): number {
  const e: number[] = [];
  for (let s = -MAXS; s <= MAXS; s++) {
    let sum = 0;
    for (let y = ROW0; y < ROW0 + PATCH; y++) {
      const ra = y * W + x0;
      const rb = y * W + x0 + s;
      for (let x = 0; x < PATCH; x++) {
        const d = a[ra + x]! - b[rb + x]!;
        sum += d * d;
      }
    }
    e.push(sum);
  }
  let m = 1;
  for (let i = 1; i < e.length - 1; i++) if (e[i]! < e[m]!) m = i;
  const den = e[m - 1]! - 2 * e[m]! + e[m + 1]!;
  const sub = den > 0 ? (0.5 * (e[m - 1]! - e[m + 1]!)) / den : 0;
  return m - MAXS + sub;
}

/** Residual of a quadratic least-squares fit (normal equations, 3x3). */
function quadResidual(y: number[]): number[] {
  const n = y.length;
  const xs = y.map((_, i) => i / (n - 1));
  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  xs.forEach((x, i) => {
    for (let k = 0; k < 5; k++) S[k]! += x ** k;
    for (let k = 0; k < 3; k++) T[k]! += y[i]! * x ** k;
  });
  const A = [
    [S[0]!, S[1]!, S[2]!, T[0]!],
    [S[1]!, S[2]!, S[3]!, T[1]!],
    [S[2]!, S[3]!, S[4]!, T[2]!],
  ];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[p]![i]!)) p = r;
    [A[i], A[p]] = [A[p]!, A[i]!];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r]![i]! / A[i]![i]!;
      for (let c = i; c < 4; c++) A[r]![c]! -= f * A[i]![c]!;
    }
  }
  const c = [0, 1, 2].map((i) => A[i]![3]! / A[i]![i]!);
  return xs.map((x, i) => y[i]! - (c[0]! + c[1]! * x + c[2]! * x * x));
}

function analyse(fr: Uint8Array[]) {
  const d = fr.slice(1).map((f, i) => mad(fr[i]!, f));
  const sorted = [...d].sort((p, q) => p - q);
  const med = sorted[Math.floor(d.length / 2)]!;
  const res: number[] = [];
  let meanShift = 0;
  for (const x0 of [40, W - 40 - PATCH]) {
    const sh = fr.slice(1).map((f, i) => shiftX(fr[i]!, f, x0));
    meanShift += sh.reduce((a, b) => a + Math.abs(b), 0) / sh.length / 2;
    res.push(...quadResidual(sh));
  }
  const rms = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / res.length);
  return {
    frames: fr.length,
    speedPxPerFrame: +meanShift.toFixed(3),
    jitterRmsPx: +rms.toFixed(3),
    jitterMaxPx: +Math.max(...res.map(Math.abs)).toFixed(3),
    stalls: med > 0 ? d.filter((v) => v < 0.5 * med).length : d.length,
    doubles: med > 0 ? d.filter((v) => v > 1.6 * med).length : 0,
  };
}

const PLAN: [Motion, Tech[]][] = [
  ["kb", ["zp1", "zp2", "zp4", "sc", "sc2", "sc2e", "sc4", "sc4e"]],
  ["pan", ["zp1", "zp2", "zp4", "cv1", "cv2", "cv2e", "cv4", "cv4e"]],
];

const results: Record<string, unknown>[] = [];
for (const [imgName, img] of [["texture", TEXTURE], ["photo", PHOTOS[0]!]] as const) {
  for (const [motion, techs] of PLAN) {
    for (const tech of techs) {
      const spec: ClipSpec = { kind: "photo", seconds: 4, motion, photos: [img], stagger: false, dir: 1 };
      const s = analyse(await gray(spec, tech));
      results.push({ image: imgName, motion, tech, ...s });
      console.log(imgName.padEnd(8), motion.padEnd(4), tech.padEnd(4), JSON.stringify(s));
    }
  }
}
saveResult("smoothness", results);
