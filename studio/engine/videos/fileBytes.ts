import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

// Reading a file's bytes for a comparison (recovery, fileState, delete). Reads
// only: nothing here writes, and none of it follows a name it was not given.

const READ_CHUNK = 1024 * 1024;

/** sha256 of a file, read in chunks. */
export async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK);
    for (let at = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, at);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** Whether the first `length` bytes of `short` are the first `length` bytes of `long`. */
export async function isPrefixOf(short: string, long: string, length: number): Promise<boolean> {
  const [a, b] = [await open(short, "r"), await open(long, "r")];
  try {
    const [bufA, bufB] = [Buffer.alloc(READ_CHUNK), Buffer.alloc(READ_CHUNK)];
    for (let at = 0; at < length; ) {
      const want = Math.min(READ_CHUNK, length - at);
      const [readA, readB] = [await a.read(bufA, 0, want, at), await b.read(bufB, 0, want, at)];
      if (readA.bytesRead !== want || readB.bytesRead !== want || !bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false;
      at += want;
    }
    return true;
  } finally {
    await a.close();
    await b.close();
  }
}
