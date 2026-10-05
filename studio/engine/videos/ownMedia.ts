import { createHash } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_STORED_VIDEO_BYTES, RENDER_NO_SPACE_DETAIL_PREFIX } from "../../shared/engine";
import { freeBytesOf } from "../freeBytes";
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

/**
 * A stored own file that is gone or is not the file its record describes. A `RenderFailure` in its own right (so every reader that only catches that keeps working);
 * a subclass so that a caller which maps it to the contract's `media-unavailable` (an own video, 3f.3b) can tell it from a full disk or a failed write.
 */
export class OwnMediaUnavailableError extends RenderFailure {
  constructor(what: string) {
    super({ code: "RENDER_FAILED", detail: `an own ${what} of this montage is no longer available: it was removed or changed` });
    this.name = "OwnMediaUnavailableError";
  }
}

/** What a failed read says: no path, and no more than the owner can act on. `what` is "photo", "sticker", "track" or "video". */
export const ownMediaUnavailable = (what: string): OwnMediaUnavailableError => new OwnMediaUnavailableError(what);

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

// ---------- the streaming variant (3f.3b: an own video's mezzanine) ----------
//
// `readVerifiedOwnMedia` holds the whole file in memory, which is right for a photo, a sticker or a track (a few MiB) and wrong for a mezzanine (up to three minutes
// of 1080 x 1920 at CRF 16: hundreds of MiB). `copyVerifiedOwnMedia` is the same verification made a CHUNK at a time, straight into the render's own copy:
//   1. the record's size is judged first (a whole positive number within the largest file the library takes), and the volume of the job folder is asked
//      for room (`statfs`): the file plus a margin for the render's own files, or the render is refused before a byte is read or a file made;
//   2. the library file is opened as every stored file is (`openRegularNoFollow`: no link followed, a plain file only, the handle must be the file the name
//      led to) and the handle's OWN size must be the record's;
//   3. the copy is created with `wx` (nothing already at the name is ever written through or removed) and filled one chunk at a time while the same bytes are
//      hashed with sha256; a read never goes past the record's size plus one byte (to see growth), so a file that keeps growing cannot make it run on;
//   4. the signal is looked at before every chunk and once more at the end, so a cancel stops the copy within one chunk;
//   5. at the END the size read must be the record's and the sha256 must be its: on any failure of any step (and on a cancel) the copy is closed and REMOVED,
//      so no partial or unverified file is ever left for ffmpeg to find.
// ffmpeg then reads the copy only.

/** What the copy asks the volume to keep free beyond the file itself: room for the render's own files (pass-1 intermediates, the layer pass). */
export const OWN_COPY_FREE_MARGIN_BYTES = 256 * 1024 * 1024;
/** One read and one write: the most the copy ever holds in memory. */
export const OWN_COPY_CHUNK_BYTES = 1024 * 1024;

