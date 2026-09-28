import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { hammingDistance } from "../../src/core/pdq/hamming";
import { computePdqHash } from "../../src/core/pdq/pdq";
import { ffmpegPath } from "../node/ffmpegBinary";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { servedPoolImagePng } from "./distinctPattern";
useNativeGlobals();

// T7a (merging soon): an always-on PDQ near-duplicate gate on photo runs,
// threshold 20 of 256 bits (src/core/pdq) — any pair of images that close is
// read as a duplicate and retried, and its own decode command (after its
// current fix round) is `scale=64:64:flags=area,format=gray`, raw 8-bit gray
// out.
//
// Round 1 review (HIGH): a first version of this test hashed the pattern
// rendered directly at 64x64, but the mock served it at 200x356 with
// pixel-absolute stripe math — a geometrically different image, so the test
// proved nothing about the shipped artifact (measured: per-index distance
// between "what the test hashed" and "what the real pipeline hashed" was
// 20-160 bits). This version hashes exactly what the gate will: the real
// served PNG bytes (`servedPoolImagePng`, the same function
// studio/scripts/mockOpenRouter.ts serves from), decoded with the real
// `ffmpegPath()` and the gate's own command, never a stand-in decoder or a
// direct render at the hash size.

const POOL_SIZE = 48;
const MIN_HAMMING_DISTANCE = 40;
const HASH_SIZE = 64;

/**
 * Decodes a served pool image exactly the way T7a's PDQ gate will: ffmpeg's
 * `scale=64:64:flags=area,format=gray`, raw 8-bit grayscale out — the same
 * `ffmpegPath()` every other studio test and the engine itself uses
 * (studio/node/ffmpegBinary.ts), never a stand-in. A missing or broken
 * ffmpeg fails this test loudly (spawnSync's own non-zero status, thrown
 * below), never a silent skip: the whole point of this test is proving the
 * real pipeline, and a skip would prove nothing at all.
 */
function decodeServedGray64(png: Uint8Array): Uint8Array {
  const result = spawnSync(
    ffmpegPath(),
    ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-vf", "scale=64:64:flags=area,format=gray", "-f", "rawvideo", "-frames:v", "1", "pipe:1"],
    { input: Buffer.from(png), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg (${ffmpegPath()}) could not decode a pool image the way the PDQ gate will: ${result.stderr.toString()}`);
  }
  const gray = new Uint8Array(result.stdout);
  if (gray.length !== HASH_SIZE * HASH_SIZE) {
    throw new Error(`expected a ${HASH_SIZE}x${HASH_SIZE} raw grayscale frame (${HASH_SIZE * HASH_SIZE} bytes), got ${gray.length}`);
  }
  return gray;
}

describe("the served pool is PDQ-distinct through the real gate pipeline", () => {
  const hashes = Array.from({ length: POOL_SIZE }, (_, index) => computePdqHash(decodeServedGray64(servedPoolImagePng(index))));

  test("every hash is PDQ's own 32 bytes (256 bits)", () => {
    for (const hash of hashes) expect(hash.length).toBe(32);
  });

  test(`every pair of the pool's ${POOL_SIZE} served images is > ${MIN_HAMMING_DISTANCE} bits apart, decoded through the real gate pipeline (PDQ's own gate: 20)`, () => {
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
