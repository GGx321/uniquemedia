import { createHash } from "node:crypto";
import { NODE_OPEN_OPS, openRegularNoFollow, type OpenRegularOps } from "../library/openRegular";
import { RenderFailure } from "../renderQueue/queue";

// The one way the render reads a stored own file (3f.2 photos, 3f.5 stickers): ONCE, from a handle opened as the staging opens a file, within
// the size the record gave, and only if its bytes hash to the record's sha256. A plain file only: a link, a folder, a device or a FIFO is
// refused by its name, the handle must be the file the name led to, its size must be the record's, and no more than that (plus one byte, to
// see growth) is read. The caller then writes the bytes into the job's own folder (with `wx`) and ffmpeg reads that copy, never the library file.

/** What a read needs of a stored file's record. */
export interface StoredFile {
  /** The stored file in the library's `media/` folder. Never handed to ffmpeg. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** What a failed read says: no path, and no more than the owner can act on. `what` is "photo" or "sticker". */
export const ownMediaUnavailable = (what: string): RenderFailure => new RenderFailure({ code: "RENDER_FAILED", detail: `an own ${what} of this montage is no longer available: it was removed or changed` });

/**
 * The bytes of a stored file, read ONCE and checked against its record. A `RenderFailure` (no path in it) when it is gone or is not that file;
 * the signal's reason when `signal` fires.
 */
export async function readVerifiedOwnMedia(source: StoredFile, what: string, signal: AbortSignal, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<Uint8Array> {
  signal.throwIfAborted();
  let bytes: Uint8Array;
  try {
    const handle = await openRegularNoFollow(source.path, { ops });
    try {
      const facts = await handle.stat();
      if (facts.size !== source.bytes) throw ownMediaUnavailable(what);
      const buffer = Buffer.alloc(source.bytes + 1);
      let filled = 0;
      while (filled < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled !== source.bytes) throw ownMediaUnavailable(what);
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, source.bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RenderFailure) throw error;
    throw ownMediaUnavailable(what);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw ownMediaUnavailable(what);
  return bytes;
}
