import { computePdqHash } from "../../../src/core/pdq/pdq";
import { decodeGray64 } from "../../node/pdqPixels";
import { defaultQaConfig, type QaConfig } from "./config";
import { PdqClaims } from "./pdqClaims";
import type { QaGate, QaInput, QaVerdict, ReleasableGate } from "./qa";

// T7a: the pdq near-duplicate gate — always on, free (invariant: it never
// sends a request, so it runs in the run's CPU pool, before any paid gate).
//
// A near-duplicate of an existing photo of the same avatar (its own stored
// qa.pdq hash, or another attempt's still-open claim in this same run — see
// pdqClaims.ts's own header for why a claim exists and when it is released)
// retries the slot; anything else passes with its own PDQ hash recorded in
// qa.pdq so a later photo can be compared against it too.
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

export const PDQ_GATE_NAME = "pdq";

export interface PdqGateDeps {
  /**
   * The avatar's already-stored photos' PDQ hashes, as lowercase hex
   * (PhotoQa.pdq), read fresh on every check. The library's own in-memory
   * index already reflects a photo this very run stored moments ago, so this
   * one function also covers "photos stored earlier in the same run" — no
   * separate run-scoped list is needed for that part.
   */
  knownHashesFor: (avatarId: string) => readonly string[];
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

export function createPdqGate(deps: PdqGateDeps): QaGate & ReleasableGate {
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
      const hash = computePdqHash(gray64);
      const known = deps.knownHashesFor(input.avatarId).map(hexToBytes);
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
