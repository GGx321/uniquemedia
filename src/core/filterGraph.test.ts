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
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "noise", params: { strength: 0 } }, // no-op, must be skipped
    { id: "speed", params: { speed: 1.05 } },
    { id: "encode", params: { crf: 21 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

test("builds a single -vf chain skipping no-ops and appending export scale", () => {
  const args = buildArgs(recipe, info);
  const vf = args[args.indexOf("-vf") + 1];
  expect(vf).toContain("eq=brightness=0.01");
  expect(vf).not.toContain("noise");
  expect(vf).toContain("setpts=PTS/1.05");
  expect(vf).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
  expect(vf).toContain("crop=1080:1920");
  expect(vf).toContain("setsar=1");
});

test("audio chain derives atempo from speed and applies eq", () => {
  const af = buildArgs(recipe, info)[buildArgs(recipe, info).indexOf("-af") + 1];
  expect(af).toContain("atempo=1.05");
  expect(af).toContain("equalizer=");
});

test("strips metadata and sets crf", () => {
  const args = buildArgs(recipe, info);
  expect(args).toContain("-map_metadata");
  expect(args).toContain("-1");
  expect(args[args.indexOf("-crf") + 1]).toBe("21");
});

test("no audio source omits -af and adds -an", () => {
  const args = buildArgs(recipe, { ...info, hasAudio: false });
  expect(args).not.toContain("-af");
  expect(args).toContain("-an");
});

const originalRecipe: Recipe = { ...recipe, exportFormat: "original" };

test("original format: skips fixed-format scale/crop but keeps setsar=1 and effect filters", () => {
  const args = buildArgs(originalRecipe, info);
  const vf = args[args.indexOf("-vf") + 1];
  expect(vf).not.toContain("scale=1080");
  expect(vf).not.toContain("crop=1080");
  expect(vf).toContain("setsar=1");
  expect(vf).toContain("eq=brightness=0.01");
  // even-dimension guard so libx264 accepts odd-sized sources
  expect(vf).toContain("crop=trunc(iw/2)*2:trunc(ih/2)*2");
});

const spoofRecipe: Recipe = { ...recipe, spoof: true };

test("spoof: args include -f mov, -profile:v high, bt709 tags, and handler_name", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(args).toContain("-f");
  expect(args[args.lastIndexOf("-f") + 1]).toBe("mov");
  expect(args).toContain("-profile:v");
  expect(args[args.indexOf("-profile:v") + 1]).toBe("high");
  expect(args).toContain("bt709");
  expect(args).toContain("-metadata:s:v");
  const handlerV = args[args.indexOf("-metadata:s:v") + 1];
  expect(handlerV).toContain("Core Media Video");
  expect(args).toContain("-metadata:s:a");
  const handlerA = args[args.indexOf("-metadata:s:a") + 1];
  expect(handlerA).toContain("Core Media Audio");
});

test("spoof: -f mov is the last flag before output position", () => {
  const args = buildArgs(spoofRecipe, info);
  const lastFIdx = args.lastIndexOf("-f");
  expect(args[lastFIdx + 1]).toBe("mov");
  // nothing after "mov" (caller appends the output path)
  expect(args.length).toBe(lastFIdx + 2);
});

test("no-spoof: args do NOT contain -f mov, -profile:v, or handler_name", () => {
  const args = buildArgs(recipe, info);
  // -f should not appear at all in non-spoof mode
  expect(args.includes("-f")).toBe(false);
  expect(args.includes("-profile:v")).toBe(false);
  expect(args.includes("-metadata:s:v")).toBe(false);
  expect(args.includes("-metadata:s:a")).toBe(false);
});

test("spoof without audio: handler for audio not added, -f mov still present", () => {
  const args = buildArgs(spoofRecipe, { ...info, hasAudio: false });
  expect(args).toContain("-f");
  expect(args[args.lastIndexOf("-f") + 1]).toBe("mov");
  expect(args).not.toContain("-metadata:s:a");
});

test("caps the bitrate so a long video stays under the 50MB ceiling", () => {
  const args = buildArgs(recipe, { ...info, durationSec: 120 });
  const i = args.indexOf("-maxrate");
  expect(i).toBeGreaterThan(-1);
  expect(args).toContain("-bufsize");
  const kbps = parseInt(args[i + 1], 10);
  // kbps * seconds / 8 / 1024 = MB — must not exceed the 50MB cap
  expect((kbps * 120) / 8 / 1024).toBeLessThanOrEqual(50);
});

test("short clips get a high cap that doesn't fight CRF", () => {
  const args = buildArgs(recipe, { ...info, durationSec: 5 });
  const kbps = parseInt(args[args.indexOf("-maxrate") + 1], 10);
  expect(kbps).toBeGreaterThan(10000);
});
