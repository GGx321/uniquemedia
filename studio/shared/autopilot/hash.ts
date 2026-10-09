// Small deterministic mixing for the autopilot's seeded choices (plan §6.1, §6.3): the same input always gives the same number, on every
// platform, with no clock and no randomness. Not cryptographic; it only spreads bits.

export const MAX_UINT32 = 4_294_967_295;

export const isUint32 = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32;

/** Murmur3's 32-bit finaliser: spreads every input bit over the whole word. */
export function fmix32(input: number): number {
  let h = input >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over the UTF-16 units of `text`, started from the mixed `seed`, then finalised. */
export function hashText(seed: number, text: string): number {
  let h = (0x811c9dc5 ^ fmix32(seed)) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return fmix32(h);
}

/** A sequence of numbers in [0, 1) that depends only on `seed` and `label` (mulberry32). Streams with different labels are independent. */
export function stream(seed: number, label: string): () => number {
  let a = hashText(seed, label);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi], both inclusive, from the next number of a stream. */
export const intIn = (next: () => number, lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
