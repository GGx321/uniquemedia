import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "../library";
import { hasErrorCode } from "../library/durableFs";
import { videoPaths, VideoRecordSchema } from "./record";

// The number a new video's file name starts from (Stage 3 review 3-M2, round 2).
//
// `claimExportName` takes the first number whose file does not exist. That is not enough: the owner deletes a finished video in Finder (the plan expects it),
// and the number looks free again, but the video's RECORD still names it. The next render would take the name; the older video's card would then read «изменён»
// and play the new clip, and a crash between the rename and the link would make recovery see one path in two records. So a number that any record or any
// pending intent names, for the same export root, folder, date and kind, is never reused: the next one is above the highest of them (a per-day high-water mark).
//
// ACROSS AVATARS. The folder is `safeName(avatar.name, avatar.id)`, and two avatars can share one («Mia» and «Mia», a renamed avatar), so the records and intents of
// EVERY avatar of the library count, not only the committing avatar's. The records come from the library's used index (no disk read under the export root's lock);
// only `.pending/` (a few small files) is read from disk, under the commit's own signal (its cancel and its deadline). An intent that cannot be read is logged and
// left out: its number is then guarded by the file the claim finds (or not) in the folder, which is no worse than before this check existed, and one unreadable file must
// not fail every commit.

/** An intent is a few KiB of JSON; anything bigger is not one (the listing's own bound). */
const MAX_FILE_BYTES = 1024 * 1024;
/** A folder of junk cannot stall a commit: at most this many intents are read in all. */
export const MAX_INTENTS_READ = 2000;
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

/** What the scan needs of the library. */
export type ExportNumberLibrary = Pick<Library, "listAvatars" | "namedVideoFiles">;

/** `work` raced against `signal`: a disk call that never returns (a dead library drive) cannot hold the commit past its cancel or its deadline. */
function abortable<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (signal === undefined) return work;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const out = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  out.catch(() => undefined);
  work.catch(() => undefined);
  return Promise.race([work, out]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
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

/**
 * The highest number of `scope` that a record (any avatar's, from the index) or a pending intent (any avatar's, from disk) names; 0 when none does.
 * Rejects only for the signal's reason (a cancel or the commit's deadline) or when an avatar's `.pending/` folder cannot be listed for another reason than
 * not being there; a single intent that cannot be read is logged and skipped.
 */
export async function highestNamedNumber(library: ExportNumberLibrary, libraryRoot: string, scope: ExportNumberScope, signal: AbortSignal | undefined, log: (line: string) => void): Promise<number> {
  let highest = 0;
  const see = (rootId: string, relPath: string): void => {
    if (rootId !== scope.rootId) return;
    const n = numberIn(relPath, scope);
    if (n !== null && n > highest) highest = n;
  };
  for (const file of library.namedVideoFiles()) see(file.rootId, file.relPath);

  let budget = MAX_INTENTS_READ;
  let unreadable = 0;
  for (const avatar of library.listAvatars()) {
    signal?.throwIfAborted();
    const { pendingDir } = videoPaths(libraryRoot, avatar.id);
    let names: string[];
    try {
      names = (await abortable(signal, readdir(pendingDir, { withFileTypes: true }))).filter((entry) => entry.isFile() && FILE_NAME.test(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
      throw error;
    }
    for (const name of names) {
      signal?.throwIfAborted();
      if (budget-- <= 0) {
        log(`commit: more than ${MAX_INTENTS_READ} pending intents; the rest are not counted for the file numbers`);
        return highest;
      }
      const path = join(pendingDir, name);
      let value: unknown;
      try {
        // Looked at before it is read whole: a huge file is not an intent.
        const info = await abortable(signal, lstat(path));
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        value = JSON.parse(await abortable(signal, readFile(path, "utf8")));
      } catch (error) {
        // Gone since the listing (a commit finished) or not JSON: nothing there to name a number. Any other error is a file that cannot be read now.
        if (signal?.aborted === true) throw error;
        if (hasErrorCode(error, "ENOENT") || error instanceof SyntaxError) continue;
        unreadable++;
        continue;
      }
      const parsed = VideoRecordSchema.safeParse(value);
      if (parsed.success) see(parsed.data.file.rootId, parsed.data.file.relPath);
    }
  }
  if (unreadable > 0) log(`commit: ${unreadable} pending intent(s) could not be read and are not counted for the file numbers`);
  return highest;
}
