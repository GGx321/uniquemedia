import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Clip, Id, MontageName, type FileState, type VideoSummary } from "../../shared/engine";
import { hasErrorCode } from "../library/durableFs";
import { isFromNewerVersion, VIDEO_RECORD_SCHEMA_VERSION } from "../library/layout";
import { scenePhotoIds, videoPaths, VideoRecordSchema, type VideoRecord } from "./record";

// `videos.list` reads an avatar's records from disk: the library keeps only what "used" needs (the photo ids), while the
// window shows the file, the kind, the music, the date. The reader is tolerant: a file that is not a usable record is
// left out and counted, never a failure of the listing (a broken or newer record closes the avatar's USAGE elsewhere,
// in the library; here it is only missing from the list).

/** Read at most this many record files per listing: more than `MAX_LISTED_VIDEOS`, so the newest of a full listing are considered, and bounded, so a folder of junk cannot stall a read. */
export const MAX_RECORD_FILES_READ = 2000;
/** A record is a few KiB of JSON (its resolved spec included); anything bigger is not one. */
const MAX_RECORD_BYTES = 1024 * 1024;
/** Exactly the shape of a record's file name; temp files (`.<name>.tmp-…`), notes and the `.pending` folder do not match. */
const RECORD_NAME = /^([a-z0-9-]{8,64})\.json$/;

export interface VideoRecordsRead {
  /** Newest first (`createdAt`, then id). */
  readonly records: VideoRecord[];
  /** Files with a record's name that could not be used: unreadable, foreign, misfiled, from a newer version. */
  readonly skipped: number;
  /** More names were there than `maxFiles`: the newest may be missing. */
  readonly truncated: boolean;
}

/** One record file, or null when it is not a usable record of `avatarId` named `name`. */
async function readOne(path: string, avatarId: string, videoId: string): Promise<VideoRecord | null> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
  const text = await readFile(path, "utf8"); // a read error (a delete meanwhile: ENOENT) goes to the caller, which tells the two apart
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (isFromNewerVersion(value, VIDEO_RECORD_SCHEMA_VERSION)) return null;
  const parsed = VideoRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== videoId || parsed.data.avatarId !== avatarId) return null;
  return parsed.data;
}

/** One record by id, or null when it is not there or is not a usable record of `avatarId`. A disk error other than "not there" rejects. */
export async function readVideoRecordFile(libraryRoot: string, avatarId: string, videoId: string): Promise<VideoRecord | null> {
  try {
    return await readOne(videoPaths(libraryRoot, avatarId).record(videoId), avatarId, videoId);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readVideoRecordFiles(libraryRoot: string, avatarId: string, options: { maxFiles?: number } = {}): Promise<VideoRecordsRead> {
  const maxFiles = options.maxFiles ?? MAX_RECORD_FILES_READ;
  const { videosDir, record } = videoPaths(libraryRoot, avatarId);
  let names: string[];
  try {
    names = (await readdir(videosDir, { withFileTypes: true })).filter((entry) => !entry.isDirectory() && RECORD_NAME.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { records: [], skipped: 0, truncated: false };
    throw error;
  }
  names.sort();
  const truncated = names.length > maxFiles;
  if (truncated) {
    // More names than one listing reads: keep the NEWEST (a record is written once, so its file's age is its age), not the first names of a random alphabet.
    const aged: Array<{ name: string; at: number }> = [];
    for (const name of names) {
      try {
        aged.push({ name, at: (await lstat(join(videosDir, name))).mtimeMs });
      } catch {
        aged.push({ name, at: 0 }); // unreadable or gone: the oldest
      }
    }
    names = aged.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1)).map((entry) => entry.name);
  }
  const records: VideoRecord[] = [];
  let skipped = 0;
  for (const name of names.slice(0, maxFiles)) {
    const videoId = name.slice(0, -".json".length);
    let read: VideoRecord | null;
    try {
      read = await readOne(record(videoId), avatarId, videoId);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue; // gone between the listing and the read: a delete, not corruption
      skipped++;
      continue;
    }
    if (read === null) skipped++;
    else records.push(read);
  }
  records.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1));
  return { records, skipped, truncated };
}

/** The part of a record's (loose) spec that names a trending track. */
const TrendingMusic = z.looseObject({ music: z.looseObject({ source: z.literal("trending"), trackId: Id }) });

/** The trending track the spec used, by its id (K13); null for an own track, a silent video, or an id that is not one. */
function trackIdOf(spec: VideoRecord["spec"]): string | null {
  const parsed = TrendingMusic.safeParse(spec);
  return parsed.success ? parsed.data.music.trackId : null;
}

/** The first clip as the contract's `Clip` (the tile's still, 3e.2), or null for one this build cannot read. */
function firstClipOf(spec: VideoRecord["spec"]): z.infer<typeof Clip> | null {
  const parsed = Clip.safeParse(spec.clips[0]);
  return parsed.success ? parsed.data : null;
}

/**
 * A record as the windows see it. `hasPoster` is false for every record until the poster frame is made (not built in 3e.2:
 * the tile draws `firstClip` instead): the record does not carry one yet, and saying otherwise would send the tile to a
 * route that has nothing. The title and the first clip are only shown, so a value this build cannot read is null, never
 * a reason to leave the record out.
 */
export function videoSummaryOf(record: VideoRecord, fileState: FileState): VideoSummary {
  const title = MontageName.safeParse(record.title);
  return {
    videoId: record.id,
    avatarId: record.avatarId,
    kind: record.kind,
    durationMs: record.durationMs,
    bytes: record.file.bytes,
    createdAt: record.createdAt,
    relPath: record.file.relPath,
    fileState,
    montageId: record.montageId,
    photoCount: scenePhotoIds(record.spec.clips).length,
    music: record.music === null ? null : { ...record.music, trackId: trackIdOf(record.spec) },
    hasPoster: false,
    title: title.success ? title.data : null,
    firstClip: firstClipOf(record.spec),
  };
}
