import { describe, expect, test } from "bun:test";
import { PdqClaims } from "./pdqClaims";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T7a: the pdq gate's own dedup bookkeeping, pinned here with hand-built
// 256-bit hashes (not real images) so the near-duplicate threshold's exact
// boundary is deterministic, and separately from ffmpeg/computePdqHash.

/** A 32-byte (256-bit) hash with exactly `bits` of its low-order bits set, starting from all zero. */
function hashWithBitsSet(bits: number): Uint8Array {
  if (bits < 0 || bits > 256) throw new RangeError("bits must be 0..256");
  const hash = new Uint8Array(32);
  for (let i = 0; i < bits; i++) hash[i >> 3] |= 1 << (i & 7);
  return hash;
}

const ZERO = hashWithBitsSet(0);

describe("PdqClaims.checkAndClaim: the threshold boundary", () => {
  test("exactly at the threshold counts as a duplicate", () => {
    const claims = new PdqClaims();
    const at20 = hashWithBitsSet(20);
    expect(claims.checkAndClaim("avatar-1", "attempt-1", at20, [ZERO], 20)).toBe(true);
  });

  test("one bit over the threshold does not count as a duplicate", () => {
    const claims = new PdqClaims();
    const at21 = hashWithBitsSet(21);
    expect(claims.checkAndClaim("avatar-1", "attempt-1", at21, [ZERO], 20)).toBe(false);
  });

  test("one bit under the threshold counts as a duplicate", () => {
    const claims = new PdqClaims();
    const at19 = hashWithBitsSet(19);
    expect(claims.checkAndClaim("avatar-1", "attempt-1", at19, [ZERO], 20)).toBe(true);
  });
});

// T7a whole-slice review: the boundary above is pinned against a KNOWN
// (already-stored) hash; this pins the very same boundary against a PENDING
// (not yet stored) claim instead — the other branch inside checkAndClaim,
// and the one the concurrent-duplicate guarantee actually depends on.
describe("PdqClaims.checkAndClaim: the threshold boundary against a PENDING claim, not a known hash", () => {
  test("exactly at the threshold counts as a duplicate of a pending claim", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false); // claims ZERO
    const at20 = hashWithBitsSet(20);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", at20, [], 20)).toBe(true);
  });

  test("one bit over the threshold does not count as a duplicate of a pending claim", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    const at21 = hashWithBitsSet(21);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", at21, [], 20)).toBe(false);
  });

  test("one bit under the threshold counts as a duplicate of a pending claim", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    const at19 = hashWithBitsSet(19);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", at19, [], 20)).toBe(true);
  });
});

describe("PdqClaims.checkAndClaim: known (already-stored) hashes", () => {
  test("an empty known set never blocks the first image", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
  });

  test("a near-duplicate of ANY known hash (not just the first) is caught", () => {
    const claims = new PdqClaims();
    const far = hashWithBitsSet(200);
    const near = hashWithBitsSet(19);
    expect(claims.checkAndClaim("avatar-1", "attempt-1", near, [far, ZERO], 20)).toBe(true);
  });
});

describe("PdqClaims.checkAndClaim: pending (not yet stored) claims", () => {
  test("a second, concurrent near-identical image is caught by the first's still-open claim", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    // attempt-2's own hash is a near-duplicate of attempt-1's pending (unstored) claim, not of any known photo.
    const near = hashWithBitsSet(5);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", near, [], 20)).toBe(true);
  });

  test("two images far enough apart both claim: no false block", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    const far = hashWithBitsSet(200);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", far, [], 20)).toBe(false);
  });

  test("claims are namespaced per avatar: the same hash for a different avatar is never blocked", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    expect(claims.checkAndClaim("avatar-2", "attempt-1", ZERO, [], 20)).toBe(false);
  });
});

describe("PdqClaims.release", () => {
  test("a released claim no longer blocks a later near-identical image (a hash must not block a future image unless its photo was really stored)", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    claims.release("avatar-1", "attempt-1");
    expect(claims.checkAndClaim("avatar-1", "attempt-2", ZERO, [], 20)).toBe(false);
  });

  test("releasing an unknown attempt id is a harmless no-op", () => {
    const claims = new PdqClaims();
    expect(() => claims.release("avatar-1", "no-such-attempt")).not.toThrow();
  });

  test("releasing one attempt's claim leaves another attempt's claim on the same avatar in place", () => {
    const claims = new PdqClaims();
    expect(claims.checkAndClaim("avatar-1", "attempt-1", ZERO, [], 20)).toBe(false);
    const far = hashWithBitsSet(200);
    expect(claims.checkAndClaim("avatar-1", "attempt-2", far, [], 20)).toBe(false);

    claims.release("avatar-1", "attempt-1");

    // attempt-2's claim (far) is untouched: a near-duplicate of it is still caught.
    const nearFar = hashWithBitsSet(190);
    expect(claims.checkAndClaim("avatar-1", "attempt-3", nearFar, [], 20)).toBe(true);
  });
});
