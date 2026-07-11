import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import type { MediaInfo, Recipe } from "./types";

const info: MediaInfo = { durationSec: 5, width: 1280, height: 720, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  spoof: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "noise", params: { strength: 0 } }, // no-op, must be skipped
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

const complexOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

test("uses filter_complex (not -vf): spatial chain before split, N trims, concat", () => {
  const args = buildArgs(recipe, info);
  expect(args).not.toContain("-vf");
  const fc = complexOf(args);
  expect(fc.indexOf("eq=brightness=0.01")).toBeGreaterThanOrEqual(0);
  expect(fc.indexOf("eq=brightness=0.01")).toBeLessThan(fc.indexOf("split=2"));
  expect(fc).not.toContain("noise"); // no-op skipped
  expect(fc).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
  expect(fc).toContain("crop=1080:1920");
  expect(fc).toContain("setsar=1");
  expect(fc).toContain("split=2");
  expect((fc.match(/\]trim=start=/g) || []).length).toBe(2); // video trims only (not atrim)
  expect(fc).toContain("setpts=(PTS-STARTPTS)/1.03");
  expect(fc).toContain("setpts=(PTS-STARTPTS)/0.97");
  expect(fc).toContain("concat=n=2:v=1:a=0[outv]");
});

test("maps [outv] and [outa]; audio segmented with per-segment atempo + eq", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
  expect(args).toContain("[outa]");
  const fc = complexOf(args);
  expect(fc).toContain("asplit=2");
  expect(fc).toContain("atempo=1.03");
  expect(fc).toContain("atempo=0.97");
  expect(fc).toContain("equalizer=f=3000");
  expect(fc).toContain("concat=n=2:v=0:a=1[outa]");
});

test("segment boundaries scale with duration", () => {
  const fc = complexOf(buildArgs(recipe, { ...info, durationSec: 10 }));
  // first segment is 50% of 10s -> 0.000..5.000
  expect(fc).toContain("trim=start=0.000:end=5.000");
});

test("no audio source omits the audio branch and adds -an", () => {
  const args = buildArgs(recipe, { ...info, hasAudio: false });
  expect(args).toContain("-an");
  expect(args).not.toContain("[outa]");
  expect(complexOf(args)).not.toContain("asplit");
  expect(args.filter((a) => a === "-map").length).toBe(1);
});

const originalRecipe: Recipe = { ...recipe, exportFormat: "original" };

test("original format: skips fixed scale/crop, keeps setsar + effect filters", () => {
  const fc = complexOf(buildArgs(originalRecipe, info));
  expect(fc).not.toContain("scale=1080");
  expect(fc).not.toContain("crop=1080");
  expect(fc).toContain("setsar=1");
  expect(fc).toContain("eq=brightness=0.01");
  expect(fc).toContain("crop=trunc(iw/2)*2:trunc(ih/2)*2");
});

test("strips metadata and sets crf", () => {
  const args = buildArgs(recipe, info);
  expect(args).toContain("-map_metadata");
  expect(args).toContain("-1");
  expect(args[args.indexOf("-crf") + 1]).toBe("21");
});

test("emits CFR normalization: -r, -fps_mode cfr, -g, -keyint_min", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-r") + 1]).toBe("30");
  expect(args[args.indexOf("-fps_mode") + 1]).toBe("cfr");
  expect(args[args.indexOf("-g") + 1]).toBe("60");
  expect(args[args.indexOf("-keyint_min") + 1]).toBe("30");
});

test("uses the recipe preset and never ultrafast", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-preset") + 1]).toBe("faster");
  expect(args).not.toContain("ultrafast");
});

test("uses the per-copy audio bitrate for -b:a", () => {
  const hi = {
    ...recipe,
    video: recipe.video.map((o) =>
      o.id === "encode" ? { ...o, params: { ...o.params, audioKbps: 160 } } : o
    ),
  };
  expect(buildArgs(hi, info)[buildArgs(hi, info).indexOf("-b:a") + 1]).toBe("160k");
});

const spoofRecipe: Recipe = { ...recipe, spoof: true };

test("spoof: -f mov is the last flag, plus profile/bt709/handlers", () => {
  const args = buildArgs(spoofRecipe, info);
  const lastFIdx = args.lastIndexOf("-f");
  expect(args[lastFIdx + 1]).toBe("mov");
  expect(args.length).toBe(lastFIdx + 2); // nothing after "mov"
  expect(args[args.indexOf("-profile:v") + 1]).toBe("high");
  expect(args).toContain("bt709");
  expect(args[args.indexOf("-metadata:s:v") + 1]).toContain("Core Media Video");
  expect(args[args.indexOf("-metadata:s:a") + 1]).toContain("Core Media Audio");
});

test("no-spoof: no -f mov, no -profile:v, no handlers", () => {
  const args = buildArgs(recipe, info);
  expect(args.includes("-f")).toBe(false);
  expect(args.includes("-profile:v")).toBe(false);
  expect(args.includes("-metadata:s:v")).toBe(false);
});

test("spoof without audio: no audio handler, -f mov still present", () => {
  const args = buildArgs(spoofRecipe, { ...info, hasAudio: false });
  expect(args[args.lastIndexOf("-f") + 1]).toBe("mov");
  expect(args).not.toContain("-metadata:s:a");
});

test("caps the bitrate so a long video stays under the 50MB ceiling", () => {
  const args = buildArgs(recipe, { ...info, durationSec: 120 });
  const i = args.indexOf("-maxrate");
  expect(i).toBeGreaterThan(-1);
  expect(args).toContain("-bufsize");
  const kbps = parseInt(args[i + 1], 10);
  expect((kbps * 120) / 8 / 1024).toBeLessThanOrEqual(50);
});

test("short clips get a high cap that doesn't fight CRF", () => {
  const short = { ...info, durationSec: 5 };
  const kbps = parseInt(buildArgs(recipe, short)[buildArgs(recipe, short).indexOf("-maxrate") + 1], 10);
  expect(kbps).toBeGreaterThan(10000);
});
