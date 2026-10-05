import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "../library";
import type { UsageReason } from "../library/library";
import { hasErrorCode } from "../library/durableFs";
import { videoPaths, VideoRecordSchema } from "./record";

// The number a new video's file name starts from (Stage 3 review 3-M2, rounds 2 and 3).
//
// `claimExportName` takes the first number whose file does not exist. That is not enough: the owner deletes a finished video in Finder (the plan expects it),
// and the number looks free again, but the video's RECORD still names it. The next render would take the name; the older video's card would then read «изменён»
// and play the new clip, and a crash between the rename and the link would make recovery see one path in two records. So a number that any record or any
// pending intent names, for the same export root, folder, date and kind, is never reused: the next one is above the highest of them (a per-day high-water mark).
//
// ACROSS AVATARS. The folder is `safeName(avatar.name, avatar.id)`, and two avatars can share one («Mia» and «Mia», a renamed avatar), so the records and intents of
// EVERY avatar of the library count, not only the committing avatar's. The records come from the library's used index (no disk read under the export root's lock);
// `.pending/` (a few small files) is read from disk, and so is the `videos/` folder of an avatar whose index cannot be trusted (stale, or a record that could not be
// read): its records are not all in the index. Every disk call runs under the commit's own signal (its cancel and its deadline). An intent or a folder that cannot be
// read is logged and left out: its number is then guarded by the file the claim finds (or not) in the folder, which is no worse than before this check existed, and one
// unreadable file must not fail every commit.
//
// NOT COVERED (residual): two libraries that use one export root number independently, since neither sees the other's records.

/** An intent is a few KiB of JSON; anything bigger is not one (the listing's own bound). */
const MAX_FILE_BYTES = 1024 * 1024;
/** A folder of junk cannot stall a commit: at most this many files are read in all. */
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

/**
 * The reasons an avatar's used index may be missing records: a stale index, a record that could not be read. The others (`rejects-unreadable`, `library-too-new`) say
 * nothing about the records the index does hold, so they do not send the scan to the disk.
 */
const READ_FROM_DISK_REASONS: ReadonlySet<UsageReason> = new Set<UsageReason>(["index-stale", "record-unreadable", "record-inaccessible"]);

/** What the scan needs of the library. */
export type ExportNumberLibrary = Pick<Library, "listAvatars" | "namedVideoFiles" | "usageReasons">;

/** The disk calls of the scan; the real ones unless a test plays a library disk that does not answer. */
export interface NumberFs {
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean }>>;
  lstat(path: string): Promise<{ size: number; isFile: boolean }>;
  readFile(path: string): Promise<string>;
}

export const NODE_NUMBER_FS: NumberFs = {
  readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile() })),
  lstat: async (path) => {
    const info = await lstat(path);
    return { size: info.size, isFile: info.isFile() };
  },
  readFile: (path) => readFile(path, "utf8"),
};

/** `work` raced against `signal`: a disk call that never returns (a dead library drive) cannot hold the commit past its cancel or its deadline. */
function abortable<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (signal === undefined) return work;
  // First: the call has already been made (it is the argument), so its failure must have a handler even when the signal fired during it.
  work.catch(() => undefined);
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const out = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  out.catch(() => undefined);
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
 * The highest number of `scope` that a record (any avatar's, from the index, and from disk for an avatar whose index cannot be trusted) or a pending intent (any
 * avatar's, from disk) names; 0 when none does. Rejects only for the signal's reason (a cancel or the commit's deadline): a folder or a file that cannot be read is
 * logged and left out.
 */
export async function highestNamedNumber(
  library: ExportNumberLibrary,
  libraryRoot: string,
  scope: ExportNumberScope,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
  fs: NumberFs = NODE_NUMBER_FS,
): Promise<number> {
  let highest = 0;
  const see = (rootId: string, relPath: string): void => {
    if (rootId !== scope.rootId) return;
    const n = numberIn(relPath, scope);
    if (n !== null && n > highest) highest = n;
  };
  for (const file of library.namedVideoFiles()) see(file.rootId, file.relPath);

  let budget = MAX_INTENTS_READ;
  let unreadable = 0;
  let unlistable = 0;
  /** Reads the intents or records in `dir`; false when the file budget ran out. */
  const scan = async (dir: string): Promise<boolean> => {
    let names: string[];
    try {
      names = (await abortable(signal, fs.readdir(dir))).filter((entry) => entry.isFile && FILE_NAME.test(entry.name)).map((entry) => entry.name);
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return true;
      unlistable++;
      return true;
    }
    for (const name of names) {
      signal?.throwIfAborted();
      if (budget-- <= 0) {
        log(`commit: more than ${MAX_INTENTS_READ} files to read for the file numbers; the rest are not counted`);
        return false;
      }
      const path = join(dir, name);
      let value: unknown;
      try {
        // Looked at before it is read whole: a huge file is not an intent.
        const info = await abortable(signal, fs.lstat(path));
        if (!info.isFile || info.size > MAX_FILE_BYTES) continue;
        value = JSON.parse(await abortable(signal, fs.readFile(path)));
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason;
        // Gone since the listing (a commit finished) or not JSON: nothing there to name a number. Any other error is a file that cannot be read now.
        if (hasErrorCode(error, "ENOENT") || error instanceof SyntaxError) continue;
        unreadable++;
        continue;
      }
      const parsed = VideoRecordSchema.safeParse(value);
      if (parsed.success) see(parsed.data.file.rootId, parsed.data.file.relPath);
    }
    return true;
  };

  scanning: for (const avatar of library.listAvatars()) {
    signal?.throwIfAborted();
    const { pendingDir, videosDir } = videoPaths(libraryRoot, avatar.id);
    if (!(await scan(pendingDir))) break scanning;
    // An avatar whose index is stale or has a record it could not read does not have all its records in the index: its folder is read from disk.
    if (library.usageReasons(avatar.id).some((reason) => READ_FROM_DISK_REASONS.has(reason)) && !(await scan(videosDir))) break scanning;
  }
  if (unreadable > 0) log(`commit: ${unreadable} file(s) could not be read and are not counted for the file numbers`);
  if (unlistable > 0) log(`commit: ${unlistable} folder(s) could not be listed and are not counted for the file numbers`);
  return highest;
}
