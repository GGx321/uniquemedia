import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeHighEntropyClip, makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import type { ResolvedCopyOptions } from "../core/types";

/**
 * The video bitrate is capped at 4000 kbit/s to keep files small. The cap was
 * lifted once to 12000 to test whether a higher bitrate earns more views; it
 * does not, and size does grow, so the 4 Mbit/s ceiling is back. This test
 * proves, on real renders, that the ceiling holds and that it is the thing
 * limiting a demanding source.
 *
 * lavfi `testsrc` is the right input precisely because it is pathological:
 * hard edges everywhere and nothing for the codec to predict, so CRF alone
 * would drive it to 7-8 Mbit/s at 1080x1920 - the ceiling has to clamp it.
 *
 * 30 s rather than the 2 s clip the other executor tests share: the ceiling is
 * enforced through a 2 s VBV window, and x264 may spend a good part of that
 * buffer up front, so a short clip overshoots the average however well the
 * ceiling works. Over 30 s the transient amortises to a small allowance.
 */
const CEILING_KBPS = 4000;
/**
 * x264 may spend one VBV buffer (`-bufsize` = 2 s of ceiling) above the ceiling
 * over a clip, so the average overshoots by at most buffer / duration
 * (about 267 kbit/s at the 4000 ceiling over 30 s).
 */
const VBV_ALLOWANCE_KBPS = (CEILING_KBPS * 2) / 30;
const CLIP_SEC = 30;
const NOISY_SEC = 30;

let dir: string;
let input: string;
let noisyInput: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-bitrate-"));
  input = join(dir, "in.mp4");
  makeTestClip(input, CLIP_SEC);
  noisyInput = join(dir, "noisy.mp4");
  makeHighEntropyClip(noisyInput, NOISY_SEC);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Average bitrate of the first video stream, in kbit/s, as ffprobe reports it. */
function videoBitrateKbps(file: string): number {
  const r = spawnSync(
    ffprobeStatic.path,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate",
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return Number(r.stdout.trim()) / 1000;
}

test("rendered reel is capped at 4 Mbit/s even for a pathological source", async () => {
  const info = await exec.probe(input);
  const opts: ResolvedCopyOptions = {
    strength: 1, exportFormat: "reels", keepTrendAudio: false, allowMirror: false,
    targetDistance: 60, identity: "engine", edgeMode: "auto", firstFrame: { mode: "off" },
    distortion: false, distortionAxis: "h", distortionStrength: 0,
  };
  const out = join(dir, "out.mp4");
  await exec.render(input, info, sampleRecipe(opts, 42, 1), out);

  const kbps = videoBitrateKbps(out);
  console.log(`[bitrate] video=${Math.round(kbps)} kbit/s over ${CLIP_SEC}s`);
  expect(Number.isFinite(kbps)).toBe(true);
  expect(kbps).toBeLessThanOrEqual(CEILING_KBPS + VBV_ALLOWANCE_KBPS);
}, 60_000);

test("the 4 Mbit/s ceiling binds on a source that would exceed it", async () => {
  const info = await exec.probe(noisyInput);
  const opts: ResolvedCopyOptions = {
    strength: 1, exportFormat: "reels", keepTrendAudio: false, allowMirror: false,
    targetDistance: 60, identity: "engine", edgeMode: "auto", firstFrame: { mode: "off" },
    distortion: false, distortionAxis: "h", distortionStrength: 0,
  };
  const out = join(dir, "noisy-out.mp4");
  await exec.render(noisyInput, info, sampleRecipe(opts, 42, 1), out);

  const kbps = videoBitrateKbps(out);
  console.log(`[bitrate] noisy video=${Math.round(kbps)} kbit/s over ${NOISY_SEC}s`);
  expect(kbps).toBeLessThanOrEqual(CEILING_KBPS + VBV_ALLOWANCE_KBPS);
  // The ceiling has to be what limited this encode.
  expect(kbps).toBeGreaterThan(CEILING_KBPS * 0.85);
}, 120_000);
