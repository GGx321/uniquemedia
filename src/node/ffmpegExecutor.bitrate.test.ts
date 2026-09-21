import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import type { CopyOptions } from "../core/types";

/**
 * Instagram re-encodes every upload to roughly 2–3.5 Mbit/s, so whatever a
 * copy spends above that is thrown away on ingest. The encode stops at
 * 3500 kbit/s; this test proves the ceiling holds on a real render, not just
 * on the argument list.
 *
 * lavfi `testsrc` is the right input precisely because it is pathological:
 * hard edges everywhere and nothing for the codec to predict, so CRF alone
 * lets it run to 6–10 Mbit/s at 1080x1920. It is the clip that WOULD blow
 * past the ceiling if the ceiling did nothing.
 *
 * 30 s rather than the 2 s clip the other executor tests share: the ceiling is
 * enforced through a 2 s VBV window, and x264 may spend a good part of that
 * buffer up front, so on a 2 s clip the average lands near 4.5 Mbit/s however
 * well the ceiling works. Over 30 s — the top of the range the tool is used on
 * — the transient amortises to well under 100 kbit/s.
 */
const CEILING_KBPS = 3500;
const VBV_ALLOWANCE_KBPS = 100;
const CLIP_SEC = 30;

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-bitrate-"));
  input = join(dir, "in.mp4");
  makeTestClip(input, CLIP_SEC);
});
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

test("rendered reel stays within the 3.5 Mbit/s ceiling on a source that would blow past it", async () => {
  const info = await exec.probe(input);
  const opts: CopyOptions = {
    strength: 1, exportFormat: "reels", keepTrendAudio: false, allowMirror: false,
    targetDistance: 60, spoofMetadata: false, edgeMode: "auto", blackFirstFrame: false,
  };
  const out = join(dir, "out.mp4");
  await exec.render(input, info, sampleRecipe(opts, 42, 1), out);

  const kbps = videoBitrateKbps(out);
  console.log(`[bitrate] video=${Math.round(kbps)} kbit/s over ${CLIP_SEC}s`);
  expect(Number.isFinite(kbps)).toBe(true);
  expect(kbps).toBeLessThanOrEqual(CEILING_KBPS + VBV_ALLOWANCE_KBPS);
  // The ceiling has to be what limited this encode. A source that fit under it
  // on its own would pass the line above without proving the ceiling exists.
  expect(kbps).toBeGreaterThan(CEILING_KBPS * 0.85);
}, 60_000);
