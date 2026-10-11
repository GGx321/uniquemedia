import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import { samplePhotoRecipe } from "./photo/sampler";
import type { MediaInfo, Recipe } from "./types";

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const frame = { background: "/pack/lake.jpg", w: 864, h: 1536, x: 100, y: 200 };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  identity: "engine",
  firstFrame: { mode: "off" },
  segments: [{ fraction: 1, speed: 1 }],
  video: [{ id: "encode", params: { crf: 18, fps: 30, gop: 60, keyintMin: 30, preset: "medium", audioKbps: 192 } }],
  audio: [],
  frame,
};

const complexOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
const inputsOf = (args: string[]) => args.slice(0, args.indexOf("-filter_complex"));

test("frame: the background is a looped second input at the encode fps", () => {
  const args = buildArgs(recipe, info);
  expect(inputsOf(args)).toEqual(["-loop", "1", "-framerate", "30", "-i", "/pack/lake.jpg"]);
});

test("frame: the background is cover-scaled to the canvas", () => {
  const fc = complexOf(buildArgs(recipe, info));
  expect(fc).toContain("[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]");
});

test("frame: the finished video is scaled down and overlaid at its offset, ending with the video", () => {
  const fc = complexOf(buildArgs(recipe, info));
  expect(fc).toContain("scale=864:1536");
  expect(fc).toContain("overlay=x=100:y=200:shortest=1[outv]");
});

test("frame off: no extra input and no overlay", () => {
  const args = buildArgs({ ...recipe, frame: undefined }, info);
  expect(args).not.toContain("-loop");
  expect(complexOf(args)).not.toContain("overlay");
});

test("frame with a cover first frame: the background is the third input, the cover stays the second", () => {
  const coverInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 640, height: 480, hasAudio: false };
  const withCover: Recipe = {
    ...recipe,
    firstFrame: {
      mode: "photo",
      path: "/c/cover.jpg",
      info: coverInfo,
      recipe: samplePhotoRecipe(
        {
          strength: 1, exportFormat: "original", allowMirror: false, targetDistance: 38,
          identity: "engine", edge: { mode: "crop" },
        },
        1,
        1
      ),
    },
  };
  const args = buildArgs(withCover, info);
  const ins = inputsOf(args);
  expect(ins.slice(0, 2)).toEqual(["-i", "/c/cover.jpg"]);
  expect(ins.slice(2)).toEqual(["-loop", "1", "-framerate", "30", "-i", "/pack/lake.jpg"]);
  expect(complexOf(args)).toContain("[2:v]scale=1080:1920");
});

test("frame with a black first frame: the black frame goes on the composed picture", () => {
  const fc = complexOf(buildArgs({ ...recipe, firstFrame: { mode: "black" } }, info));
  expect(fc.indexOf("overlay=")).toBeLessThan(fc.indexOf("drawbox"));
  expect(fc).toMatch(/drawbox[^;]*\[outv\]/);
});
