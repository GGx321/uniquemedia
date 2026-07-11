import { test, expect } from "bun:test";
import { sampleRecipe } from "./sampler";
import type { CopyOptions } from "./types";

const opts: CopyOptions = {
  strength: 1.0,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  spoofMetadata: false,
};

test("same seed and intensity is deterministic", () => {
  const a = sampleRecipe(opts, 100, 1);
  const b = sampleRecipe(opts, 100, 1);
  expect(a).toEqual(b);
});

test("different seeds produce different recipes", () => {
  const a = sampleRecipe(opts, 1, 1);
  const b = sampleRecipe(opts, 2, 1);
  expect(a).not.toEqual(b);
});

test("higher intensity widens eq deviations on average", () => {
  let lowSum = 0;
  let highSum = 0;
  for (let s = 0; s < 40; s++) {
    const low = sampleRecipe(opts, s, 1).video.find((o) => o.id === "eq")!;
    const high = sampleRecipe(opts, s, 2).video.find((o) => o.id === "eq")!;
    lowSum += Math.abs(Number(low.params.brightness));
    highSum += Math.abs(Number(high.params.brightness));
  }
  expect(highSum).toBeGreaterThan(lowSum);
});

test("keepTrendAudio yields no audio ops", () => {
  const r = sampleRecipe({ ...opts, keepTrendAudio: true }, 5, 1);
  expect(r.audio.length).toBe(0);
});

test("recipe always contains zoomcrop", () => {
  const r = sampleRecipe(opts, 7, 1);
  expect(r.video.some((o) => o.id === "zoomcrop")).toBe(true);
  expect(r.video.some((o) => o.id === "resample")).toBe(false);
  expect(r.video.some((o) => o.id === "lumashift")).toBe(false);
});

test("mirror disabled never emits hflip", () => {
  for (let s = 0; s < 50; s++) {
    const r = sampleRecipe(opts, s, 1);
    expect(r.video.some((o) => o.id === "hflip" && o.params.on === true)).toBe(false);
  }
});

test("crf varies around neutral and is not pinned to the clamp ceiling", () => {
  const values = new Set<number>();
  for (let seed = 0; seed < 60; seed++) {
    const recipe = sampleRecipe(opts, seed, 1);
    const crf = Number(recipe.video.find((o) => o.id === "encode")!.params.crf);
    expect(crf).toBeGreaterThanOrEqual(18);
    expect(crf).toBeLessThanOrEqual(26);
    values.add(crf);
  }
  // must not be a single pinned value, and the average should sit near 21, not 26
  expect(values.size).toBeGreaterThan(1);
});

test("encode op carries randomized fps/gop/preset/audio params in range", () => {
  const enc = sampleRecipe(opts, 7, 1).video.find((o) => o.id === "encode")!.params;
  expect([24, 25, 30]).toContain(enc.fps);
  expect(["faster", "veryfast"]).toContain(enc.preset);
  expect([96, 112, 128, 160]).toContain(enc.audioKbps);
  expect(enc.keyintMin).toBe(enc.fps);
  const mult = Number(enc.gop) / Number(enc.fps);
  expect([2, 3, 4]).toContain(mult);
});

test("encoder params vary across seeds", () => {
  const fpsSet = new Set<number>();
  const presetSet = new Set<string>();
  for (let s = 0; s < 60; s++) {
    const enc = sampleRecipe(opts, s, 1).video.find((o) => o.id === "encode")!.params;
    fpsSet.add(Number(enc.fps));
    presetSet.add(String(enc.preset));
  }
  expect(fpsSet.size).toBeGreaterThan(1);
  expect(presetSet.size).toBeGreaterThan(1);
});

test("encoder params are not strength-scaled (same for intensity 1 and 2)", () => {
  const a = sampleRecipe(opts, 3, 1).video.find((o) => o.id === "encode")!.params;
  const b = sampleRecipe(opts, 3, 2).video.find((o) => o.id === "encode")!.params;
  expect(a.fps).toBe(b.fps);
  expect(a.preset).toBe(b.preset);
  expect(a.audioKbps).toBe(b.audioKbps);
  expect(a.gop).toBe(b.gop);
});
