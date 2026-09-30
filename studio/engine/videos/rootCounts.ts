import type { Library } from "../library";
import { MAX_RECORD_FILES_READ, readVideoRecordFiles } from "./listing";

// 3e.3: what the owner needs to know after pointing Settings at an export folder. A video record names its file by the
// export root's identity (`file.rootId`) and a path relative to it, so a record "resolves" in the folder just chosen
// exactly when it names that folder's `rootId`; the rest stay in another folder (`elsewhere`) until that folder is
// chosen again. This counts records, not files: whether a file is still there is `FileState`'s business, per video.

/** The part of a library this needs: its folder, and the avatars in it (every status: an archived avatar's videos still exist). */
export type RecordsLibrary = Pick<Library, "root" | "listAvatars">;

export interface RootCounts {
  /** Records that name the root. */
  resolved: number;
  /** Records that name another root. */
  elsewhere: number;
  /** Record files that could not be used, counted in neither number. */
  unreadable: number;
  /** An avatar had more record files than one read takes: the numbers may be short. */
  truncated: boolean;
}

export async function countRecordsByRoot(library: RecordsLibrary, rootId: string, options: { maxFilesPerAvatar?: number } = {}): Promise<RootCounts> {
  const counts: RootCounts = { resolved: 0, elsewhere: 0, unreadable: 0, truncated: false };
  for (const avatar of library.listAvatars()) {
    const read = await readVideoRecordFiles(library.root, avatar.id, { maxFiles: options.maxFilesPerAvatar ?? MAX_RECORD_FILES_READ });
    for (const record of read.records) {
      if (record.file.rootId === rootId) counts.resolved++;
      else counts.elsewhere++;
    }
    counts.unreadable += read.skipped;
    if (read.truncated) counts.truncated = true;
  }
  return counts;
}

/**
 * Whether the library holds any video record at all, a file nobody could read included (it may be the very one that names a
 * damaged marker). A disk that cannot be read says yes: this guards advice that could orphan records, so it errs toward them.
 */
export async function libraryHasVideoRecords(library: RecordsLibrary): Promise<boolean> {
  for (const avatar of library.listAvatars()) {
    try {
      const read = await readVideoRecordFiles(library.root, avatar.id, { maxFiles: 1 });
      if (read.records.length + read.skipped > 0) return true;
    } catch {
      return true;
    }
  }
  return false;
}
