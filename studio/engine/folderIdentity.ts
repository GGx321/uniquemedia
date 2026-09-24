import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** The part of the filesystem a folder's identity is read from; injected so tests can play volumes whose file ids mean nothing. */
export interface FolderFs {
  stat(path: string): Promise<{ isDirectory(): boolean; dev: bigint; ino: bigint }>;
  /** The canonical path: symlinks resolved, the letter case as stored (the native realpath). */
  realpath(path: string): Promise<string>;
}

/** `node:fs/promises`' realpath has the native semantics (realpath(3), GetFinalPathNameByHandle). */
export const NODE_FOLDER_FS: FolderFs = {
  stat: (path) => stat(path, { bigint: true }),
  realpath: (path) => realpath(path),
};

/**
 * A folder's identity, for "is this the folder of the library in use?". Two
 * paths name one folder only when their canonical paths match AND, where the
 * volume has real file ids (dev and ino not 0), those match too:
 *
 * - The canonical path alone already tells a trailing slash, a symlink and
 *   another letter case (APFS, NTFS) apart from another folder; two different
 *   folders never share one at the same moment.
 * - The file id is added where it means something, so another volume mounted
 *   at the same path later is not the old folder.
 * - A file id alone is not trusted: some volumes report 0 or ids that repeat
 *   (SMB/WebDAV redirectors, FUSE, cloud drives, ReFS), and taking another
 *   folder for the live library's is the dangerous mistake — the engine would
 *   list and write one folder while main serves another.
 *
 * - Some drivers cannot give a canonical path (on Windows, RAM disks and some
 *   virtual or cloud drives do not support GetFinalPathNameByHandle): then the
 *   resolved path stands in for it. A symlink or another letter case may then
 *   look like another folder — the harmless direction, since a library
 *   switch is refused while paid work runs.
 *
 * Null only when there is no directory at `path` (or it cannot be stat'ed).
 */
export async function folderIdentity(path: string, fs: FolderFs = NODE_FOLDER_FS): Promise<string | null> {
  let info: Awaited<ReturnType<FolderFs["stat"]>>;
  try {
    info = await fs.stat(path);
  } catch {
    return null;
  }
  if (!info.isDirectory()) return null;
  const canonical = await fs.realpath(path).catch(() => resolve(path));
  const idsMeanSomething = info.dev !== 0n && info.ino !== 0n;
  return idsMeanSomething ? `${canonical}\u0000${info.dev}:${info.ino}` : canonical;
}
