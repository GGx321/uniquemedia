import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { uniquify } from "../core/pipeline";
import type { CopyOptions } from "../core/types";

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("probe returns duration, dims and audio flag", async () => {
  const info = await exec.probe(input);
  expect(info.durationSec).toBeGreaterThan(1.5);
  expect(info.width).toBe(320);
  expect(info.height).toBe(240);
  expect(info.hasAudio).toBe(true);
});

test("extractGrayFrames returns 64x64 buffers", async () => {
  const frames = await exec.extractGrayFrames(input, 4);
  expect(frames.length).toBe(4);
  for (const f of frames) expect(f.length).toBe(64 * 64);
});

test("render produces a valid playable mp4", async () => {
  const info = await exec.probe(input);
  const recipe = sampleRecipe(
    { strength: 1.0, exportFormat: "square", keepTrendAudio: false, allowMirror: false, targetDistance: 90, spoofMetadata: false },
    7,
    1
  );
  const out = join(dir, "out.mp4");
  await exec.render(input, info, recipe, out);
  const outInfo = await exec.probe(out);
  expect(outInfo.width).toBe(1080);
  expect(outInfo.height).toBe(1080);
});

test("light zoom-crop pipeline passes PDQ target 45 within a few attempts", async () => {
  // Integration test: the full uniquify pipeline with the small zoom-crop (~4-6%)
  // must pass targetDistance=45 on a real test clip. Verifies the light crop is
  // an effective hash-breaker and converges quickly (minimal frame-edge loss).
  const opts: CopyOptions = {
    strength: 1.0,
    exportFormat: "original",
    keepTrendAudio: false,
    allowMirror: false,
    targetDistance: 45,
    spoofMetadata: false,
  };

  const results = await uniquify(input, opts, exec, 1, {
    seedBase: 1000,
    framesPerCopy: 4,
    maxAttempts: 4,
    outputPath: (i) => join(dir, `lightcrop_${i}.mp4`),
  });

  expect(results.length).toBe(1);
  const result = results[0];

  // Recipe must always contain zoomcrop (the only hash-breaker now).
  expect(result.recipe.video.some((o) => o.id === "zoomcrop")).toBe(true);
  expect(result.recipe.video.some((o) => o.id === "resample")).toBe(false);
  expect(result.recipe.video.some((o) => o.id === "lumashift")).toBe(false);

  // Must pass target 45 within maxAttempts.
  expect(result.verify.passed).toBe(true);
  expect(result.verify.minDistance).toBeGreaterThanOrEqual(45);

  // Report for empirical verification: should converge in 1-2 attempts.
  console.log(
    `[light-crop] PDQ minDistance=${result.verify.minDistance} intensity=${result.recipe.intensity} ` +
    `(zoom=${result.recipe.video.find((o) => o.id === "zoomcrop")?.params.zoomPct}%)`
  );
});