/** The copy being written: what `copyVerifiedOwnMedia` needs of an open file. */
export interface DestFile {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

/** The disk calls of the streamed copy, injectable so a test can play a swap, a full disk, a growing file or a cancel at a chosen chunk. */
export interface StreamCopyIo {
  /** How the library file is opened; `NODE_OPEN_OPS` by default. */
  readonly open?: OpenRegularOps;
  /** Creates the copy EXCLUSIVELY (`wx`); a name already there must reject (EEXIST). */
  readonly openDest?: (path: string) => Promise<DestFile>;
  /** Free bytes on the volume of a folder, or null when it cannot be read (a volume that does not say is not refused); `statfs` by default. */
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /** Removes a file this copy made; `rm` with `force` by default. */
  readonly remove?: (path: string) => Promise<void>;
  /** The chunk size; `OWN_COPY_CHUNK_BYTES` by default. */
  readonly chunkBytes?: number;
  /** The largest record size taken; `MAX_STORED_VIDEO_BYTES` by default (a test lowers it). */
  readonly maxBytes?: number;
  /** Told after each chunk how many bytes of THIS file are copied so far. */
  readonly onBytes?: (copied: number) => void;
}

const defaultOpenDest = (path: string): Promise<DestFile> => open(path, "wx", 0o600);
const defaultRemove = (path: string): Promise<void> => rm(path, { force: true });
export const ownMediaNoSpace = (what: string): RenderFailure => new RenderFailure({ code: "RENDER_FAILED", detail: `${RENDER_NO_SPACE_DETAIL_PREFIX}: the own ${what} cannot be copied` });
const noSpace = ownMediaNoSpace;
/** Something the disk said that is not «it is gone»: an I/O error, a handle limit, a lock held by an antivirus. The file may well be fine. */
const readFailed = (what: string): RenderFailure => new RenderFailure({ code: "RENDER_FAILED", detail: `an own ${what} of this montage could not be read` });
const copyFailed = (what: string): RenderFailure => new RenderFailure({ code: "RENDER_FAILED", detail: `the copy of an own ${what} could not be written to the render's folder` });

/** What a failed write or create of the copy is: a full disk is told as that, anything else without its text (it names the folder). */
function destFailure(error: unknown, what: string): RenderFailure {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return code === "ENOSPC" || code === "EDQUOT" ? noSpace(what) : copyFailed(what);
}

/** The disk's own words for «this is not the file»: gone, not a folder on the way, a link, not a plain file, or another file than the name led to. Nothing else says the file is gone. */
const NOT_THAT_FILE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENOTREG", "ECHANGED"]);
function isNotThatFile(error: unknown): boolean {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && NOT_THAT_FILE.has(code);
}

async function writeAll(file: DestFile, buffer: Uint8Array, length: number): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await file.write(buffer, done, length - done);
    if (!(bytesWritten > 0)) throw new Error("a write wrote nothing");
    done += bytesWritten;
  }
}

/**
 * Copies a stored file to `dest` (which must not exist) in chunks, verified against its record as it goes (see the header). A `RenderFailure` (no path, no id) when it is
 * gone or is not that file, or when the volume has no room; the signal's reason when `signal` fires. When it rejects nothing is left at `dest`
 * unless something not ours was already there, which is never touched.
 */
export async function copyVerifiedOwnMedia(source: StoredFile, what: string, dest: string, signal: AbortSignal, io: StreamCopyIo = {}): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > (io.maxBytes ?? MAX_STORED_VIDEO_BYTES)) throw ownMediaUnavailable(what);
  const free = await (io.freeBytes ?? freeBytesOf)(dirname(dest));
  signal.throwIfAborted();
  if (free !== null && free < source.bytes + OWN_COPY_FREE_MARGIN_BYTES) throw noSpace(what);

  const remove = io.remove ?? defaultRemove;
  let reader: FileHandle | undefined;
  let writer: DestFile | undefined;
  let created = false;
  try {
    reader = await openRegularNoFollow(source.path, { ops: io.open ?? NODE_OPEN_OPS });
    if ((await reader.stat()).size !== source.bytes) throw ownMediaUnavailable(what);
    try {
      writer = await (io.openDest ?? defaultOpenDest)(dest);
    } catch (error) {
      throw destFailure(error, what);
    }
    created = true;

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(io.chunkBytes ?? OWN_COPY_CHUNK_BYTES, source.bytes + 1)));
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      // Never past the record's size plus one byte: the one more is only to SEE that the file grew.
      const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, source.bytes + 1 - total), total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > source.bytes) throw ownMediaUnavailable(what);
      hash.update(buffer.subarray(0, bytesRead));
      try {
        await writeAll(writer, buffer, bytesRead);
      } catch (error) {
        throw destFailure(error, what);
      }
      io.onBytes?.(total);
    }
    signal.throwIfAborted();
    if (total !== source.bytes) throw ownMediaUnavailable(what);
    const finished = writer;
    writer = undefined;
    try {
      await finished.close();
    } catch (error) {
      throw destFailure(error, what);
    }
    if (hash.digest("hex") !== source.sha256) throw ownMediaUnavailable(what);
  } catch (error) {
    await writer?.close().catch(() => undefined);
    if (created) await remove(dest).catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    if (error instanceof RenderFailure) throw error;
    // Only the disk's «not that file» is the file being gone or changed; any other open or read error is a failed read, so the owner is not told the file is gone while the draft says all is well.
    throw isNotThatFile(error) ? ownMediaUnavailable(what) : readFailed(what);
  } finally {
    await reader?.close().catch(() => undefined);
  }
}
