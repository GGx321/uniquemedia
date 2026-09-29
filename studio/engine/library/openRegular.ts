import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

// Opening a file that must be OURS, on every platform.
//
// `O_NOFOLLOW` is not there on Windows (`constants.O_NOFOLLOW` is undefined, and OR-ing an
// undefined in adds nothing), so a `open()` that leans on it FOLLOWS a symlink or a junction
// there. The guarantee therefore rests on three steps that hold everywhere, and the flag is a
// fourth layer wherever it exists:
//   1. `lstat` the path: a symlink or a junction (`lstat` reports both as a link) is refused
//      (ELOOP), and so is anything that is not a regular file (ENOTREG);
//   2. `open` it, with `O_NOFOLLOW` where there is one;
//   3. `fstat` the HANDLE and require the same `dev` + `ino` as step 1 and `isFile()`, read as
//      bigints (exFAT and FAT report 2^64-1 and NTFS file indexes exceed 2^53, which a `number`
//      cannot tell apart from its neighbours). A name re-pointed between 1 and 2 opens some other
//      file, and that is a refusal (ECHANGED): "not ours" is never read from.
//
// `O_NONBLOCK` is only there so that opening a FIFO cannot hang. Windows has neither the flag nor
// FIFOs (a named pipe is not reachable through a file path that `lstat` calls a regular file), so
// step 1 alone keeps a device or pipe out; where the flag exists it is still passed.

export type OpenRefusal = "ELOOP" | "ENOTREG" | "ECHANGED";

/** The path is not a plain file of ours: a link, a folder or device, or a file that changed identity while it was being opened. */
export class UnsafeOpenError extends Error {
  readonly code: OpenRefusal;
  constructor(code: OpenRefusal, message: string) {
    super(message);
    this.name = "UnsafeOpenError";
    this.code = code;
  }
}

/** `code` is `ENOTREG`. */
export class NotARegularFileError extends UnsafeOpenError {
  constructor() {
    super("ENOTREG", "not a regular file");
    this.name = "NotARegularFileError";
  }
}

/** The disk calls, injectable so a test can play a swap between two of them or a platform without `O_NOFOLLOW`. */
export interface OpenRegularOps {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: string | number): Promise<FileHandle>;
}

export interface OpenRegularOptions {
  /** The flag to open with; default `O_NOFOLLOW` where there is one, else 0. Pass 0 to play Windows. */
  readonly noFollow?: number;
  /** Default `O_NONBLOCK` where there is one, else 0. */
  readonly nonBlock?: number;
  readonly ops?: OpenRegularOps;
}

/** Which file a name led to at some moment: a name can be re-pointed, an inode cannot. Exact decimal strings. */
export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

export const NODE_OPEN_OPS: OpenRegularOps = {
  lstat: (path) => lstat(path, { bigint: true }),
  open: (path, flags) => open(path, flags),
};

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Opens `path` read-only and returns the handle, or refuses (see the header). A missing file rejects with
 * the disk's own ENOENT, so an absent file is told from a bad one. The handle is closed on every refusal.
 */
export async function openRegularNoFollow(path: string, options: OpenRegularOptions = {}): Promise<FileHandle> {
  const ops = options.ops ?? NODE_OPEN_OPS;
  const noFollow = options.noFollow ?? constants.O_NOFOLLOW ?? 0;
  const nonBlock = options.nonBlock ?? constants.O_NONBLOCK ?? 0;
  const before = await ops.lstat(path);
  if (before.isSymbolicLink()) throw new UnsafeOpenError("ELOOP", "a symlink is not a regular file");
  if (!before.isFile()) throw new NotARegularFileError();
  const handle = await ops.open(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new NotARegularFileError();
    if (!sameFile(before, opened)) throw new UnsafeOpenError("ECHANGED", "the file at the path changed while it was being opened");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const eexist = (message: string): Error => Object.assign(new Error(message), { code: "EEXIST" });

/**
 * Creates an empty file only if NOTHING is at `path` (`wx`), and answers with the identity of the file it
 * made, taken from the open handle. Never replaces or writes through anything:
 * - anything already there (a file, a folder, a link, a dangling one too) is EEXIST, decided by an `lstat`
 *   BEFORE the open. That matters on Windows, where `wx` follows a dangling symlink and creates its target,
 *   and where a folder answers the open with EPERM/EACCES rather than EEXIST;
 * - after the open the path must still be that very file (not a link that appeared in between); if it is
 *   not, EEXIST. (On Windows a link that wins that race has already made its target: a residual window
 *   that needs write access to the folder, and the file is empty.)
 */
export async function createExclusiveNoFollow(path: string, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<FileIdentity> {
  const existing = await ops.lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
      throw error;
    },
  );
  if (existing) throw eexist("something is already at that path");
  const handle = await ops.open(path, "wx");
  try {
    const created = await handle.stat({ bigint: true });
    const named = await ops.lstat(path);
    if (named.isSymbolicLink() || !sameFile(named, created)) throw eexist("the path was taken by something else while the file was created");
    return { dev: String(created.dev), ino: String(created.ino) };
  } finally {
    await handle.close();
  }
}
