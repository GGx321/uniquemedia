import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink as fsUnlink } from "node:fs/promises";
import { fsyncDir, fsyncFile, writeFileDurable } from "../library/durableFs";
import { renameWithRetry } from "../library/renameRetry";

// Every disk call the video commit and its recovery make, behind one small
// interface, so a test can play a crash between any two steps, a full disk, or
// a volume boundary (EXDEV). The real implementation is the library's own
// durable helpers plus `lstat`/`realpath` and a checked copy.

/** What `lstat` says: never follows a symlink. */
export interface FileFacts {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly dev: number;
  readonly nlink: number;
}

export interface CommitFs {
  lstat(path: string): Promise<FileFacts>;
  realpath(path: string): Promise<string>;
  /** NON-recursive; rejects EEXIST / ENOENT like `mkdir`. */
  mkdir(path: string): Promise<void>;
  /** Creates an empty file only if there is none (`wx`): the name claim. */
  createExclusive(path: string): Promise<void>;
  /** Creates a NEW file (`wx`), writes `text` and fsyncs it. */
  writeNew(path: string, text: string): Promise<void>;
  /** Flushes a file's data. Opens it `r+`: on Windows a read-only handle cannot be flushed (EPERM). */
  fsyncFile(path: string): Promise<void>;
  /** Makes a rename or a new entry durable (a no-op on Windows, where a directory cannot be flushed). */
  fsyncDir(path: string): Promise<void>;
  /** Replaces `to` if there is one. */
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /**
   * The EXDEV fallback: copies `source` into `destination`, which must be an
   * existing EMPTY regular file with one link (the claimed placeholder), fsyncs
   * it, and checks that what was written has the expected size and sha256.
   * Rejects with `CopyMismatchError` otherwise.
   */
  copyOver(source: string, destination: string, expected: { bytes: number; sha256: string }): Promise<void>;
}

export class CopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyMismatchError";
  }
}

const COPY_CHUNK = 1024 * 1024;

async function copyOver(source: string, destination: string, expected: { bytes: number; sha256: string }): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  // Where the platform has no O_NOFOLLOW (Windows) a symlink is refused by lstat first.
  if (noFollow === 0 && (await lstat(destination)).isSymbolicLink()) throw new CopyMismatchError("the destination is a symlink");
  const target = await open(destination, constants.O_RDWR | noFollow);
  try {
    const info = await target.stat();
    if (!info.isFile() || info.size !== 0 || info.nlink !== 1) throw new CopyMismatchError("the destination is not an empty, single-link regular file");
    const from = await open(source, "r");
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(COPY_CHUNK);
      let written = 0;
      for (;;) {
        const { bytesRead } = await from.read(buffer, 0, COPY_CHUNK, written);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        await target.write(buffer, 0, bytesRead, written);
        written += bytesRead;
      }
      await target.sync();
      if (written !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new CopyMismatchError("the copied bytes are not the verified bytes");
    } finally {
      await from.close();
    }
  } finally {
    await target.close();
  }
}

export const NODE_COMMIT_FS: CommitFs = {
  lstat: async (path) => {
    const info = await lstat(path);
    return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev, nlink: info.nlink };
  },
  realpath: (path) => realpath(path),
  mkdir: async (path) => {
    await mkdir(path);
  },
  createExclusive: async (path) => {
    const handle = await open(path, "wx");
    await handle.close();
  },
  writeNew: (path, text) => writeFileDurable(path, text),
  fsyncFile: (path) => fsyncFile(path),
  fsyncDir: (path) => fsyncDir(path),
  rename: (from, to) => renameWithRetry(from, to),
  unlink: (path) => fsUnlink(path),
  copyOver,
};
