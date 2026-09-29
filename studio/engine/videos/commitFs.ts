import { lstat, link as fsLink, mkdir, open, readdir, realpath, unlink as fsUnlink } from "node:fs/promises";
import { fsyncDir, fsyncFile, writeFileDurable } from "../library/durableFs";
import { renameWithRetry } from "../library/renameRetry";

// Every disk call the video commit and its recovery make, behind one small
// interface, so a test can play a crash between any two steps or a full disk. The real
// implementation is the library's own durable helpers plus `lstat`/`realpath`.
//
// There is deliberately no copy: the temp and its placeholder live in the SAME
// folder, so a rename between them cannot cross a volume. An EXDEV from `rename` is
// a refusal, not a fallback (which would need a half-written file under a final name).

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

/** Which file a name led to at some moment: a name can be re-pointed, an inode cannot. */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface DirEntryFacts {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface CommitFs {
  lstat(path: string): Promise<FileFacts>;
  realpath(path: string): Promise<string>;
  /** The entries of a folder; a symlink is reported as one and never as the folder or file it points at. */
  readdir(path: string): Promise<DirEntryFacts[]>;
  /** NON-recursive; rejects EEXIST / ENOENT like `mkdir`. */
  mkdir(path: string): Promise<void>;
  /** Creates an empty file only if there is none (`wx`): the name claim. Answers with the new file's identity, taken from the open handle. */
  createExclusive(path: string): Promise<FileIdentity>;
  /** Creates a NEW file (`wx`), writes `text` and fsyncs it. */
  writeNew(path: string, text: string): Promise<void>;
  /** Flushes a file's data. Opens it `r+`: on Windows a read-only handle cannot be flushed (EPERM). */
  fsyncFile(path: string): Promise<void>;
  /** Makes a rename or a new entry durable (a no-op on Windows, where a directory cannot be flushed). */
  fsyncDir(path: string): Promise<void>;
  /** Replaces `to` if there is one. */
  rename(from: string, to: string): Promise<void>;
  /** A second name for `existing`, atomically and never over anything: EEXIST when `created` exists. */
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const NODE_COMMIT_FS: CommitFs = {
  lstat: async (path) => {
    const info = await lstat(path);
    return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev, nlink: info.nlink };
  },
  realpath: (path) => realpath(path),
  readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() })),
  mkdir: async (path) => {
    await mkdir(path);
  },
  createExclusive: async (path) => {
    const handle = await open(path, "wx");
    try {
      const info = await handle.stat();
      return { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
  },
  writeNew: (path, text) => writeFileDurable(path, text),
  fsyncFile: (path) => fsyncFile(path),
  fsyncDir: (path) => fsyncDir(path),
  rename: (from, to) => renameWithRetry(from, to),
  link: (existing, created) => fsLink(existing, created),
  unlink: (path) => fsUnlink(path),
};
