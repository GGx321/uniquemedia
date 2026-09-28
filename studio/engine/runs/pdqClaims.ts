import { hammingDistance } from "../../../src/core/pdq/hamming";

// T7a: the pdq gate's own dedup bookkeeping, kept separate from
// `computePdqHash`/ffmpeg decoding (pdqPixels.ts, pdqGate.ts) so the
// comparison logic — including the near-duplicate threshold's exact
// boundary — can be pinned with hand-built hashes instead of real images.
//
// Gates run concurrently in the run's CPU pool, and a `pass` here does not
// mean the photo is stored (a later gate, e.g. the age gate, can still retry
// or reject it) — so a hash cannot simply be recorded on `pass` and left
// there forever: "a hash must not block later images unless its photo was
// really stored" (T7a's own design note). At the same time, two truly
// concurrent near-identical images must not both pass before either is
// actually written to the library.
//
// The design: `checkAndClaim` looks the new hash up against BOTH the
// avatar's already-stored photos (`knownHashes`, read fresh by the caller on
// every check — the library's own in-memory index already reflects a photo
// this run stored moments ago, so this alone also covers "stored earlier in
// the same run") AND this avatar's other still-open claims, and — if neither
// is a near-duplicate — claims the hash under its own attempt id, all inside
// one synchronous call. JS never interleaves two synchronous stretches of
// code between two `await` points, so two concurrent gate checks racing on
// the same avatar can never both see "no duplicate yet" and both claim: the
// second one to actually run this method always sees the first one's claim
// already in the map. `runJob.ts`'s `keepImage` calls every gate's own
// `QaGate.releaseClaim` (`qa.ts`) in its `finally`, for every attempt whose
// image reached it — stored ones included, since a stored photo is found
// through `knownHashes` from then on, not through a claim — and the pdq
// gate's own implementation (pdqGate.ts) forwards straight into `release`
// below, so a claim never outlives its attempt to block a genuinely
// different future image.
export class PdqClaims {
  readonly #byAvatar = new Map<string, Map<string, Uint8Array>>();

  /**
   * `true` when `hash` is within `maxDistance` bits of one of `knownHashes`
   * or of one of this avatar's other pending claims — the photo is a
   * near-duplicate and should not pass. Otherwise claims `hash` under
   * `attemptId` (for THIS avatar only: claims never cross avatars) and
   * returns `false`.
   */
  checkAndClaim(avatarId: string, attemptId: string, hash: Uint8Array, knownHashes: readonly Uint8Array[], maxDistance: number): boolean {
    for (const known of knownHashes) {
      if (hammingDistance(hash, known) <= maxDistance) return true;
    }
    let pending = this.#byAvatar.get(avatarId);
    if (pending) {
      for (const claimed of pending.values()) {
        if (hammingDistance(hash, claimed) <= maxDistance) return true;
      }
    } else {
      pending = new Map<string, Uint8Array>();
      this.#byAvatar.set(avatarId, pending);
    }
    pending.set(attemptId, hash);
    return false;
  }

  /** Releases a claim made under `attemptId`; a harmless no-op if there is none (already released, or a duplicate that never claimed one). */
  release(avatarId: string, attemptId: string): void {
    this.#byAvatar.get(avatarId)?.delete(attemptId);
  }
}
