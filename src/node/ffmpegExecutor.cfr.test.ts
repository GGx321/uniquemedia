import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { buildArgs } from "../core/filterGraph";
import type { CopyOptions, MediaInfo } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

// makeTestClip is a fixed 2s 320x240 clip with audio.
const info: MediaInfo = { durationSec: 2, width: 320, height: 240, hasAudio: true };

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

function evalRate(rate: string): number {
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
}

test("rendered copy is CFR at the recipe fps with intact, in-sync audio", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-cfr-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    makeTestClip(input);

    const opts: CopyOptions = {
      strength: 1, exportFormat: "original", keepTrendAudio: false,
      allowMirror: false, targetDistance: 60, spoofMetadata: false,
    };
    const recipe = sampleRecipe(opts, 42, 1);
    const enc = recipe.video.find((o) => o.id === "encode")!.params;

    const r = spawnSync(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output],
      { encoding: "buffer" });
    expect(r.status).toBe(0);

    // Output frame rate equals the chosen fps (CFR applied).
    expect(evalRate(probeField(output, "stream=r_frame_rate", "v"))).toBe(Number(enc.fps));
    // Audio survived and is AAC at the chosen bitrate family.
    expect(probeField(output, "stream=codec_name", "a")).toContain("aac");
    // A/V durations stay within 200ms (setpts + atempo + -r kept in sync).
    const vd = Number(probeField(output, "stream=duration", "v"));
    const ad = Number(probeField(output, "stream=duration", "a"));
    expect(Math.abs(vd - ad)).toBeLessThan(0.2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
