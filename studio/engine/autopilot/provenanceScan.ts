import { lstat, readdir, readFile } from "node:fs/promises";
import { hasErrorCode } from "../library/durableFs";
import { readVideoRecordFile, readVideoRecordFiles } from "../videos/listing";
import { videoPaths, VideoRecordSchema, type VideoRecord } from "../videos/record";

// Stage 4 (plan §3.6 step 9, §8.3): what the library says of a launch's videos, by the provenance every autopilot record and pending intent carries (`launchId`, `launchVideoKey`).
// This is how a render is ADOPTED after a crash, never by guessing from photo usage: the key decides.
//
// The one rule that matters: «the file exists but does not read» is NOT «no record». A scan that could not read something that might be the launch's says `complete: false`, and the
// steps then wait (or pause); they never render the key again, because a second render of one key would be a second video for it.

export type KeyFinding = { kind: "record"; videoId: string; durationMs: number; bytes: number } | { kind: "intent"; videoId: string };

export interface ProvenanceScan {
  /**
   * The launch's videos found, by launch video key. A record wins over an intent of the same key. A key that is NOT here is «no video» only when `complete`; otherwise it is «not known».
   */
  byKey: ReadonlyMap<string, KeyFinding>;
  /** False when a record or an intent file did not read, more records exist than one read takes, or a folder could not be listed. */
  complete: boolean;
}

/** One video id: the record, nothing at all, or a file that is there and does not read. */
export type VideoLookup = { kind: "record"; durationMs: number; bytes: number } | { kind: "missing" } | { kind: "unreadable" };

/** An intent is a full record-to-be of this size at most, like a record. */
const MAX_INTENT_BYTES = 1024 * 1024;
/** The shape of an intent's file name; the temp files of an intent being written (`.<id>.json.<hex>.tmp`) are dot files and do not match. */
const INTENT_NAME = /^[a-z0-9-]{8,64}\.json$/;

const bytesOf = (record: VideoRecord): number => record.file?.bytes ?? 0;

export async function scanProvenance(libraryRoot: string, avatarId: string, launchId: string, options: { maxFiles?: number } = {}): Promise<ProvenanceScan> {
  const byKey = new Map<string, KeyFinding>();
  let complete = true;

  try {
    const read = await readVideoRecordFiles(libraryRoot, avatarId, options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles });
    if (read.skipped > 0 || read.truncated) complete = false;
    for (const record of read.records) {
      if (record.launchId === launchId && record.launchVideoKey !== undefined) {
        byKey.set(record.launchVideoKey, { kind: "record", videoId: record.id, durationMs: record.durationMs, bytes: bytesOf(record) });
      }
    }
  } catch {
    complete = false;
  }

  const { pendingDir, intent } = videoPaths(libraryRoot, avatarId);
  let names: string[] = [];
  try {
    names = (await readdir(pendingDir, { withFileTypes: true })).filter((entry) => !entry.isDirectory() && INTENT_NAME.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) complete = false;
  }
  for (const name of names.sort()) {
    const videoId = name.slice(0, -".json".length);
    try {
      const path = intent(videoId);
      if ((await lstat(path)).size > MAX_INTENT_BYTES) {
        complete = false;
        continue;
      }
      const parsed = VideoRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (!parsed.success || parsed.data.id !== videoId || parsed.data.avatarId !== avatarId) {
        complete = false;
        continue;
      }
      const { launchId: found, launchVideoKey } = parsed.data;
      if (found === launchId && launchVideoKey !== undefined && !byKey.has(launchVideoKey)) byKey.set(launchVideoKey, { kind: "intent", videoId });
    } catch (error) {
      // Gone between the listing and the read: a commit that finished (its record is read above or by the next scan) or a recovery that dropped it. Anything else is not known.
      if (!hasErrorCode(error, "ENOENT")) complete = false;
    }
  }
  return { byKey, complete };
}

export async function lookupVideo(libraryRoot: string, avatarId: string, videoId: string): Promise<VideoLookup> {
  const path = videoPaths(libraryRoot, avatarId).record(videoId);
  try {
    await lstat(path);
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    // `readVideoRecordFile` answers null for both «not there» and «not a usable record»; the look above has already told the two apart.
    const record = await readVideoRecordFile(libraryRoot, avatarId, videoId);
    return record === null ? { kind: "unreadable" } : { kind: "record", durationMs: record.durationMs, bytes: bytesOf(record) };
  } catch {
    return { kind: "unreadable" };
  }
}
