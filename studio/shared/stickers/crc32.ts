let tableInstance: Uint32Array | undefined;
/** Built on first use, not at load, so a bundle that never calls `crc32` does not carry the work. */
function table(): Uint32Array {
  if (tableInstance !== undefined) return tableInstance;
  const made = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    made[n] = c >>> 0;
  }
  tableInstance = made;
  return made;
}

/** CRC-32 (the PNG/zlib polynomial) of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  const lookup = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (lookup[(c ^ (bytes[i] ?? 0)) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
