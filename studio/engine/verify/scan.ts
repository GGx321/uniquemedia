import type { FileHandle } from "node:fs/promises";
import { readAt } from "./boxes";

// A streaming byte-string search over a whole file, `chunkBytes` at a time, so
// the media data is scanned without being held in memory.

export interface Needle {
  readonly label: string;
  readonly bytes: Uint8Array;
}

export interface ScanHit {
  readonly label: string;
  /** Absolute offset of the first occurrence. */
  readonly offset: number;
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Finds the first occurrence of each needle in the first `size` bytes of the
 * file. The last `longest - 1` bytes of each window are carried into the
 * next, so a needle is found wherever a chunk boundary falls; a needle the
 * file ends in the middle of is not a hit.
 */
export async function scanForNeedles(handle: FileHandle, path: string, size: number, needles: readonly Needle[], chunkBytes = DEFAULT_CHUNK_BYTES): Promise<ScanHit[]> {
  const usable = needles.filter((n) => n.bytes.length > 0);
  const keep = Math.max(0, ...usable.map((n) => n.bytes.length)) - 1;
  const hits = new Map<string, number>();
  let carry: Buffer = Buffer.alloc(0);
  for (let position = 0; position < size && hits.size < usable.length; position += chunkBytes) {
    const chunk = await readAt(handle, path, position, Math.min(chunkBytes, size - position));
    const window = Buffer.concat([carry, chunk]);
    const windowStart = position - carry.length;
    for (const n of usable) {
      if (hits.has(n.label)) continue;
      const at = window.indexOf(n.bytes);
      if (at >= 0) hits.set(n.label, windowStart + at);
    }
    carry = window.subarray(Math.max(0, window.length - keep));
  }
  return usable.flatMap((n) => {
    const offset = hits.get(n.label);
    return offset === undefined ? [] : [{ label: n.label, offset }];
  });
}
