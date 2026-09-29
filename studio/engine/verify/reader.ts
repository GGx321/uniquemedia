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

/** Bytes `[start, end)` as a Latin-1 string. Uses Buffer, never a spread: a huge box must not overflow the call stack. */
export function latin1(bytes: Uint8Array, start: number, end: number): string {
  const from = Math.max(0, start);
  const to = Math.min(bytes.length, end);
  return to <= from ? "" : Buffer.from(bytes.buffer, bytes.byteOffset + from, to - from).toString("latin1");
}

/** A string as Latin-1 bytes (each character below 256). */
export function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "latin1"));
}

/** How much of a file value a message may quote. */
export const QUOTE_MAX_CHARS = 32;

/**
 * A value from the file, made safe to put in a message: at most
 * `QUOTE_MAX_CHARS` characters, control and non-ASCII characters escaped, and
 * the true length when it was cut. Never the whole value.
 */
export function quote(value: string): string {
  const shown = value.slice(0, QUOTE_MAX_CHARS).replace(/[^\x20-\x7e]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return value.length > QUOTE_MAX_CHARS ? `"${shown}"... (${value.length} chars)` : `"${shown}"`;
}
