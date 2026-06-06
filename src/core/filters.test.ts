import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";

const info = { durationSec: 5, width: 1280, height: 720, hasAudio: true };

test("eq fragment formats params", () => {
  const out = FRAGMENTS.eq({ brightness: 0.02, contrast: 1.03, saturation: 0.97, gamma: 1.01 }, info);
  expect(out).toBe("eq=brightness=0.02:contrast=1.03:saturation=0.97:gamma=1.01");
});

test("hue fragment", () => {
  expect(FRAGMENTS.hue({ h: -4 }, info)).toBe("hue=h=-4");
});

test("zoomcrop scales then crops to source size", () => {
  expect(FRAGMENTS.zoomcrop({ zoomPct: 4 }, info)).toBe(
    "scale=iw*1.04:ih*1.04,crop=1280:720"
  );
});

test("rotate converts degrees to radians", () => {
  const out = FRAGMENTS.rotate({ deg: 1 }, info);
  expect(out!.startsWith("rotate=")).toBe(true);
  expect(out).toContain("ow=rotw");
});

test("noise zero strength is a no-op (null)", () => {
  expect(FRAGMENTS.noise({ strength: 0 }, info)).toBeNull();
});

test("vignette off is null, on emits filter", () => {
  expect(FRAGMENTS.vignette({ on: false }, info)).toBeNull();
  expect(FRAGMENTS.vignette({ on: true }, info)).toBe("vignette");
});

test("perspective emits 8 coordinates", () => {
  const out = FRAGMENTS.perspective({ off: 0.02 }, info);
  expect(out).toContain("perspective=");
  expect((out!.match(/:/g) || []).length).toBe(8);
});
