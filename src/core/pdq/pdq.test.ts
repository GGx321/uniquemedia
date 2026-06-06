import { test, expect } from "bun:test";
import { computePdqHash } from "./pdq";

function gradient(): Uint8Array {
  const g = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) g[y * 64 + x] = (x * 4) & 0xff;
  return g;
}

test("hash is 32 bytes (256 bits)", () => {
  expect(computePdqHash(gradient()).length).toBe(32);
});

test("identical input yields identical hash", () => {
  expect([...computePdqHash(gradient())]).toEqual([...computePdqHash(gradient())]);
});

test("a strong change flips many bits", () => {
  const a = computePdqHash(gradient());
  const inverted = gradient().map((v) => 255 - v) as Uint8Array;
  const b = computePdqHash(inverted);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    let x = a[i] ^ b[i];
    while (x) { diff += x & 1; x >>= 1; }
  }
  expect(diff).toBeGreaterThan(20);
});

test("rejects wrong input length", () => {
  expect(() => computePdqHash(new Uint8Array(100))).toThrow();
});
