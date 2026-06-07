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

test("resample zero amount is a no-op (null)", () => {
  expect(FRAGMENTS.resample({ amount: 0 }, info)).toBeNull();
});

test("lumashift zero offsets (brightness=0, contrast=1) is a no-op (null)", () => {
  expect(FRAGMENTS.lumashift({ brightness: 0, contrast: 1 }, info)).toBeNull();
});

test("lumashift emits eq filter with given brightness and contrast", () => {
  const out = FRAGMENTS.lumashift({ brightness: 0.3, contrast: 1.2 }, info);
  expect(out).toBe("eq=brightness=0.3:contrast=1.2:saturation=1:gamma=1");
});

test("resample downscales then upscales back to source dims with even intermediates", () => {
  // 4% amount on 1280x720: intermediate = round(1280*0.96/2)*2 x round(720*0.96/2)*2
  const out = FRAGMENTS.resample({ amount: 4 }, info);
  expect(out).not.toBeNull();
  // Must end with upscale back to original size
  expect(out).toContain(`,scale=${info.width}:${info.height}:flags=bicubic`);
  // First scale must differ from original (downscaled)
  expect(out!.startsWith(`scale=${info.width}:${info.height}`)).toBe(false);
  // Intermediate dims must be even
  const match = out!.match(/^scale=(\d+):(\d+)/);
  expect(Number(match![1]) % 2).toBe(0);
  expect(Number(match![2]) % 2).toBe(0);
});
