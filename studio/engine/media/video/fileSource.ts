import { open } from "node:fs/promises";
import type { ByteSource } from "./videoProbe";

/** A file as a `ByteSource`, held open until `close`. `read` fills what it is asked for or comes up short only at the end of the file. */
export interface OpenedSource {
  readonly source: ByteSource;
  close(): Promise<void>;
}

export async function openFileSource(path: string): Promise<OpenedSource> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    return {
      source: {
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
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
