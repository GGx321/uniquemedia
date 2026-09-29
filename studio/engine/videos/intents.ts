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

/**
 * Commits the record: renames the intent to `videos/<videoId>.json`, then flushes
 * `videos/` (the record's entry) and `.pending/` (the intent's removal). The
 * record is write-once: one that already exists is never replaced (EEXIST) and
 * the intent stays for recovery to judge. A missing intent rejects with ENOENT.
 */
export async function commitIntent(fs: CommitFs, libraryRoot: string, avatarId: string, videoId: string): Promise<void> {
  const paths = videoPaths(libraryRoot, avatarId);
  const record = paths.record(videoId);
  try {
    await fs.lstat(record);
    throw Object.assign(new Error("the video record already exists"), { code: "EEXIST" });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await fs.rename(paths.intent(videoId), record);
  await fs.fsyncDir(paths.videosDir);
  await fs.fsyncDir(paths.pendingDir);
}
