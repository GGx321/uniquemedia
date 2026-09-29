import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

// Reading a file's bytes for a comparison (recovery, fileState, delete). Reads
// only: nothing here writes, and none of it follows a link it was not given: the
// file is opened with O_NOFOLLOW (a symlink is ELOOP) and O_NONBLOCK (a FIFO does not
// hang the open), and the OPEN HANDLE must be a regular file. Where the platform has
// neither flag (Windows) the handle check still refuses a folder or device.

const READ_CHUNK = 1024 * 1024;

export class NotARegularFileError extends Error {
  readonly code = "ENOTREG";
  constructor() {
    super("not a regular file");
    this.name = "NotARegularFileError";
  }
}

async function openRegular(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NotARegularFileError();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** sha256 of a file, read in chunks. Rejects if the file changes size while it is read. */
export async function hashFile(path: string): Promise<string> {
  const handle = await openRegular(path);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK);
    for (let at = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, at);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Object.assign(new Error("the file changed while it was read"), { code: "ECHANGED" });
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
