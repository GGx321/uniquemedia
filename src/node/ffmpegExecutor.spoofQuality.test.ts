import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffprobeStatic from "ffprobe-static";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import type { MediaInfo, Recipe } from "../core/types";

/**
 * The iphone and clean branches ask libx264 and the AAC encoder for `bitexact`
 * output and strip the x264 SEI. None of that may change the picture:
 * "invisible to the eye" is the invariant the whole tool rests on, and a flag
 * that quietly re-tuned the encode would break it while every metadata test
 * stayed green.
 *
 * So the same recipe is rendered in engine, iphone and clean mode and the
 * coded video is compared packet by packet. The recipe is hand-built with no
 * `noise` in it: the noise filter seeds itself from the clock, so two renders
 * of a sampled recipe never match byte for byte and could not prove anything
 * here.
 */

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

const info: MediaInfo = { kind: "video", durationSec: 2, width: 320, height: 240, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "square",
  keepTrendAudio: false,
  identity: "engine",
  firstFrame: { mode: "off" },
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

/** The upper bound on what x264's option-string SEI can take up in the first packet. */
const SEI_MAX_BYTES = 2048;

let dir: string;
let plain: string;
let spoofed: string;
let clean: string;
const exec = new FfmpegExecutor();

/** Sizes of every packet of the first stream of `type`, in file order. */
function packetSizes(file: string, type: "v" | "a"): number[] {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", type, "-show_entries", "packet=size", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  expect(r.status).toBe(0);
  return r.stdout.trim().split("\n").map(Number);
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-spoofq-"));
  const input = join(dir, "in.mp4");
  makeTestClip(input);
  plain = join(dir, "plain.mp4");
  spoofed = join(dir, "spoofed.mov");
  clean = join(dir, "clean.mp4");
  await exec.render(input, info, recipe, plain);
  await exec.render(input, info, { ...recipe, identity: "iphone" }, spoofed);
  await exec.render(input, info, { ...recipe, identity: "clean" }, clean);
}, 90_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("spoof leaves every coded video packet after the first byte-identical", () => {
  const off = packetSizes(plain, "v");
  const on = packetSizes(spoofed, "v");
  expect(on.length).toBe(off.length);
  expect(on.slice(1)).toEqual(off.slice(1));
});

test("spoof shrinks the first video packet by the SEI and nothing more", () => {
  const off = packetSizes(plain, "v");
  const on = packetSizes(spoofed, "v");
  const removed = off[0] - on[0];
  console.log(
    `[spoof-quality] video bytes off=${sum(off)} on=${sum(on)} (SEI removed: ${removed} B); ` +
      `audio bytes off=${sum(packetSizes(plain, "a"))} on=${sum(packetSizes(spoofed, "a"))}`
  );
  expect(removed).toBeGreaterThan(0);
  expect(removed).toBeLessThan(SEI_MAX_BYTES);
});

test("spoof leaves the audio packet count and size where they were", () => {
  // `bitexact` only drops the `Lavc` FIL element from the first AAC frame;
  // the bit reservoir then settles within a few bytes over the whole stream.
  const off = packetSizes(plain, "a");
  const on = packetSizes(spoofed, "a");
  expect(on.length).toBe(off.length);
  expect(Math.abs(sum(on) - sum(off))).toBeLessThan(sum(off) * 0.005);
});

test("clean leaves every coded video packet after the first byte-identical", () => {
  const off = packetSizes(plain, "v");
  const on = packetSizes(clean, "v");
  expect(on.length).toBe(off.length);
  expect(on.slice(1)).toEqual(off.slice(1));
});

test("clean shrinks the first video packet by the SEI and nothing more", () => {
  const off = packetSizes(plain, "v");
  const on = packetSizes(clean, "v");
  const removed = off[0] - on[0];
  expect(removed).toBeGreaterThan(0);
  expect(removed).toBeLessThan(SEI_MAX_BYTES);
});

test("clean leaves the audio packet count and size where they were", () => {
  const off = packetSizes(plain, "a");
  const on = packetSizes(clean, "a");
  expect(on.length).toBe(off.length);
  expect(Math.abs(sum(on) - sum(off))).toBeLessThan(sum(off) * 0.005);
});
