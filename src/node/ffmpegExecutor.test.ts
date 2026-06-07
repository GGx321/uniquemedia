import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";

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
