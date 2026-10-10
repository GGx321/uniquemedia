// Deterministic draw helpers for the scene planner. The PRNG itself
// (`makeRng`) is the uniquifier's, which the engine runtime rule explicitly
// allows importing (studio/engine/runtime.test.ts's ALLOWED_ROOTS): a second
// implementation here would drift from it for no reason.
import { makeRng, rngInt, rngPick, type Rng } from "../../../src/core/rng";

export { makeRng, rngPick, type Rng };

/** FNV-1a over a string, 32-bit unsigned. Mixes a name into a seed (subSeed below) and keys
 *  the look module's per-slot draws — not a general-purpose hash. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic, independent rng seed from `seed` and a discriminator
 * string, run through a 32-bit avalanche mix (the murmur3/splitmix
 * finalizer) so nearby or related inputs do not produce nearby outputs. No
 * Math.random, no Date — pure function of (seed, discriminator), every time.
 * `categorySeed` and `poseSeed` (planner.ts) each call this with their own
 * discriminator, so their rng streams never collide or interleave.
 */
export function subSeed(seed: number, discriminator: string): number {
  let h = (seed ^ fnv1a(discriminator)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fisher-Yates, seeded. Returns a new array; the source is never mutated. */
export function shuffle<T>(rng: Rng, source: readonly T[]): T[] {
  const out = [...source];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Draws items one at a time without replacement; once every item has been
 * drawn, reshuffles a fresh copy of the source and continues (a "shuffle
 * bag", as in Tetris piece randomizers). So a draw count up to the source
 * length never repeats an item, and a longer draw only repeats once every
 * item has appeared. Used for locations, outfits and the shot deck, so a
 * plan only repeats one of these once it has used every option once.
 *
 * A Bag only draws from the `source` and `rng` it was given; it knows
 * nothing about categories. Isolating one category's pool edits from
 * another's is the caller's job (planner.ts's `categorySeed` gives each
 * category its own rng stream), not this class's.
 */
export class Bag<T> {
  readonly #source: readonly T[];
  readonly #rng: Rng;
  #queue: T[] = [];

  constructor(source: readonly T[], rng: Rng) {
    if (source.length === 0) throw new RangeError("a Bag needs at least one item");
    this.#source = source;
    this.#rng = rng;
  }

  next(): T {
    if (this.#queue.length === 0) this.#queue = shuffle(this.#rng, this.#source);
    // Never undefined: the queue was just refilled from a non-empty source above.
    return this.#queue.shift() as T;
  }
}
