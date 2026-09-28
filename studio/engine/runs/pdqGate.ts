import { computePdqHash } from "../../../src/core/pdq/pdq";
import { decodeGray64, PDQ_GRAY_FRAME_BYTES } from "../../node/pdqPixels";
import { defaultQaConfig, type QaConfig } from "./config";
import { PdqClaims } from "./pdqClaims";
import type { QaGate, QaInput, QaVerdict } from "./qa";

// T7a: the pdq near-duplicate gate — always on, free (invariant: it never
// sends a request, so it runs in the run's CPU pool, before any paid gate).
//
// A near-duplicate of an existing photo of the same avatar (its own stored
// qa.pdq hash, or another attempt's still-open claim in this same run — see
// pdqClaims.ts's own header for why a claim exists and when it is released)
// retries the slot; anything else passes with its own PDQ hash recorded in
// qa.pdq so a later photo can be compared against it too.
//
// T7a whole-slice review, architectural finding: this gate is wired into the
// engine once, before any run — or any library — exists, so it cannot hold
// "the avatar's known photos" as a dependency of its own; that dependency
// would have no real library to read and would have to fail open to an
// empty list. It reads `input.photosByAvatar(input.avatarId)` instead — the
// run's own library, given fresh on every check.
//
// Decoding is the only place this gate can fail on ONE image without the
// gate itself being broken: an ordinary decode failure (ffmpeg ran, exited
// non-zero, or produced the wrong shape — a garbled or unusual body) is this
// image's own problem and retries; a spawn failure (the ffmpeg binary itself
// missing or not executable) would fail identically for every later image
// too, so it throws instead (qa.ts's own contract: "a gate throws only when
// it cannot run at all"). An abort of `input.signal` (the run's cancel, or
// this gate's own outer timeout) is left to reject naturally — runJob.ts's
// own wrapper is what decides whether that means the image is merely dropped
// (a cancel) or the gate itself is broken (its own timeout firing on what
// should be a fast, local decode).
//
// T7a whole-slice review (LOW): a flat or near-flat render (a solid
// moderation placeholder, a broken generation) hashes degenerately under
// PDQ — its DCT has no AC energy, so every flat frame hashes to the same
// value regardless of colour. `gradientEnergy` catches this before the hash
// is even computed: below `config.pdq.minGradientEnergy` the image retries
// as a broken render, unclaimed, rather than being hashed and compared at
// all (which could otherwise wrongly "pass" it as unique, or wrongly
// "retry" it as a duplicate of an unrelated flat frame).

export const PDQ_GATE_NAME = "pdq";

export interface PdqGateDeps {
  /** Decodes a paid image to the 64x64 grayscale frame PDQ hashes; defaults to pdqPixels.ts's real ffmpeg decoder. */
  decode?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  /** defaultQaConfig() unless a caller (or a test) says otherwise. */
  config?: QaConfig;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A spawn failure (the ffmpeg binary itself missing, ENOENT, or not
 * executable, EACCES): systemic, since decoding always spawns from the same
 * fixed path — the next image's decode would fail the exact same way. A
 * decode failure (ffmpeg ran, exited non-zero, or wrote the wrong shape) has
 * no such `code` and is this one image's own problem instead.
 */
function isSpawnFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/**
 * The sum of every adjacent pixel pair's absolute difference over a 64x64
 * grayscale frame (each pixel counted against its right and below neighbour
 * only, so every pair is counted exactly once): 0 for a perfectly flat
 * image, large for one with real detail. See config.ts's own
 * `minGradientEnergy` for why this exists and how its default was chosen.
 */
export function gradientEnergy(gray64: Uint8Array): number {
  if (gray64.length !== PDQ_GRAY_FRAME_BYTES) {
    throw new RangeError(`expected a ${PDQ_GRAY_FRAME_BYTES}-byte 64x64 grayscale frame, got ${gray64.length}`);
  }
  let energy = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = y * 64 + x;
      if (x + 1 < 64) energy += Math.abs(gray64[i]! - gray64[i + 1]!);
      if (y + 1 < 64) energy += Math.abs(gray64[i]! - gray64[i + 64]!);
    }
  }
  return energy;
}

export function createPdqGate(deps: PdqGateDeps = {}): QaGate {
  const decode = deps.decode ?? ((bytes, signal) => decodeGray64(bytes, { signal }));
  const config = deps.config ?? defaultQaConfig();
  const claims = new PdqClaims();

  return {
    name: PDQ_GATE_NAME,
    paid: false,
    async check(input: QaInput): Promise<QaVerdict> {
      let gray64: Uint8Array;
      try {
        gray64 = await decode(input.image.bytes, input.signal);
      } catch (error) {
        // The run's cancel, or this gate's own outer timeout: let runJob.ts's own
        // wrapper decide what that means (a dropped image, or a broken gate).
        if (input.signal.aborted) throw error;
        if (isSpawnFailure(error)) {
          throw new Error(`the pdq gate could not run: ffmpeg is missing or not executable (${messageOf(error)})`);
        }
        return { verdict: "retry", reason: `the image could not be decoded for its near-duplicate check: ${messageOf(error)}` };
      }

      const energy = gradientEnergy(gray64);
      if (energy < config.pdq.minGradientEnergy) {
        return { verdict: "retry", reason: `the image is too flat to judge (gradient energy ${energy} < ${config.pdq.minGradientEnergy}) — likely a broken or placeholder render` };
      }

      // T7a review (finding 4): the run may have stopped sending, or this gate's own outer
      // timeout may have fired, in the time decoding took — checked once more, synchronously,
      // right before claiming, so an attempt whose outcome is about to be discarded by
      // runJob.ts's own abort race never leaves an orphaned claim with no path to release it.
      if (input.signal.aborted) throw input.signal.reason;

      const hash = computePdqHash(gray64);
      const known = input.photosByAvatar(input.avatarId).flatMap((photo) => (photo.qa.pdq === undefined ? [] : [hexToBytes(photo.qa.pdq)]));
      const duplicate = claims.checkAndClaim(input.avatarId, input.attemptId, hash, known, config.pdq.maxHammingDistance);
      if (duplicate) {
        return { verdict: "retry", reason: `a near-duplicate of an existing or in-flight photo of this avatar (within ${config.pdq.maxHammingDistance} of 256 bits)` };
      }
      return { verdict: "pass", qa: { pdq: bytesToHex(hash) } };
    },
    releaseClaim(avatarId: string, attemptId: string): void {
      claims.release(avatarId, attemptId);
    },
  };
}
