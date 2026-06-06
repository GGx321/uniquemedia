export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function rngInt(rng: Rng, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

export function rngBool(rng: Rng, p = 0.5): boolean {
  return rng() < p;
}

export function rngPick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
