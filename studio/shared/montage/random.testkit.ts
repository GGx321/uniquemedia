// Test helpers: a seeded PRNG so property-style tests are deterministic.

/** mulberry32: a small, well-mixed 32-bit generator. Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi], both inclusive. */
export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** A random element of a non-empty list. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[randInt(rand, 0, items.length - 1)];
  if (item === undefined) throw new Error("pick: empty list");
  return item;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";

/** A random string matching the contract's `Id` (8 to 64 chars of a-z, 0-9, `-`). */
export function randId(rand: () => number): string {
  const len = randInt(rand, 8, 64);
  let out = "";
  for (let i = 0; i < len; i++) out += ID_CHARS.charAt(randInt(rand, 0, ID_CHARS.length - 1));
  return out;
}
