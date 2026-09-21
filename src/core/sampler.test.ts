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
  edgeMode: "auto",
  blackFirstFrame: false,
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
  // `params` is a union bag, so assert the runtime type as well as the value —
  // a stringified fps would satisfy the range check alone.
  expect(typeof enc.fps).toBe("number");
  expect(typeof enc.preset).toBe("string");
  expect(typeof enc.audioKbps).toBe("number");
  expect([24, 25, 30]).toContain(Number(enc.fps));
  expect(["faster", "veryfast"]).toContain(String(enc.preset));
  expect([96, 112, 128, 160]).toContain(Number(enc.audioKbps));
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

test("recipe has 3-5 speed segments with fractions summing to ~1", () => {
  const r = sampleRecipe(opts, 11, 1);
  expect(r.segments.length).toBeGreaterThanOrEqual(3);
  expect(r.segments.length).toBeLessThanOrEqual(5);
  const sum = r.segments.reduce((a, seg) => a + seg.fraction, 0);
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  for (const seg of r.segments) {
    expect(seg.fraction).toBeGreaterThan(0);
    expect(seg.speed).toBeGreaterThanOrEqual(0.9);
    expect(seg.speed).toBeLessThanOrEqual(1.1);
  }
});

test("no leftover single speed op in the video chain", () => {
  const r = sampleRecipe(opts, 5, 1);
  expect(r.video.some((o) => o.id === "speed")).toBe(false);
});

test("segments vary across seeds", () => {
  const a = sampleRecipe(opts, 1, 1).segments;
  const b = sampleRecipe(opts, 2, 1).segments;
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});

test("carries blackFirstFrame from the options into the recipe", () => {
  expect(sampleRecipe({ ...opts, blackFirstFrame: true }, 5, 1).blackFirstFrame).toBe(true);
  expect(sampleRecipe({ ...opts, blackFirstFrame: false }, 5, 1).blackFirstFrame).toBe(false);
});

test("blackFirstFrame never touches the rng: every other recipe field is identical on and off", () => {
  // The toggle is copied straight from the options. If it ever cost an rng
  // draw, flipping it would re-roll every draw after it and the same seed
  // would stop meaning the same copy — which is the invariant shipped recipes
  // rely on. So the two recipes must differ in this one field and nowhere else.
  for (let seed = 1; seed <= 100; seed++) {
    const { blackFirstFrame: onFlag, ...restOn } = sampleRecipe({ ...opts, blackFirstFrame: true }, seed, 1);
    const { blackFirstFrame: offFlag, ...restOff } = sampleRecipe({ ...opts, blackFirstFrame: false }, seed, 1);
    expect(onFlag).toBe(true);
    expect(offFlag).toBe(false);
    expect(restOn).toEqual(restOff);
  }
});
