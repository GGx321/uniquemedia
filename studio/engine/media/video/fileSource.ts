import { open, type FileHandle } from "node:fs/promises";
import type { ByteSource } from "./videoProbe";

/** A file as a `ByteSource`, held open until `close`. `read` fills what it is asked for or comes up short only at the end of the file. */
export interface OpenedSource {
  readonly source: ByteSource;
  close(): Promise<void>;
}

/**
 * An OPEN handle as a `ByteSource` of `size` bytes: the caller owns the handle and closes it. For a file that was opened once and must never be opened by its path again
 * (the staging's look at a picked file, invariant 34). `read` fills what it is asked for or comes up short only at the end of the file.
 */
export function handleSource(handle: FileHandle, size: number): ByteSource {
  return {
    size,
    read: async (position, length) => {
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    },
  };
}

export async function openFileSource(path: string): Promise<OpenedSource> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return { source: handleSource(handle, size), close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
