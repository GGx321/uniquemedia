import { readFile } from "node:fs/promises";
import { Id, type FileState } from "../../shared/engine";
import type { Library } from "../library";
import { hasErrorCode } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
import { FileStateChecker, recordFilePath } from "./fileState";
import { videoPaths, VideoRecordSchema, type VideoPaths, type VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";

// `videos.delete`, library level (Stage 3 plan, "Used" row and 3a.8b): the FILE
// if it is present, then the RECORD, then the used index. So at every moment the
// disk says something true:
//
//   file gone, record stands ... the record reads `missing` and its photos stay used: a crash or a
//                                failure between the two steps loses nothing, and a retry finishes it
//   record gone ................ the photos are free (the index follows at once)
//
// WHAT IS DELETED. The file only when it is `present` by the FULL check (size and sha256, through a real
// folder inside the export root): never on a cheap answer. A file that is `missing`, `elsewhere` or `changed`
// is never touched and only the record goes («Удалить запись»). `changed` in particular: its size or sha256 no
// longer matches what Studio wrote, so it is not provably Studio's file (the owner may have re-exported over it);
// deleting it would be deleting the owner's work on a guess. The record goes, the photos are freed, the file
// stays for the owner. (Between the hash and the unlink there is a window of milliseconds in which the owner
// could replace the file; the alternative, an unlink by handle, does not exist on every platform.)
//
// A record that cannot be read cannot name its file: it is refused, not guessed at. Its avatar is closed
// (fail-closed usage) until the record is repaired, which is 3e.2's job.

/** No record with this id in any avatar of the library. */
export class VideoNotFoundError extends Error {
  constructor(readonly videoId: string) {
    super("no such video");
    this.name = "VideoNotFoundError";
  }
}

/** The record exists but is not a record this build can read. */
export class VideoRecordUnreadableError extends Error {
  constructor(readonly videoId: string) {
    super("the video's record cannot be read");
    this.name = "VideoRecordUnreadableError";
  }
}

export interface DeleteVideoDeps {
  readonly library: Pick<Library, "root" | "listAvatars" | "removeVideoRecordFromIndex">;
  /** The current export root; null when the last check refused it (then only the record can go). */
  readonly exportRoot: ExportRootRef | null;
  readonly checker: FileStateChecker;
  readonly fs?: CommitFs;
  /** Ids and states only. */
  readonly log?: (line: string) => void;
}

export interface DeleteOutcome {
  readonly videoId: string;
  readonly avatarId: string;
  readonly fileDeleted: boolean;
  /** What the full check said before anything was removed. */
  readonly fileState: FileState;
}

async function exists(fs: CommitFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function locate(deps: DeleteVideoDeps, fs: CommitFs, videoId: string): Promise<{ avatarId: string; paths: VideoPaths } | null> {
  for (const avatar of deps.library.listAvatars()) {
    const paths = videoPaths(deps.library.root, avatar.id);
    if (await exists(fs, paths.record(videoId))) return { avatarId: avatar.id, paths };
  }
  return null;
}

async function readRecord(paths: VideoPaths, avatarId: string, videoId: string): Promise<VideoRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(paths.record(videoId), "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new VideoNotFoundError(videoId);
    throw new VideoRecordUnreadableError(videoId);
  }
  const parsed = VideoRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== videoId || parsed.data.avatarId !== avatarId) throw new VideoRecordUnreadableError(videoId);
  return parsed.data;
}

export async function deleteVideo(videoId: string, deps: DeleteVideoDeps): Promise<DeleteOutcome> {
  // An id is checked before it is ever made into a path: a caller's string never reaches the disk unchecked.
  if (!Id.safeParse(videoId).success) throw new VideoNotFoundError(videoId);
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  // One delete of a video at a time: the second finds it gone.
  return runExclusive(`video-delete:${videoId}`, async () => {
    const found = await locate(deps, fs, videoId);
    if (found === null) throw new VideoNotFoundError(videoId);
    const record = await readRecord(found.paths, found.avatarId, videoId);

    const fileState = await deps.checker.check(record, deps.exportRoot, { verify: "full" });
    let fileDeleted = false;
    if (fileState === "present" && deps.exportRoot !== null) {
      await fs.unlink(recordFilePath(record, deps.exportRoot).file);
      fileDeleted = true;
    }
    try {
      await fs.unlink(found.paths.record(videoId));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    await fs.fsyncDir(found.paths.videosDir);
    deps.library.removeVideoRecordFromIndex(found.avatarId, videoId);
    log(`video ${videoId} deleted (file ${fileDeleted ? "removed" : `kept, ${fileState}`})`);
    return { videoId, avatarId: found.avatarId, fileDeleted, fileState };
  });
}
