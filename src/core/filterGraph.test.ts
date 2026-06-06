import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import type { MediaInfo, Recipe } from "./types";

const info: MediaInfo = { durationSec: 5, width: 1280, height: 720, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
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
