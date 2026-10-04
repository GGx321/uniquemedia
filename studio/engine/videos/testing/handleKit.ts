import type { FileHandle } from "node:fs/promises";

// Test support for the guards that read a stored own file from an OPEN HANDLE (`ownMedia.ts`): a handle whose `stat` lies about the size, and one that
// counts what it is asked to read. The stat a handle answers keeps its methods (`isFile`) and its identity (`dev`, `ino`), so the guard under test is
// reached: a stand-in that dropped them would be refused by `openRegularNoFollow` before the size was ever looked at, and the test would pass for the wrong reason.

type Stats = Awaited<ReturnType<FileHandle["stat"]>>;

/** Binds a method to the object it was taken from, and leaves anything else as it is. */
const bound = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
};

export interface LyingHandle {
  readonly handle: FileHandle;
  /** How many times `read` was called. */
  readonly reads: () => number;
  /** How many bytes it was asked for in all. */
  readonly asked: () => number;
}

/**
 * `real`, but its `stat` says the file is `lyingSize` bytes (as a number, or as a bigint when asked for bigints), and its `read` counts and
 * answers `fill` bytes of `0x09` (the whole of what was asked for when `fill` is not given), as a file that keeps growing would.
 */
export function lyingHandle(real: FileHandle, options: { lyingSize?: number; fill?: number | "all" | "none" } = {}): LyingHandle {
  let reads = 0;
  let asked = 0;
  const handle = new Proxy(real, {
    get(target, property) {
      if (property === "stat" && options.lyingSize !== undefined) {
        const size = options.lyingSize;
        return async (statOptions?: { bigint?: boolean }): Promise<Stats> => {
          const stats = await target.stat(statOptions as never);
          return new Proxy(stats, { get: (inner, key) => (key === "size" ? (statOptions?.bigint === true ? BigInt(size) : size) : bound(inner, key)) });
        };
      }
      if (property === "read" && options.fill !== undefined) {
        return async (buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number; buffer: Uint8Array }> => {
          reads++;
          asked += length;
          const fill = options.fill;
          const bytesRead = fill === "none" ? 0 : fill === "all" ? length : Math.min(length, fill ?? 0);
          buffer.fill(9, offset, offset + bytesRead);
          return { bytesRead, buffer };
        };
      }
      return bound(target, property);
    },
  });
  return { handle, reads: () => reads, asked: () => asked };
}
