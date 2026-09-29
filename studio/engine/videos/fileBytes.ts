import { createHash } from "node:crypto";
import { NotARegularFileError, openRegularNoFollow, type OpenRegularOptions } from "../library/openRegular";

// Reading a file's bytes for a comparison (recovery, fileState, delete). Reads
// only: nothing here writes, and none of it follows a link it was not given. The
// open is `openRegularNoFollow`: lstat, open (O_NOFOLLOW where there is one), and the
// OPEN HANDLE must be the same regular file, so it holds on Windows too, which has no
// O_NOFOLLOW.

export { NotARegularFileError };

const READ_CHUNK = 1024 * 1024;

/** sha256 of a file, read in chunks. Rejects if the file changes size while it is read. */
export async function hashFile(path: string, open: OpenRegularOptions = {}): Promise<string> {
  const handle = await openRegularNoFollow(path, open);
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
