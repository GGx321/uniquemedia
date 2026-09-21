import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import type { MediaInfo, Recipe } from "./types";

/**
 * The "iPhone metadata" mode used to write Apple keys ON TOP of ffmpeg's own
 * signature instead of replacing it: `Lavf` in the container, `Lavc` in the
 * stream compressor name and in the first AAC frame, the x264 options string
 * in an SEI NAL inside the H.264 stream. These tests pin the flags that scrub
 * each of those, and pin that the non-spoof tail does not move.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  identity: "engine",
  blackFirstFrame: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "medium", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

const spoofRecipe: Recipe = { ...recipe, identity: "iphone" };
const cleanRecipe: Recipe = { ...recipe, identity: "clean" };

/** Everything from `-c:v` to the end: the encode tail, with the filter graph
 *  and stream mapping in front of it cut off. */
function encodeTail(args: string[]): string[] {
  return args.slice(args.indexOf("-c:v"));
}

/** The value that follows `flag` at its `n`-th occurrence (0-based). */
function valueAfter(args: string[], flag: string, n = 0): string | undefined {
  let seen = -1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && ++seen === n) return args[i + 1];
  }
  return undefined;
}

test("spoof: asks the muxer for bitexact output so no Lavf version lands in the container", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(valueAfter(args, "-fflags")).toBe("+bitexact");
});

test("spoof: asks the video encoder for bitexact output", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(valueAfter(args, "-flags:v")).toBe("+bitexact");
});

test("spoof: asks the audio encoder for bitexact output so no Lavc lands in the first AAC frame", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(valueAfter(args, "-flags:a")).toBe("+bitexact");
});

test("spoof without audio: no audio bitexact flag for a stream that does not exist", () => {
  const args = buildArgs(spoofRecipe, { ...info, hasAudio: false });
  expect(args).not.toContain("-flags:a");
  expect(valueAfter(args, "-flags:v")).toBe("+bitexact");
  expect(valueAfter(args, "-fflags")).toBe("+bitexact");
});

test("spoof: strips SEI NAL units (type 6) from the H.264 stream", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(valueAfter(args, "-bsf:v")).toBe("filter_units=remove_types=6");
});

test("spoof: names the video compressor H.264, as an iPhone does", () => {
  const args = buildArgs(spoofRecipe, info);
  const values = args.filter((_, i) => args[i - 1] === "-metadata:s:v");
  expect(values).toContain("encoder=H.264");
  // The handler name is still there beside it — the two are separate tags.
  expect(values).toContain("handler_name=Core Media Video");
});

test("spoof: -f mov stays the last flag with the scrub flags in front of it", () => {
  const args = buildArgs(spoofRecipe, info);
  expect(args[args.length - 2]).toBe("-f");
  expect(args[args.length - 1]).toBe("mov");
  for (const flag of ["-fflags", "-flags:v", "-flags:a", "-bsf:v"]) {
    expect(args.indexOf(flag)).toBeGreaterThan(-1);
    expect(args.indexOf(flag)).toBeLessThan(args.lastIndexOf("-f"));
  }
});

test("no-spoof: none of the scrub flags leak into a plain render", () => {
  const args = buildArgs(recipe, info);
  for (const flag of ["-fflags", "-flags:v", "-flags:a", "-bsf:v", "-metadata:s:v"]) {
    expect(args).not.toContain(flag);
  }
  expect(args.join(" ")).not.toContain("bitexact");
  expect(args.join(" ")).not.toContain("filter_units");
  expect(args.join(" ")).not.toContain("encoder=");
});

test("no-spoof: the encode tail is byte-identical to what ships today", () => {
  // Characterisation pin. The spoof branch is allowed to grow; this list is
  // not. Any change here means the non-spoof output changed too.
  expect(encodeTail(buildArgs(recipe, info))).toEqual([
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "21",
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-fps_mode", "cfr",
    "-g", "60",
    "-keyint_min", "30",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
  ]);
});

test("no-spoof without audio: the encode tail is byte-identical to what ships today", () => {
  expect(encodeTail(buildArgs(recipe, { ...info, hasAudio: false }))).toEqual([
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "21",
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-fps_mode", "cfr",
    "-g", "60",
    "-keyint_min", "30",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
  ]);
});

test("spoof: the encode tail is the non-spoof tail plus exactly the spoof flags", () => {
  // Pins the whole spoof tail so that the two branches can only diverge here,
  // on purpose, and the diff to the non-spoof pin above reads as the spec.
  expect(encodeTail(buildArgs(spoofRecipe, info))).toEqual([
    "-c:v", "libx264",
    "-preset", "medium",
    "-profile:v", "high",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-crf", "21",
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-fps_mode", "cfr",
    "-g", "60",
    "-keyint_min", "30",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-bsf:v", "filter_units=remove_types=6",
    "-metadata:s:v", "handler_name=Core Media Video",
    "-metadata:s:v", "encoder=H.264",
    "-metadata:s:a", "handler_name=Core Media Audio",
    "-f", "mov",
  ]);
});

/**
 * `clean` is the iphone scrub without the iphone: every place ffmpeg signs its
 * work is turned off, and nothing is written in its place — no Apple handler
 * names, no `encoder=H.264`, no bt709 tagging, and the container stays the MP4
 * the output extension asks for rather than being forced to MOV.
 */

test("clean: asks the muxer and both encoders for bitexact output", () => {
  const args = buildArgs(cleanRecipe, info);
  expect(valueAfter(args, "-fflags")).toBe("+bitexact");
  expect(valueAfter(args, "-flags:v")).toBe("+bitexact");
  expect(valueAfter(args, "-flags:a")).toBe("+bitexact");
});

test("clean without audio: no audio bitexact flag for a stream that does not exist", () => {
  const args = buildArgs(cleanRecipe, { ...info, hasAudio: false });
  expect(args).not.toContain("-flags:a");
  expect(valueAfter(args, "-flags:v")).toBe("+bitexact");
});

test("clean: strips SEI NAL units (type 6) from the H.264 stream", () => {
  expect(valueAfter(buildArgs(cleanRecipe, info), "-bsf:v")).toBe("filter_units=remove_types=6");
});

test("clean: writes no identity of its own — no handler names, no compressor name, no colour tags", () => {
  const args = buildArgs(cleanRecipe, info);
  for (const flag of ["-metadata:s:v", "-metadata:s:a", "-profile:v", "-colorspace", "-color_primaries", "-color_trc"]) {
    expect(args).not.toContain(flag);
  }
  expect(args.join(" ")).not.toContain("Core Media");
  expect(args.join(" ")).not.toContain("encoder=");
  expect(args.join(" ")).not.toContain("bt709");
});

test("clean: leaves the container to the output extension instead of forcing MOV", () => {
  // A `.mp4` path gets the MP4 muxer, whose `avc1` vendor is already zeros.
  expect(buildArgs(cleanRecipe, info)).not.toContain("-f");
});

test("clean: the encode tail is the engine tail plus exactly the scrub flags", () => {
  // Pinned whole, like the other two: the three tails may only diverge here.
  expect(encodeTail(buildArgs(cleanRecipe, info))).toEqual([
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "21",
    "-maxrate", "3500k",
    "-bufsize", "7000k",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-fps_mode", "cfr",
    "-g", "60",
    "-keyint_min", "30",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-bsf:v", "filter_units=remove_types=6",
  ]);
});
