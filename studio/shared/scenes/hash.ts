// 5a.2 (S5.6a): the hash the scene draws are made from. Shared and pure, so the scene banks and the template draw without the uniquifier's rng
// (src/core/rng, which only the engine may import): every draw is a hash pick, a pure function of a key and a stream name, never of a clock.
// Moved here from engine/scenes/rngUtil.ts, which re-exports it; the values are pinned on both sides.

/** FNV-1a over a string's UTF-16 units, 32-bit unsigned. Mixes a name into a seed (rngUtil's subSeed) and keys the per-slot draws; not a general-purpose hash. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The item a key draws on a stream: `list[fnv1a(\`${key}:${stream}\`) % list.length]`. Streams of one key are independent draws. */
export function pick<T>(list: readonly T[], key: string, stream: string): T {
  const item = list[fnv1a(`${key}:${stream}`) % list.length];
  if (item === undefined) throw new RangeError("a pick needs at least one item");
  return item;
}
