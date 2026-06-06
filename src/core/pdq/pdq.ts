const N = 64;
const K = 16; // low-frequency block edge

// Precompute DCT-II basis: COS[u][x] = cos((2x+1)uπ / 2N)
const COS: number[][] = Array.from({ length: N }, (_, u) =>
  Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)))
);

function dct2dLowFreq(pixels: Float64Array): Float64Array {
  // Rows: full 64-pt DCT, keep only first K frequencies.
  const rows = new Float64Array(N * K);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < K; u++) {
      let sum = 0;
      const cu = COS[u];
      for (let x = 0; x < N; x++) sum += pixels[y * N + x] * cu[x];
      rows[y * K + u] = sum;
    }
  }
  // Columns over the K kept frequencies.
  const out = new Float64Array(K * K);
  for (let u = 0; u < K; u++) {
    for (let v = 0; v < K; v++) {
      let sum = 0;
      const cv = COS[v];
      for (let y = 0; y < N; y++) sum += rows[y * K + u] * cv[y];
      out[v * K + u] = sum;
    }
  }
  return out;
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computePdqHash(gray64: Uint8Array): Uint8Array {
  if (gray64.length !== N * N) {
    throw new Error(`expected ${N * N} grayscale bytes, got ${gray64.length}`);
  }
  const pixels = Float64Array.from(gray64);
  const coeffs = dct2dLowFreq(pixels); // 256 values
  const med = median(coeffs);

  const hash = new Uint8Array(32);
  for (let i = 0; i < 256; i++) {
    if (coeffs[i] > med) hash[i >> 3] |= 1 << (i & 7);
  }
  return hash;
}
