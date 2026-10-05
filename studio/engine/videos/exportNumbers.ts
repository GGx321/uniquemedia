import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasErrorCode } from "../library/durableFs";
import { videoPaths, VideoRecordSchema } from "./record";

// The number a new video's file name starts from (Stage 3 review 3-M2).
//
// `claimExportName` takes the first number whose file does not exist. That is not enough: the owner deletes a finished video in Finder (the plan expects it),
// and the number looks free again, but the video's RECORD still names it. The next render would take the name; the older video's card would then read «изменён»
// and play the new clip, and a crash between the rename and the link would make recovery see one path in two records. So a number that any record or any
// pending intent of this avatar still names, for the same export root, folder, date and kind, is never reused: the next one is above the highest of them
// (a per-day high-water mark). Numbers below it that nothing names stay unused; a gap is cheaper than a second video behind one name.

/** A record file is a few KiB of JSON; anything bigger is not one (the listing's own bound). */
const MAX_FILE_BYTES = 1024 * 1024;
/** The same cap as a listing: a folder of junk cannot stall a commit. */
const MAX_FILES_READ = 2000;
const FILE_NAME = /^[a-z0-9-]{8,64}\.json$/;

export interface ExportNumberScope {
  readonly rootId: string;
  /** The avatar's folder name in the export root. */
  readonly folderName: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The kind token. */
  readonly kind: string;
  /** Names are compared without regard to letter case on such a volume. */
  readonly caseInsensitive: boolean;
}

/** The number in `relPath` when it is `<folder>/<date>_<kind>_<NNN>.mp4` of `scope`, else null. */
function numberIn(relPath: string, scope: ExportNumberScope): number | null {
  const fold = (text: string): string => (scope.caseInsensitive ? text.toLowerCase() : text);
  const slash = relPath.indexOf("/");
  if (slash < 0 || fold(relPath.slice(0, slash)) !== fold(scope.folderName)) return null;
  const prefix = fold(`${scope.date}_${scope.kind}_`);
  const name = fold(relPath.slice(slash + 1));
  if (!name.startsWith(prefix) || !name.endsWith(".mp4")) return null;
  const digits = name.slice(prefix.length, -".mp4".length);
  return /^\d{3,}$/.test(digits) ? Number(digits) : null;
}

/** The highest number of `scope` that a record or a pending intent of `avatarId` names; 0 when none does. A file that is not a usable record is not counted. */
export async function highestNamedNumber(libraryRoot: string, avatarId: string, scope: ExportNumberScope): Promise<number> {
  const { videosDir, pendingDir } = videoPaths(libraryRoot, avatarId);
  let highest = 0;
  let budget = MAX_FILES_READ;
  for (const dir of [videosDir, pendingDir]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !FILE_NAME.test(entry.name)) continue;
      if (budget-- <= 0) return highest;
      let value: unknown;
      try {
        const text = await readFile(join(dir, entry.name), "utf8");
        if (text.length > MAX_FILE_BYTES) continue;
        value = JSON.parse(text);
      } catch (error) {
        // Gone since the listing (a commit finished, a delete) or not JSON: nothing there to name a number.
        if (hasErrorCode(error, "ENOENT") || error instanceof SyntaxError) continue;
        throw error;
      }
      const parsed = VideoRecordSchema.safeParse(value);
      if (!parsed.success || parsed.data.avatarId !== avatarId || parsed.data.file.rootId !== scope.rootId) continue;
      const n = numberIn(parsed.data.file.relPath, scope);
      if (n !== null && n > highest) highest = n;
    }
  }
  return highest;
}
