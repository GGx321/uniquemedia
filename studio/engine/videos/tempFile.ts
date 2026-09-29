import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";

// The render's output file is created by the JOB, right before pass 2 writes it by path (`-y`, for the whole render), so
// ffmpeg only ever truncates a file this job made a moment ago. The create itself is exclusive and does not follow a link.
// POSIX gets both from `O_CREAT | O_EXCL | O_NOFOLLOW`. Windows has no `O_NOFOLLOW`, and `CREATE_NEW` without
// `FILE_FLAG_OPEN_REPARSE_POINT` may follow a DANGLING symlink and create its target; so, on every platform, what was
// created (by handle) is compared with what the name leads to now (by `lstat`), and a mismatch is refused.

export interface TempFacts {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly nlink: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface TempOps {
  open(path: string, flags: number, mode: number): Promise<{ stat(): Promise<TempFacts>; close(): Promise<void> }>;
  lstat(path: string): Promise<TempFacts>;
  unlink(path: string): Promise<void>;
}

const factsOf = (info: { isFile(): boolean; isSymbolicLink(): boolean; nlink: bigint; dev: bigint; ino: bigint }): TempFacts => ({
  isFile: info.isFile(),
  isSymbolicLink: info.isSymbolicLink(),
  nlink: info.nlink,
  dev: info.dev,
  ino: info.ino,
});

export const NODE_TEMP_OPS: TempOps = {
  open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return { stat: async () => factsOf(await handle.stat({ bigint: true })), close: () => handle.close() };
  },
  lstat: async (path) => factsOf(await lstat(path, { bigint: true })),
  unlink: (path) => unlink(path),
};

/** Creates the empty file at `path`; rejects with EEXIST for any name that is there, and with ELOOP when the name does not lead to the file just created. */
export async function createTempExclusive(path: string, ops: TempOps = NODE_TEMP_OPS): Promise<void> {
  const handle = await ops.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666);
  try {
    const created = await handle.stat();
    const named = await ops.lstat(path);
    if (named.isSymbolicLink || !named.isFile || named.nlink !== 1n || named.dev !== created.dev || named.ino !== created.ino) {
      // A link where our file should be is the link's to remove (never its target). Anything else under the name is not ours: left as it is.
      if (named.isSymbolicLink) await ops.unlink(path).catch(() => undefined);
      throw Object.assign(new Error("the render's output name does not lead to the file that was created"), { code: "ELOOP" });
    }
  } finally {
    await handle.close();
  }
}
