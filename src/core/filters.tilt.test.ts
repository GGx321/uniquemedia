import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";
import type { MediaInfo } from "./types";

/**
 * The user-controlled perspective tilt. `h` and `v` are signed keystone
 * fractions; the sign picks the pulled-in edge. The fragment is written in W/H
 * expressions, so none of these strings depends on the frame size.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };
const tilt = (h: number, v: number): string | null => FRAGMENTS.tilt({ h, v }, info);

test("tilt with no horizontal and no vertical lean emits nothing", () => {
  expect(tilt(0, 0)).toBeNull();
});

test("a positive h pulls in the right edge: both of its corners move inward in y", () => {
  expect(tilt(0.1, 0)).toBe(
    "perspective=0:0:W:H*0.05:0:H:W:H-H*0.05:interpolation=linear"
  );
});

test("a negative h pulls in the left edge: both of its corners move inward in y", () => {
  expect(tilt(-0.1, 0)).toBe(
    "perspective=0:H*0.05:W:0:0:H-H*0.05:W:H:interpolation=linear"
  );
});

test("a positive v pulls in the top edge: both of its corners move inward in x", () => {
  expect(tilt(0, 0.08)).toBe(
    "perspective=W*0.04:0:W-W*0.04:0:0:H:W:H:interpolation=linear"
  );
});

test("a negative v pulls in the bottom edge: both of its corners move inward in x", () => {
  expect(tilt(0, -0.08)).toBe(
    "perspective=0:0:W:0:W*0.04:H:W-W*0.04:H:interpolation=linear"
  );
});

test("h and v together tilt both axes in one warp", () => {
  expect(tilt(0.1, -0.06)).toBe(
    "perspective=0:0:W:H*0.05:W*0.03:H:W-W*0.03:H-H*0.05:interpolation=linear"
  );
});

test("the warp is interpolated linearly and never states a frame size", () => {
  const frag = tilt(0.1, 0.1) ?? "";
  expect(frag).toContain("interpolation=linear");
  expect(frag).not.toContain("1280");
  expect(frag).not.toContain("720");
});

test("the fragment is the perspective warp alone: no zoom-crop eats the frame edges", () => {
  const frag = tilt(0.1, -0.1) ?? "";
  expect(frag.startsWith("perspective=")).toBe(true);
  expect(frag).not.toContain("scale=");
  expect(frag).not.toContain("crop=");
  expect(frag).not.toContain(",");
});

test("the same fragment comes out for any frame size", () => {
  const other: MediaInfo = { ...info, width: 1080, height: 1920 };
  expect(FRAGMENTS.tilt({ h: 0.07, v: -0.05 }, other)).toBe(tilt(0.07, -0.05));
});
