import { hammingDistance } from "./pdq/hamming";
import type { VerifyResult } from "./types";

export function verifyCopy(
  originalHashes: Uint8Array[],
  copyHashes: Uint8Array[],
  targetDistance: number
): VerifyResult {
  const perFrame: number[] = [];
  const n = Math.min(originalHashes.length, copyHashes.length);
  for (let i = 0; i < n; i++) {
    perFrame.push(hammingDistance(originalHashes[i], copyHashes[i]));
  }
  const minDistance = perFrame.length ? Math.min(...perFrame) : 0;
  return { minDistance, passed: minDistance >= targetDistance, perFrame };
}

/** Distance between two copies, by their first-frame signature. */
export function interCopyDistance(a: Uint8Array[], b: Uint8Array[]): number {
  if (!a.length || !b.length) throw new Error("interCopyDistance: empty hash array");
  return hammingDistance(a[0], b[0]);
}
