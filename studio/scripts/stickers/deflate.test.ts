import { describe, expect, test } from "bun:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { deflateRaw, zlibCompress } from "./deflate";
useNativeGlobals();

// A tiny seeded generator, so a failing input can be reproduced.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

const noise = (n: number, seed: number): Uint8Array => {
  const next = lcg(seed);
  return Uint8Array.from({ length: n }, next);
};

const roundTrips = (data: Uint8Array): boolean => Buffer.compare(inflateRawSync(deflateRaw(data)), data) === 0;

describe("deflateRaw round trip through the platform's inflate", () => {
  test("of no bytes", () => expect(roundTrips(new Uint8Array(0))).toBe(true));
  test("of one byte", () => expect(roundTrips(Uint8Array.of(7))).toBe(true));
  test("of two bytes, too short for a match", () => expect(roundTrips(Uint8Array.of(7, 7))).toBe(true));
  test("of a long run of one byte", () => expect(roundTrips(new Uint8Array(100_000))).toBe(true));
  test("of incompressible noise", () => expect(roundTrips(noise(70_000, 1))).toBe(true));
  test("of noise repeated past the 32 KiB window", () => {
    const chunk = noise(5000, 2);
    const data = new Uint8Array(60_000);
    for (let i = 0; i < data.length; i++) data[i] = chunk[i % chunk.length] ?? 0;
    expect(roundTrips(data)).toBe(true);
  });
  test("of a match exactly 258 bytes long and of one 259 long", () => {
    for (const n of [258, 259, 260, 3, 4]) expect(roundTrips(new Uint8Array(n).fill(9))).toBe(true);
  });
  test("of a skewed alphabet that needs code lengths above 15 without limiting", () => {
    // Fibonacci-sized symbol counts force the deepest possible Huffman tree.
    const parts: number[] = [];
    let a = 1;
    let b = 1;
    for (let sym = 0; sym < 24; sym++) {
      for (let i = 0; i < a; i++) parts.push(sym);
      [a, b] = [b, a + b];
    }
    const next = lcg(3);
    // Shuffle deterministically so LZ77 finds few matches and the literal tree is what is stressed.
    for (let i = parts.length - 1; i > 0; i--) {
      const j = (next() * 256 + next()) % (i + 1);
      const t = parts[i] ?? 0;
      parts[i] = parts[j] ?? 0;
      parts[j] = t;
    }
    expect(roundTrips(Uint8Array.from(parts))).toBe(true);
  });
  test("of a smooth gradient with an alpha ramp, like sticker rows", () => {
    const data = new Uint8Array(400 * 400 * 4);
    for (let i = 0; i < data.length; i += 4) {
      const p = i / 4;
      data[i] = (p % 400) >> 1;
      data[i + 1] = (p / 400) >> 1;
      data[i + 2] = 128;
      data[i + 3] = (p % 400) & 255;
    }
    expect(roundTrips(data)).toBe(true);
  });
  test("compresses a long run to far fewer bytes", () => {
    expect(deflateRaw(new Uint8Array(100_000)).length).toBeLessThan(200);
  });
});

describe("deflateRaw is deterministic", () => {
  test("gives the same bytes for the same input, twice", () => {
    const data = noise(30_000, 4);
    expect(Buffer.compare(deflateRaw(data), deflateRaw(data))).toBe(0);
  });
  test("does not depend on what it compressed before", () => {
    const data = noise(30_000, 5);
    const first = deflateRaw(data);
    deflateRaw(noise(50_000, 6));
    expect(Buffer.compare(deflateRaw(data), first)).toBe(0);
  });
});

describe("zlibCompress", () => {
  test("is a zlib stream the platform's inflate reads back", () => {
    const data = noise(10_000, 7);
    expect(Buffer.compare(inflateSync(zlibCompress(data)), data)).toBe(0);
  });
  test("carries a valid header and Adler-32 for an empty input", () => {
    expect(inflateSync(zlibCompress(new Uint8Array(0))).length).toBe(0);
  });
});
