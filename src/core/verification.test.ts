import { test, expect } from "bun:test";
import { verifyCopy, interCopyDistance } from "./verification";

function hash(bits: number): Uint8Array {
  const h = new Uint8Array(32);
  for (let i = 0; i < bits; i++) h[i >> 3] |= 1 << (i & 7);
  return h;
}

test("passes when worst frame exceeds target", () => {
  const orig = [hash(0), hash(0)];
  const copy = [hash(100), hash(120)];
  const r = verifyCopy(orig, copy, 90);
  expect(r.minDistance).toBe(100);
  expect(r.passed).toBe(true);
});

test("fails when any frame is too close", () => {
  const orig = [hash(0), hash(0)];
  const copy = [hash(100), hash(40)];
  const r = verifyCopy(orig, copy, 90);
  expect(r.minDistance).toBe(40);
  expect(r.passed).toBe(false);
});

test("interCopyDistance compares first-frame signatures", () => {
  expect(interCopyDistance([hash(0)], [hash(30)])).toBe(30);
});

test("interCopyDistance throws on empty input", () => {
  expect(() => interCopyDistance([], [new Uint8Array(32)])).toThrow();
  expect(() => interCopyDistance([new Uint8Array(32)], [])).toThrow();
});
