import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { hasErrorCode } from "../library/durableFs";
import type { CommitFs } from "./commitFs";
import { videoPaths, VideoRecordSchema, type VideoRecord } from "./record";

// The commit intent (Commit row, steps 4 and 6): the FULL record-to-be, written
// to `videos/.pending/<videoId>.json` with temp + fsync + rename, and promoted
// to `videos/<videoId>.json` by one rename as the commit's last step. Until
// that rename the photos are not "used" (the library's reader skips `.pending`),
// and after it they are.

export interface WriteIntentHooks {
  /** Runs after the temp file is durable and before the rename: a crash here leaves a temp and no intent. Test seam. */
  beforeRename?: () => void | Promise<void>;
}

/** Creates `dir` (non-recursive) and, when it is new, flushes `parent`, so the folder itself survives a crash. */
async function ensureFolder(fs: CommitFs, dir: string): Promise<void> {
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return;
    throw error;
  }
  await fs.fsyncDir(dirname(dir));
}

/** Removes a temp file after a failed write. The failure being reported is the write's; a temp that stays is collected by recovery (`.pending/.*.tmp`). */
async function discard(fs: CommitFs, path: string): Promise<void> {
  await fs.unlink(path).catch(() => undefined);
}

/**
 * Writes the intent for `record`. The record is checked against its schema first
 * (a caller bug must not reach the disk), then written to a temp beside the
 * intent, fsynced, renamed into place, and the `.pending` folder is flushed. Any
 * failure (a full disk included) removes the temp, leaves no intent, and rejects
 * with the disk's own error.
 */
export async function writeIntent(fs: CommitFs, libraryRoot: string, record: VideoRecord, hooks: WriteIntentHooks = {}): Promise<void> {
  const valid = VideoRecordSchema.parse(record);
  const paths = videoPaths(libraryRoot, valid.avatarId);
  await ensureFolder(fs, paths.videosDir);
  await ensureFolder(fs, paths.pendingDir);
  const temp = join(paths.pendingDir, `.${valid.id}.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeNew(temp, `${JSON.stringify(valid, null, 2)}\n`);
    await hooks.beforeRename?.();
    await fs.rename(temp, paths.intent(valid.id));
  } catch (error) {
    await discard(fs, temp);
    throw error;
  }
  await fs.fsyncDir(paths.pendingDir);
}

export interface CommitIntentOptions {
  /** Codes only. */
  readonly log?: (line: string) => void;
  /** Runs right after the record exists and before the intent is removed: a crash there leaves both. Test seam. */
  readonly afterLink?: () => void | Promise<void>;
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/**
 * Commits the record. THE COMMIT POINT IS THE MOMENT THE RECORD'S NAME EXISTS: `link(intent, record)` makes it
 * appear atomically and refuses (EEXIST) to replace one, so the record is write-once even against a race.
 *
 * WHERE HARD LINKS DO NOT EXIST (a library on exFAT or FAT32, some network shares: ENOTSUP, EPERM, EISDIR on
 * Windows), `link` fails with anything but EEXIST, and the same is done in two steps, as the export root's marker
 * is published (`exportRoot.ts`): the record's name must not exist (`lstat` says ENOENT, else EEXIST), then
 * `rename(intent, record)`. The rename is the commit point there. Its check-then-rename window is a single
 * engine's own, and the intent is a file only this process writes.
 *
 * A missing intent rejects with ENOENT. From the moment the record exists the video is committed, and
 * nothing after it may undo that, so nothing after it throws:
 * - the intent's own name is removed (a failure leaves intent and record side by side, which recovery
 *   settles by dropping the intent);
 * - `videos/` is flushed, once more if the first flush fails, and a flush that keeps failing is logged;
 * - `.pending/` is flushed, and a failure is logged.
 * The caller that must not roll back after this point is `commitVideo`.
 */
export async function commitIntent(fs: CommitFs, libraryRoot: string, avatarId: string, videoId: string, options: CommitIntentOptions = {}): Promise<void> {
  const paths = videoPaths(libraryRoot, avatarId);
  const log = options.log ?? (() => undefined);
  let renamed = false;
  try {
    await fs.link(paths.intent(videoId), paths.record(videoId));
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw error;
    // No hard links here (or the link failed some other way): exclusive by lookup, then rename.
    log(`video ${videoId}: link is not available (${codeOf(error)}); the record is written by an exclusive rename`);
    try {
      await fs.lstat(paths.record(videoId));
      throw Object.assign(new Error("the video record already exists"), { code: "EEXIST" });
    } catch (lookup) {
      if (!hasErrorCode(lookup, "ENOENT")) throw lookup;
    }
    await fs.rename(paths.intent(videoId), paths.record(videoId));
    renamed = true;
  }
  await options.afterLink?.();
  if (!renamed) await fs.unlink(paths.intent(videoId)).catch((error: unknown) => log(`video ${videoId}: the intent could not be removed after its record was linked (${codeOf(error)})`));
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.fsyncDir(paths.videosDir);
      break;
    } catch (error) {
      log(`video ${videoId}: videos/ could not be flushed (${codeOf(error)}, attempt ${attempt})`);
      if (attempt >= 2) break;
    }
  }
  await fs.fsyncDir(paths.pendingDir).catch((error: unknown) => log(`video ${videoId}: .pending/ could not be flushed (${codeOf(error)})`));
}
