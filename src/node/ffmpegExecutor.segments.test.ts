import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { makeTestClip } from "./testClip";
import { buildArgs } from "../core/filterGraph";
import type { MediaInfo, Recipe } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

// makeTestClip is a fixed 2s 320x240 clip with audio.
const info: MediaInfo = { durationSec: 2, width: 320, height: 240, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "original",
  keepTrendAudio: false,
  spoof: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.0, saturation: 1.0, gamma: 1 } },
    { id: "encode", params: { crf: 23, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.0 } }],
};

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

const evalRate = (rate: string) => {
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
};

test("segmented recipe renders a full-duration, CFR, in-sync clip", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-seg-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    makeTestClip(input);

    const r = spawnSync(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output],
      { encoding: "buffer" });
    expect(r.status).toBe(0);

    // CFR at the recipe fps.
    expect(evalRate(probeField(output, "stream=r_frame_rate", "v"))).toBe(30);
    // Audio survived.
    expect(probeField(output, "stream=codec_name", "a")).toContain("aac");
    // Full duration (concat didn't truncate): ~2s within a generous window.
    const vd = Number(probeField(output, "stream=duration", "v"));
    expect(vd).toBeGreaterThan(1.7);
    expect(vd).toBeLessThan(2.3);
    // A/V stays in sync across the segment joins.
    const ad = Number(probeField(output, "stream=duration", "a"));
    expect(Math.abs(vd - ad)).toBeLessThan(0.2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
