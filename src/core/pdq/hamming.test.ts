import { test, expect } from "bun:test";
import { hammingDistance } from "./hamming";

test("identical buffers have distance 0", () => {
  const a = new Uint8Array([0b10101010, 0xff]);
  expect(hammingDistance(a, a)).toBe(0);
});

test("counts differing bits", () => {
  const a = new Uint8Array([0b00000000]);
  const b = new Uint8Array([0b00001111]);
  expect(hammingDistance(a, b)).toBe(4);
});

test("throws on length mismatch", () => {
  expect(() => hammingDistance(new Uint8Array(1), new Uint8Array(2))).toThrow();
});
