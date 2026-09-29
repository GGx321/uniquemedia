// Bounds-checked reads of the fixed fields inside a box payload. Every reader
// takes the buffer and an absolute offset and returns undefined instead of
// reading past the end, so a short or corrupt box becomes a reason and not an
// exception or a NaN.

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function u8(bytes: Uint8Array, at: number): number | undefined {
  return at >= 0 && at + 1 <= bytes.length ? bytes[at] : undefined;
}

export function u16(bytes: Uint8Array, at: number): number | undefined {
  return at >= 0 && at + 2 <= bytes.length ? view(bytes).getUint16(at) : undefined;
}

export function u32(bytes: Uint8Array, at: number): number | undefined {
  return at >= 0 && at + 4 <= bytes.length ? view(bytes).getUint32(at) : undefined;
}

/** A 64-bit field as a Number; values past 2^53 come back as `Infinity`, which no check accepts. */
export function u64(bytes: Uint8Array, at: number): number | undefined {
  if (at < 0 || at + 8 > bytes.length) return undefined;
  const value = view(bytes).getBigUint64(at);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(value);
}

export function latin1(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
