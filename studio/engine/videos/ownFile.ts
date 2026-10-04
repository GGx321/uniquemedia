import { createHash } from "node:crypto";
import { NODE_OPEN_OPS, openRegularNoFollow, type OpenRegularOps } from "../library/openRegular";

// One stored own file, read for a render (Stage 3, 3f.2 photos, 3f.4 tracks): the bytes of a file that is exactly what its record says. The render never
// points ffmpeg (or the face detector) at the library file; it reads these VERIFIED BYTES once and works on a private copy of them.

/** What a record says a stored file is. */
export interface OwnFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The file is gone, is not a plain file, or is not the size and hash its record gave. It names no path. */
export class OwnFileUnavailableError extends Error {
  constructor() {
    super("an own file is no longer available: it was removed or changed");
    this.name = "OwnFileUnavailableError";
  }
}

/**
 * The bytes of a stored file, read ONCE and checked against its record: a plain file (not a link, a folder, a device or a FIFO: it is opened as the staging
 * opens a file, `openRegularNoFollow`), the handle's own size is the record's, no more than that (plus one byte, to see growth) is read FROM THE HANDLE, and
 * the bytes hash to the recorded sha256. Throws `OwnFileUnavailableError` (no path in it) for anything else, and the signal's reason when `signal` fires.
 */
export async function readVerifiedOwnFile(record: OwnFileRecord, signal: AbortSignal, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<Uint8Array> {
  signal.throwIfAborted();
  let bytes: Uint8Array;
  try {
    const handle = await openRegularNoFollow(record.path, { ops });
    try {
      const facts = await handle.stat();
      if (facts.size !== record.bytes) throw new OwnFileUnavailableError();
      const buffer = Buffer.alloc(record.bytes + 1);
      let filled = 0;
      while (filled < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled !== record.bytes) throw new OwnFileUnavailableError();
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, record.bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof OwnFileUnavailableError) throw error;
    throw new OwnFileUnavailableError();
  }
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new OwnFileUnavailableError();
  return bytes;
}
