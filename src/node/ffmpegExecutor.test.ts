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
    { strength: 1.0, exportFormat: "square", keepTrendAudio: false, allowMirror: false, targetDistance: 90, spoofMetadata: false, keepResolution: false },
    7,
    1
  );
  const out = join(dir, "out.mp4");
  await exec.render(input, info, recipe, out);
  const outInfo = await exec.probe(out);
  expect(outInfo.width).toBe(1080);
  expect(outInfo.height).toBe(1080);
});

test("keepResolution=true pipeline produces a copy that passes the PDQ threshold of 60", async () => {
  // Key acceptance test: the full uniquify pipeline (which auto-strengthens intensity
  // when copies are too similar) must eventually produce a keepResolution copy that
  // passes targetDistance=60 without any zoomcrop (no frame-edge cropping).
  // The lumashift + resample ops on the keepResolution path shift PDQ strongly enough
  // that even on synthetic content the pipeline converges within maxAttempts.
  const opts: CopyOptions = {
    strength: 1.0,
    exportFormat: "original",
    keepTrendAudio: false,
    allowMirror: false,
    targetDistance: 60,
    spoofMetadata: false,
    keepResolution: true,
  };

  const results = await uniquify(input, opts, exec, 1, {
    seedBase: 1000,
    framesPerCopy: 4,
    maxAttempts: 6, // allow several auto-strengthen attempts
    outputPath: (i) => join(dir, `keepres_${i}.mp4`),
  });

  expect(results.length).toBe(1);
  const result = results[0];

  // Verify the recipe does NOT contain zoomcrop (keepResolution path).
  expect(result.recipe.video.some((o) => o.id === "zoomcrop")).toBe(false);
  // Verify the recipe contains both resample and lumashift ops.
  expect(result.recipe.video.some((o) => o.id === "resample")).toBe(true);
  expect(result.recipe.video.some((o) => o.id === "lumashift")).toBe(true);
  // The copy must have passed the 60-bit PDQ threshold.
  expect(result.verify.passed).toBe(true);
  expect(result.verify.minDistance).toBeGreaterThanOrEqual(60);
});
