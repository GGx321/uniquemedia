import { expect, test } from "bun:test";
import { bgraToRgba } from "./decodeWithElectron";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
useNativeGlobals();

test("swaps B and R, keeps G and A, for one pixel", () => {
  const bgra = new Uint8Array([10, 20, 30, 255]);
  expect([...bgraToRgba(bgra)]).toEqual([30, 20, 10, 255]);
});

test("converts every pixel in a multi-pixel buffer", () => {
  const bgra = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  expect([...bgraToRgba(bgra)]).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);
});

test("throws when the length is not a multiple of 4", () => {
  expect(() => bgraToRgba(new Uint8Array(5))).toThrow();
});
