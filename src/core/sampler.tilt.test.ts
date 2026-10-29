import { test, expect } from "bun:test";
import { sampleRecipe } from "./sampler";
import type { Operation, ResolvedCopyOptions } from "./types";

const MAX_TILT = 0.1;

const base: ResolvedCopyOptions = {
  strength: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: true,
  targetDistance: 38,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
  distortion: false,
  distortionAxis: "h",
  distortionStrength: 0,
};
const on: ResolvedCopyOptions = { ...base, distortion: true, distortionStrength: 1 };

const tiltOf = (o: ResolvedCopyOptions, seed: number): Operation | undefined =>
  sampleRecipe(o, seed, 1).video.find((op) => op.id === "tilt");

test("distortion off: the recipe has no tilt op", () => {
  for (let seed = 0; seed < 50; seed++) expect(tiltOf(base, seed)).toBeUndefined();
});

test("distortion on with strength 0: the recipe has no tilt op", () => {
  expect(tiltOf({ ...on, distortionStrength: 0 }, 1)).toBeUndefined();
});

test("distortion off: the recipe is exactly what shipped before the mode existed (seed 7)", () => {
  // Captured from the sampler before the tilt op was added.
  expect(sampleRecipe(base, 7, 1)).toEqual({
    seed: 7,
    intensity: 1,
    exportFormat: "reels",
    keepTrendAudio: false,
    identity: "engine",
    firstFrame: { mode: "off" },
    segments: [
      { fraction: 0.31471957268672895, speed: 1.0018 },
      { fraction: 0.1939299932083841, speed: 0.9697 },
      { fraction: 0.1678615065551731, speed: 0.9868 },
      { fraction: 0.32348892754971387, speed: 0.9793 },
    ],
    video: [
      { id: "eq", params: { contrast: 1.0007, saturation: 1.005 } },
      { id: "zoomcrop", params: { zoomPct: 7.9307 } },
      { id: "rotate", params: { deg: 0.0199 } },
      { id: "perspective", params: { off: 0.001 } },
      { id: "lenscorrection", params: { k1: -0.0028 } },
      { id: "noise", params: { strength: 7 } },
      { id: "hflip", params: { on: true } },
      { id: "encode", params: { crf: 19, fps: 24, gop: 96, keyintMin: 24, preset: "medium", audioKbps: 224 } },
    ],
    audio: [{ id: "aeq", params: { gain: -1.546 } }],
  });
});

test("turning distortion on moves no other draw: the recipe minus the tilt op is unchanged", () => {
  for (const axis of ["h", "v", "both"] as const) {
    for (let seed = 0; seed < 100; seed++) {
      const off = sampleRecipe(base, seed, 1);
      const withTilt = sampleRecipe({ ...on, distortionAxis: axis }, seed, 1);
      expect({ ...withTilt, video: withTilt.video.filter((o) => o.id !== "tilt") }).toEqual(off);
    }
  }
});

test("the tilt op sits after lenscorrection and before noise", () => {
  const ids = sampleRecipe(on, 3, 1).video.map((o) => o.id);
  expect(ids.slice(0, 7)).toEqual(["eq", "zoomcrop", "rotate", "perspective", "lenscorrection", "tilt", "noise"]);
});

test("axis h tilts horizontally only", () => {
  for (let seed = 0; seed < 50; seed++) {
    const p = tiltOf({ ...on, distortionAxis: "h" }, seed)!.params;
    expect(Number(p.h)).not.toBe(0);
    expect(p.v).toBe(0);
  }
});

test("axis v tilts vertically only", () => {
  for (let seed = 0; seed < 50; seed++) {
    const p = tiltOf({ ...on, distortionAxis: "v" }, seed)!.params;
    expect(p.h).toBe(0);
    expect(Number(p.v)).not.toBe(0);
  }
});

test("axis both tilts on both axes", () => {
  for (let seed = 0; seed < 50; seed++) {
    const p = tiltOf({ ...on, distortionAxis: "both" }, seed)!.params;
    expect(Number(p.h)).not.toBe(0);
    expect(Number(p.v)).not.toBe(0);
  }
});

test("the same seed and options give the same tilt", () => {
  const o = { ...on, distortionAxis: "both" } as const;
  expect(tiltOf(o, 42)).toEqual(tiltOf(o, 42));
});

test("different seeds give different tilts, in sign and in size", () => {
  const o = { ...on, distortionAxis: "both" } as const;
  const hs = Array.from({ length: 60 }, (_, seed) => Number(tiltOf(o, seed)!.params.h));
  expect(hs.some((h) => h > 0)).toBe(true);
  expect(hs.some((h) => h < 0)).toBe(true);
  expect(new Set(hs).size).toBeGreaterThan(30);
});

test("no tilt passes the maximum, even at full strength and high intensity", () => {
  const o = { ...on, distortionAxis: "both" } as const;
  for (let seed = 0; seed < 300; seed++) {
    const p = sampleRecipe(o, seed, 3).video.find((op) => op.id === "tilt")!.params;
    expect(Math.abs(Number(p.h))).toBeLessThanOrEqual(MAX_TILT);
    expect(Math.abs(Number(p.v))).toBeLessThanOrEqual(MAX_TILT);
  }
});

test("the lean scales with the slider: 0.7-1.0 of strength times the maximum", () => {
  for (let seed = 0; seed < 200; seed++) {
    const h = Math.abs(Number(tiltOf({ ...on, distortionStrength: 0.5 }, seed)!.params.h));
    expect(h).toBeGreaterThanOrEqual(0.5 * MAX_TILT * 0.7 - 1e-4);
    expect(h).toBeLessThanOrEqual(0.5 * MAX_TILT + 1e-4);
  }
});

test("the tilt does not follow the batch strength or intensity", () => {
  const o = { ...on, distortionAxis: "both" } as const;
  expect(sampleRecipe({ ...o, strength: 1.5 }, 9, 2).video.find((x) => x.id === "tilt")).toEqual(tiltOf(o, 9));
});

test("a slider past 1 is held at the maximum", () => {
  const h = Math.abs(Number(tiltOf({ ...on, distortionStrength: 5 }, 4)!.params.h));
  expect(h).toBeLessThanOrEqual(MAX_TILT);
});
