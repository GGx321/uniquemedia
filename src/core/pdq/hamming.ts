export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error("hamming: length mismatch");
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
