import { z } from "zod";

// T7a: the QA gates' own tunable thresholds, zod-validated like face/config.ts
// so a bad value is refused before it can silently gate every photo. The face
// gate (T7b) keeps its own config (face/config.ts) — this one is for the
// gates T7a adds (pdq now; anything else T7a needs later).

export const QaConfigSchema = z.strictObject({
  pdq: z.strictObject({
    /**
     * The greatest Hamming distance, of PDQ's 256 bits, at which two hashes
     * still count as the same photo (pdqGate.ts's near-duplicate check).
     * PDQ's own documented range for "this is essentially the same image"
     * runs up to about 31 of 256 bits (~12%); this gate's job is narrower —
     * catching a provider handing back the very same render twice (a stuck
     * seed, a cached echo), not two independently rendered takes of the same
     * scene, which the run's own planner already varies by seed and which
     * can legitimately sit in the low 20s-30s on PDQ's own worked examples.
     * 20 sits inside the documented range but short of its edge, so it still
     * catches a near-exact repeat without also catching two honestly
     * different renders of one scene. It is a documented starting point, not
     * derived from this app's own duplicates (none has been seen yet):
     * pdqGate.test.ts pins it at exactly 20 (a duplicate), 21 (not — one
     * over) and 19 (a duplicate — one under), so recalibrating it later is a
     * deliberate, reviewed change to this one constant, not a silent drift.
     */
    maxHammingDistance: z.int().min(0).max(256),
    /**
     * T7a review (LOW): the least total gradient energy (`pdqGate.ts`'s own
     * `gradientEnergy` — the sum of every adjacent pixel pair's absolute
     * difference over the 64x64 grayscale frame, right and below neighbours
     * only) a frame must have before its PDQ hash is trusted at all. A flat
     * or near-flat render (a solid moderation placeholder, a broken
     * generation) hashes degenerately — PDQ's DCT of a flat image has no AC
     * energy, so it hashes to the same all-zero value regardless of its
     * actual colour (`pdqGate.test.ts`'s own `gradientEnergy` tests) — and
     * would otherwise either falsely "pass" as unique or falsely "retry" as
     * a duplicate of an unrelated flat frame. Below this floor the image is
     * retried outright, unclaimed, rather than hashed and compared at all.
     * 200 is a low, conservative starting point (a 64x64 frame's maximum
     * possible energy is in the millions): it is well above the handful of
     * JPEG-compression-artifact energy a truly solid placeholder image
     * might carry, and well below any real photograph's, which always has
     * genuine edges (hair, features, clothing) even in a plain scene. Not
     * derived from this app's own broken renders (none has been seen yet);
     * pdqGate.test.ts pins its own boundary exactly, so recalibrating it is
     * a deliberate, reviewed change to this one constant.
     */
    minGradientEnergy: z.int().min(0),
  }),
});
export type QaConfig = z.infer<typeof QaConfigSchema>;

export function defaultQaConfig(): QaConfig {
  return QaConfigSchema.parse({ pdq: { maxHammingDistance: 20, minGradientEnergy: 200 } });
}
