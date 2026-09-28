import { describe, expect, test } from "bun:test";
import { hammingDistance } from "../../src/core/pdq/hamming";
import { computePdqHash } from "../../src/core/pdq/pdq";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { patternFor, renderGray } from "./distinctPattern";
useNativeGlobals();

// T7a (merging soon): an always-on PDQ near-duplicate gate on photo runs,
// threshold 20 of 256 bits (src/core/pdq) — any pair of images that close is
// read as a duplicate and retried. Proof that the pool
// studio/scripts/mockOpenRouter.ts serves a photo run's slots from
// (distinctPattern.ts, structurally distinct patterns, not just hue) is
// nowhere near that: every pair's PDQ hash, from the exact pattern math the
// mock renders, is > 40 bits apart — double the gate's own threshold. Reads
// src/core/pdq (hamming.ts, pdq.ts) only; nothing here is written to it.

const POOL_SIZE = 48;
const MIN_HAMMING_DISTANCE = 40;
const HASH_SIZE = 64;

describe("distinctPattern's pool is PDQ-distinct", () => {
  const hashes = Array.from({ length: POOL_SIZE }, (_, index) => computePdqHash(renderGray(patternFor(index), HASH_SIZE, HASH_SIZE)));

  test("every hash is PDQ's own 32 bytes (256 bits)", () => {
    for (const hash of hashes) expect(hash.length).toBe(32);
  });

  test(`every pair of the pool's ${POOL_SIZE} patterns is > ${MIN_HAMMING_DISTANCE} bits apart (PDQ's own gate: 20)`, () => {
    const tooClose: { i: number; j: number; distance: number }[] = [];
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const a = hashes[i];
        const b = hashes[j];
        if (a === undefined || b === undefined) throw new Error("unreachable: i and j are within hashes' own length");
        const distance = hammingDistance(a, b);
        if (distance <= MIN_HAMMING_DISTANCE) tooClose.push({ i, j, distance });
      }
    }
    expect(tooClose).toEqual([]);
  });
});
