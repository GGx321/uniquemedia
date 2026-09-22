import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import { photoChain } from "./photo/filterGraph";
import type { MediaInfo, Recipe } from "./types";
import type { PhotoRecipe } from "./photo/types";

/**
 * The cover is a SECOND INPUT to ffmpeg, never a temp file: `-i <cover>` puts
 * the still on `[1:v]`, the photo chain uniquifies it there at its own size,
 * and it is fitted to the video and laid over frame 0.
 *
 * The fit is done against the video stream itself (`scale2ref`), not against
 * a size computed here. The `original` export keeps the source size only
 * nominally: `rotate` widens the canvas (`ow=rotw`) and the even-crop that
 * follows keeps whatever that gives — measured 1082x1920 from a 1080x1920
 * source at 0.05°, the top of the baseline draw. A cover scaled to 1080 would
 * leave a sliver of footage down one side of frame 0; a cover scaled to what
 * the graph actually produces cannot.
 *
 * `fps=` before the overlay is the same trap the black frame has: `n` has to
 * count OUTPUT frames, or the encoder's CFR duplication puts the cover on two
 * or three of them. `eof_action=repeat` is what makes a one-frame input work
 * as an overlay for the whole clip — and `enable='eq(n,0)'` shows it once.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const coverInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 1200, height: 900, hasAudio: false };

const coverRecipe: PhotoRecipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "original",
  ops: [
    { id: "eq", params: { contrast: 1.02, saturation: 0.99, gamma: 0.98 } },
    { id: "hue", params: { h: -2 } },
    { id: "pancrop", params: { windowPct: 0.96, panX: 0.5, panY: -0.5 } },
    { id: "rotate", params: { deg: 0.1 } },
    { id: "lenscorrection", params: { k1: 0.008 } },
    { id: "vignette", params: { angle: 0.5, x0: 0.4, y0: 0.6 } },
    { id: "noise", params: { strength: 4, temporal: false } },
  ],
  encode: { quality: 5, subsampling: "420" },
};

const off: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  identity: "engine",
  firstFrame: { mode: "off" },
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

const photo: Recipe = {
  ...off,
  firstFrame: { mode: "photo", path: "/covers/one.jpg", info: coverInfo, recipe: coverRecipe },
};

const complexOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

const FIT =
  "scale2ref=w='max(iw,ceil(ih*main_w/main_h))':h='max(ih,ceil(iw*main_h/main_w))'";
const OVERLAY = "overlay=x=(W-w)/2:y=(H-h)/2:eof_action=repeat:enable='eq(n,0)'";

/** The whole photo branch, for a 30 fps recipe: what sits between the video
 *  concat and `[outv]`, and the cover lines that feed it. */
const photoBranch = (fps: number): string =>
  `concat=n=2:v=1:a=0,fps=${fps}[vc];` +
  `[1:v]${photoChain(coverRecipe, coverInfo)}[c0];` +
  `[c0][vc]${FIT}[cover][vref];` +
  `[vref][cover]${OVERLAY}[outv]`;

test("with mode off the args open on -filter_complex, with no second input", () => {
  const args = buildArgs(off, info);
  expect(args[0]).toBe("-filter_complex");
  expect(args.filter((a) => a === "-i")).toEqual([]);
});

test("with mode photo the cover is a second input, named before the graph", () => {
  const args = buildArgs(photo, info);
  expect(args.slice(0, 3)).toEqual(["-i", "/covers/one.jpg", "-filter_complex"]);
});

test("the cover goes through the photo chain on [1:v], at the cover's own size", () => {
  const fc = complexOf(buildArgs(photo, info));
  expect(fc).toContain(`[1:v]${photoChain(coverRecipe, coverInfo)}[c0]`);
  // The cover's own dimensions, not the video's: 1200x900 * 0.96 -> 1152x864.
  expect(fc).toContain("crop=1152:864:36:9,scale=1200:900");
});

test("the cover is fitted against the video stream and laid over frame 0 after fps", () => {
  const fc = complexOf(buildArgs(photo, info));
  expect(fc).toContain(`[s0][s1]${photoBranch(30)}`);
});

test("the branch leaves the concat output, not the spatial chain, and the audio graph untouched", () => {
  const fc = complexOf(buildArgs(photo, info));
  const spatial = fc.slice(0, fc.indexOf("split=2"));
  expect(spatial).not.toContain("overlay");
  expect(spatial).not.toContain("fps=");
  expect(spatial).not.toContain("[1:v]");
  const audio = fc.slice(fc.indexOf("[0:a]"));
  expect(audio).toBe(complexOf(buildArgs(off, info)).slice(complexOf(buildArgs(off, info)).indexOf("[0:a]")));
});

test("with mode photo, the cover input and the branch are the whole difference from mode off", () => {
  // Same encode flags, same maps, same audio: strip the two additions and
  // the off args come back. The overlay follows `-map [outv]` unchanged.
  const photoArgs = buildArgs(photo, info);
  const offArgs = buildArgs(off, info);
  expect(photoArgs.length).toBe(offArgs.length + 2);
  const stripped = photoArgs
    .slice(2)
    .map((a) => a.replace(photoBranch(30), "concat=n=2:v=1:a=0[outv]"));
  expect(stripped).toEqual(offArgs);
});

test("the fps in front of the overlay follows the recipe's encode fps", () => {
  const at24: Recipe = {
    ...photo,
    video: photo.video.map((o) =>
      o.id === "encode" ? { ...o, params: { ...o.params, fps: 24, gop: 48, keyintMin: 24 } } : o
    ),
  };
  const args = buildArgs(at24, info);
  expect(complexOf(args)).toContain(`[s0][s1]${photoBranch(24)}`);
  expect(args[args.indexOf("-r") + 1]).toBe("24");
});

test("the branch is emitted for a silent source too, on the only branch there is", () => {
  const fc = complexOf(buildArgs(photo, { ...info, hasAudio: false }));
  expect(fc).toContain(`[s0][s1]${photoBranch(30)}`);
  expect(fc).not.toContain("[outa]");
});

test("the branch follows the concat whatever the segment count", () => {
  const five: Recipe = {
    ...photo,
    segments: [
      { fraction: 0.2, speed: 1.0 },
      { fraction: 0.2, speed: 1.05 },
      { fraction: 0.2, speed: 0.95 },
      { fraction: 0.2, speed: 1.02 },
      { fraction: 0.2, speed: 0.98 },
    ],
  };
  const fc = complexOf(buildArgs(five, info));
  expect(fc).toContain(`[s0][s1][s2][s3][s4]concat=n=5:v=1:a=0,fps=30[vc];[1:v]`);
});

test("the fit is the same expression for every export format: it reads the stream, not EXPORT_DIMS", () => {
  for (const exportFormat of ["original", "reels", "feed", "square"] as const) {
    const fc = complexOf(buildArgs({ ...photo, exportFormat }, info));
    expect(fc).toContain(FIT);
    expect(fc).not.toMatch(/\[c0\]\[vc\]scale=\d/);
  }
});

test("mode black and mode photo are never both applied", () => {
  const fc = complexOf(buildArgs(photo, info));
  expect(fc).not.toContain("drawbox");
});
