import { expect, test } from "bun:test";
import { rgbaToBgr } from "./pixels";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("converts one RGBA pixel to interleaved BGR, dropping alpha", () => {
  const rgba = new Uint8Array([10, 20, 30, 255]);
  const bgr = rgbaToBgr(1, 1, rgba);
  expect(bgr.width).toBe(1);
  expect(bgr.height).toBe(1);
  expect([...bgr.data]).toEqual([30, 20, 10]);
});

test("keeps row-major order for a 2x1 image", () => {
  // pixel 0: R=1 G=2 B=3, pixel 1: R=4 G=5 B=6
  const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
  const bgr = rgbaToBgr(2, 1, rgba);
  expect([...bgr.data]).toEqual([3, 2, 1, 6, 5, 4]);
});

test("ignores the alpha channel's value entirely", () => {
  const opaque = rgbaToBgr(1, 1, new Uint8Array([9, 8, 7, 255]));
  const transparent = rgbaToBgr(1, 1, new Uint8Array([9, 8, 7, 0]));
  expect([...opaque.data]).toEqual([...transparent.data]);
});

test("throws when the buffer length does not match width*height*4", () => {
  expect(() => rgbaToBgr(2, 2, new Uint8Array(4))).toThrow();
});
