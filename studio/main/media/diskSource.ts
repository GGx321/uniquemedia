import type { BigIntStats } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NODE_OPEN_OPS, openRegularNoFollow, type OpenRegularOps } from "../../engine/library/openRegular";

// Where a served file is opened. The renderer gave an id; the caller built `root` + `segments` from it. Nothing
// here trusts the name that resulted:
//
//   1. every step under the root is `lstat`ed: a link (a symlink or a junction, even one that leads to somewhere
//      inside the root), a file where a folder should be, or a folder where the file should be, is a refusal;
//   2. the file is opened with the no-follow helper (an lstat, `O_NOFOLLOW` where there is one, and the OPENED
//      file must be the one the lstat saw);
//   3. the opened file is compared with what the name leads to NOW: its real path must lie inside the real root and
//      be the same file (device, inode). A folder swapped for a link between steps 1 and 2 opens a file elsewhere,
//      and this is what catches it: that file is never the one at the real path inside the root;
//   4. its size must be within the route's limit and not zero, and its first bytes must be what the route serves.
//
// After that no handle is kept. A stream is many reads, and each one opens the file again, checks it is still THE
// file of step 3 (device, inode, size, mtime), reads its slice and closes. So:
//   - a file replaced after the check is an error on the next read, never other bytes;
//   - nothing of ours holds a served file between two reads. On Windows an open handle keeps a deleted file's name
//     until it closes and makes some operations on it fail; a paused video or a stalled renderer must not be able
//     to hold `videos.delete` off, and here it cannot: at most one short read is ever in flight.

/** A file's bytes, read a slice at a time. */
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes from `offset`; rejects when the file is not the one that was checked, or is shorter now. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** The disk calls, injectable so a test can play a swap between two of them and count handles. */
export interface MediaFsOps {
  readonly open: OpenRegularOps;
  realpath(path: string): Promise<string>;
}

export const NODE_MEDIA_FS: MediaFsOps = { open: NODE_OPEN_OPS, realpath: (path) => realpath(path) };

export interface DiskTarget {
  /** The folder every served file must lie inside (the library, the export root, ...). */
  readonly root: string;
  /** The names under `root`, built from ids by the caller; the last is the file. */
  readonly segments: readonly string[];
  /** A file above this many bytes is not served. */
  readonly maxBytes: number;
  /** Whether the file's first bytes are what this route serves. */
  sniff(header: Uint8Array): boolean;
}

const HEADER_BYTES = 16;

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

const identityOf = (stats: BigIntStats): Identity => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs });
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

function isInside(realRoot: string, realPath: string): boolean {
  const rel = relative(realRoot, realPath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Refuses (null) on anything that is not a plain file of ours under the root, for whatever reason; only ids the caller vetted got this far. */
export async function openDiskSource(target: DiskTarget, ops: MediaFsOps = NODE_MEDIA_FS): Promise<ByteSource | null> {
  try {
    return await open_(target, ops);
  } catch {
    return null;
  }
}

async function open_(target: DiskTarget, ops: MediaFsOps): Promise<ByteSource | null> {
  const realRoot = await ops.realpath(target.root);

  // 1. Nothing on the way is a link, and every step is what it should be.
  let path = target.root;
  for (const [index, name] of target.segments.entries()) {
    path = join(path, name);
    const step = await ops.open.lstat(path);
    if (step.isSymbolicLink()) return null;
    if (index < target.segments.length - 1 ? !step.isDirectory() : !step.isFile()) return null;
  }

  // 2 and 3. Open it, then check that what was opened is what the name leads to inside the root.
  const handle = await openRegularNoFollow(path, { ops: ops.open });
  let identity: Identity;
  let header: Uint8Array;
  try {
    const opened = await handle.stat({ bigint: true });
    const real = await ops.realpath(path);
    if (!isInside(realRoot, real)) return null;
    const named = await ops.open.lstat(real);
    if (!named.isFile() || !sameIdentity(identityOf(named), identityOf(opened))) return null;
    identity = identityOf(opened);

    // 4. A size we serve, and bytes of the kind this route serves.
    if (identity.size <= 0n || identity.size > BigInt(target.maxBytes)) return null;
    const bytes = new Uint8Array(HEADER_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, HEADER_BYTES, 0);
    header = bytes.subarray(0, bytesRead);
    if (!target.sniff(header)) return null;
  } finally {
    await handle.close();
  }

  const size = Number(identity.size);
  const served = identity;
  return {
    size,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new RangeError("the read is outside the file that was checked");
      }
      const again = await openRegularNoFollow(path, { ops: ops.open });
      try {
        if (!sameIdentity(identityOf(await again.stat({ bigint: true })), served)) throw new Error("the file changed after it was checked");
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await again.read(buffer, filled, length - filled, offset + filled);
          if (bytesRead === 0) throw new Error("the file ended before the bytes that were promised");
          filled += bytesRead;
        }
        return buffer;
      } finally {
        await again.close();
      }
    },
  };
}
