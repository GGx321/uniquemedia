import { createHash } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { dirname, join } from "node:path";
import { isSafeName } from "../../shared/engine";
import { placeOf } from "../exportName";
import { EXPORT_MARKER_FILE } from "../exportRoot";
import { hasErrorCode, isTempName } from "../library/durableFs";
import { isFromNewerVersion, VIDEO_RECORD_SCHEMA_VERSION } from "../library/layout";
import type { Library } from "../library";
import { sweepPartFiles } from "../renderQueue/sweep";
import { commitIntent } from "./intents";
import { NODE_COMMIT_FS, type CommitFs, type FileFacts } from "./commitFs";
import { partNameOf, scenePhotoIds, videoPaths, VideoRecordSchema } from "./record";

// Settling the video commit's crash windows when a library is opened (Stage 3
// plan, "Commit" row and invariant 23). The commit leaves the disk in one of a
// small set of states (see commit.ts); each has one answer here:
//
//   .studio-part-<jobId>.mp4 alone ............ swept
//   an empty placeholder, no intent ........... deleted (a 0-byte MP4 is never a real video)
//   an intent, its file still 0 bytes ......... intent and placeholder dropped
//   an intent, its file half-copied (EXDEV) ... the partial file removed if it is a prefix of the
//                                               surviving verified temp, then the intent dropped
//   an intent, its file = size + sha256 ....... ADOPTED: the intent becomes the record and the used
//                                               index is told
//   an intent and a record with the same id ... the intent dropped, the record stands
//   any other intent .......................... dropped; the file, if any, is left as it is
//
// HANDS OFF: nothing is deleted that no intent or record of ours names, except
// `.studio-part-*` temps, 0-byte placeholders of our name pattern in a real
// `<SafeName>/` folder, and Studio's own scratch in the root (`.studio-export.json.tmp-*`,
// 0-byte `.studio-probe-*`). A symlink is never followed and never removed,
// and the export folder is never entered through one.
//
// A job that is running right now is not a crash: its temp and placeholder are
// passed in (`liveTemps`, `livePlaceholders`, normalised absolute paths) and kept.
// Nothing here throws for a disk problem: it is skipped and reported, and the
// library still opens. Every step is idempotent, so a second run finds nothing.

export interface ExportRootRef {
  /** The export root as the settings name it. */
  readonly root: string;
  /** The marker's id, from the last successful check. */
  readonly rootId: string;
  readonly caseInsensitive: boolean;
}

export interface RecoverInput {
  readonly library: Pick<Library, "root" | "listAvatars" | "addVideoRecordToIndex">;
  /** The current export root, or null when the last check refused it (its intents are then kept). */
  readonly exportRoot: ExportRootRef | null;
  /** Temps of renders running now, as absolute paths in `path.resolve` form. */
  readonly liveTemps?: ReadonlySet<string>;
  /** Claimed placeholders of renders running now, same form. */
  readonly livePlaceholders?: ReadonlySet<string>;
}

export interface RecoverDeps {
  readonly fs?: CommitFs;
  /** Ids, counts and codes only; never a path or a file value. */
  readonly log?: (line: string) => void;
}

export type DropReason = "empty-placeholder" | "partial-copy" | "mismatch" | "no-file" | "not-a-file" | "not-a-folder" | "outside-root" | "record-exists";

export interface RecoveryReport {
  /** Video ids whose intent was promoted to a record. */
  readonly adopted: string[];
  readonly dropped: Array<{ videoId: string; reason: DropReason }>;
  /** Intents kept: their file cannot be judged now. */
  readonly deferred: Array<{ videoId: string; reason: "other-root" | "export-unavailable" }>;
  /** Files in `.pending/` recovery cannot settle, relative to the library. */
  readonly left: Array<{ file: string; reason: "unreadable" | "too-new" | "foreign" }>;
  readonly removed: { placeholders: number; partialFiles: number; intentTemps: number; markerTemps: number; probes: number; partTemps: number };
  /** Steps a disk error stopped; they are retried at the next open. */
  readonly skipped: Array<{ what: string; code: string }>;
}

const INTENT_NAME = /^([a-z0-9-]{8,64})\.json$/;
const PLACEHOLDER_NAME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_[a-z][a-z0-9]{0,15}_\d{3,6}\.mp4$/;
const MARKER_TEMP_NAME = /^\.studio-export\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBE_NAME = /^\.studio-probe-/;
const MAX_INTENT_BYTES = 1024 * 1024;
const READ_CHUNK = 1024 * 1024;

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
}

async function lstatOrNull(fs: CommitFs, path: string): Promise<FileFacts | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

/** sha256 of a file, read in chunks. */
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK);
    for (let at = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, at);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** Whether the first `length` bytes of `short` are the first `length` bytes of `long`. */
async function isPrefixOf(short: string, long: string, length: number): Promise<boolean> {
  const [a, b] = [await open(short, "r"), await open(long, "r")];
  try {
    const [bufA, bufB] = [Buffer.alloc(READ_CHUNK), Buffer.alloc(READ_CHUNK)];
    for (let at = 0; at < length; ) {
      const want = Math.min(READ_CHUNK, length - at);
      const [readA, readB] = [await a.read(bufA, 0, want, at), await b.read(bufB, 0, want, at)];
      if (readA.bytesRead !== want || readB.bytesRead !== want || !bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false;
      at += want;
    }
    return true;
  } finally {
    await a.close();
    await b.close();
  }
}

/** The root as a real folder, or null: a vanished or unplugged root is "cannot judge", never "nothing there". */
async function usableRoot(fs: CommitFs, ref: ExportRootRef | null): Promise<{ ref: ExportRootRef; real: string } | null> {
  if (ref === null) return null;
  try {
    const real = await fs.realpath(ref.root);
    return (await fs.lstat(real)).isDirectory ? { ref, real } : null;
  } catch {
    return null;
  }
}

export async function recoverVideos(input: RecoverInput, deps: RecoverDeps = {}): Promise<RecoveryReport> {
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  const report: RecoveryReport = { adopted: [], dropped: [], deferred: [], left: [], removed: { placeholders: 0, partialFiles: 0, intentTemps: 0, markerTemps: 0, probes: 0, partTemps: 0 }, skipped: [] };
  const skip = (what: string, error: unknown): void => {
    report.skipped.push({ what, code: codeOf(error) });
    log(`recovery: ${what} skipped (${codeOf(error)})`);
  };
  const root = await usableRoot(fs, input.exportRoot);

  // ---- 1. the intents of every avatar (before any sweep: a partial copy is judged against its surviving temp)
  for (const avatar of input.library.listAvatars()) {
    const paths = videoPaths(input.library.root, avatar.id);
    let names: Array<{ name: string; isFile: boolean }>;
    try {
      names = (await readdir(paths.pendingDir, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile() }));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) skip("pending folder", error);
      continue;
    }
    for (const { name, isFile } of names.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const relative = `avatars/${avatar.id}/videos/.pending/${name}`;
      if (!isFile) {
        report.left.push({ file: relative, reason: "foreign" });
        continue;
      }
      if (isTempName(name)) {
        // The remains of an intent whose write never finished: ours by shape, in our own folder.
        try {
          await fs.unlink(join(paths.pendingDir, name));
          report.removed.intentTemps++;
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) skip("intent temp", error);
        }
        continue;
      }
      const match = INTENT_NAME.exec(name);
      if (match?.[1] === undefined) {
        report.left.push({ file: relative, reason: "foreign" });
        continue;
      }
      try {
        await settleIntent(match[1], avatar.id, relative);
      } catch (error) {
        skip("intent", error);
      }
    }
  }

  async function settleIntent(videoId: string, avatarId: string, relative: string): Promise<void> {
    const paths = videoPaths(input.library.root, avatarId);
    const intentPath = paths.intent(videoId);
    const info = await fs.lstat(intentPath);
    if (info.size > MAX_INTENT_BYTES || !info.isFile) return void report.left.push({ file: relative, reason: "unreadable" });
    let value: unknown;
    try {
      value = JSON.parse(await readFile(intentPath, "utf8"));
    } catch {
      return void report.left.push({ file: relative, reason: "unreadable" });
    }
    if (isFromNewerVersion(value, VIDEO_RECORD_SCHEMA_VERSION)) return void report.left.push({ file: relative, reason: "too-new" });
    const parsed = VideoRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== videoId || parsed.data.avatarId !== avatarId) return void report.left.push({ file: relative, reason: "unreadable" });
    const record = parsed.data;

    const drop = async (reason: DropReason): Promise<void> => {
      await fs.unlink(intentPath);
      await fs.fsyncDir(paths.pendingDir).catch((error: unknown) => skip("pending folder flush", error));
      report.dropped.push({ videoId, reason });
      log(`recovery: dropped the intent of ${videoId} (${reason})`);
    };

    // A record with this id already stands (a rename that was not flushed): it wins.
    if ((await lstatOrNull(fs, paths.record(videoId))) !== null) return drop("record-exists");
    if (root === null) return void report.deferred.push({ videoId, reason: "export-unavailable" });
    if (record.file.rootId !== root.ref.rootId) return void report.deferred.push({ videoId, reason: "other-root" });

    const [folderName, fileName] = record.file.relPath.split("/");
    if (folderName === undefined || fileName === undefined) return drop("no-file");
    const folder = join(root.ref.root, folderName);
    const file = join(folder, fileName);

    const folderFacts = await lstatOrNull(fs, folder);
    if (folderFacts === null) return drop("no-file");
    if (folderFacts.isSymbolicLink || !folderFacts.isDirectory) return drop("not-a-folder");
    const realFolder = await fs.realpath(folder);
    if (placeOf(nodePath, dirname(realFolder), root.ref.caseInsensitive) !== placeOf(nodePath, root.real, root.ref.caseInsensitive)) return drop("outside-root");

    const facts = await lstatOrNull(fs, file);
    if (facts === null) return drop("no-file");
    if (facts.isSymbolicLink || !facts.isFile || facts.nlink !== 1) return drop("not-a-file");

    if (facts.size === 0) {
      // Our placeholder, never filled: file first, then the intent, so every step is a state this recovery settles.
      await fs.unlink(file);
      report.removed.placeholders++;
      return drop("empty-placeholder");
    }

    if (facts.size === record.file.bytes && (await hashFile(file)) === record.file.sha256) {
      await commitIntent(fs, input.library.root, avatarId, videoId);
      input.library.addVideoRecordToIndex(avatarId, { videoId, photoIds: scenePhotoIds(record.spec.clips) });
      report.adopted.push(videoId);
      log(`recovery: adopted ${videoId}`);
      return;
    }

    // Neither empty nor the verified file. It is ours to remove only if it is provably the start of our own EXDEV copy:
    // a shorter file that is a prefix of the surviving temp, which itself still is the verified file.
    const temp = join(folder, partNameOf(record.jobId));
    const tempFacts = await lstatOrNull(fs, temp);
    const isOurPartialCopy =
      facts.size < record.file.bytes &&
      tempFacts !== null &&
      tempFacts.isFile &&
      !tempFacts.isSymbolicLink &&
      tempFacts.size === record.file.bytes &&
      (await hashFile(temp)) === record.file.sha256 &&
      (await isPrefixOf(file, temp, facts.size));
    if (isOurPartialCopy) {
      await fs.unlink(file);
      report.removed.partialFiles++;
      return drop("partial-copy");
    }
    return drop("mismatch");
  }

  if (root === null) return report;

  // ---- 2. empty placeholders no intent names (a crash between the claim and the intent)
  const livePlaceholders = input.livePlaceholders ?? new Set<string>();
  try {
    for (const folderEntry of await readdir(root.ref.root, { withFileTypes: true })) {
      // Only a real folder with a SafeName: never a symlink (Dirent does not follow), never a folder of the owner's own naming.
      if (!folderEntry.isDirectory() || !isSafeName(folderEntry.name)) continue;
      const folder = join(root.ref.root, folderEntry.name);
      let files: string[];
      try {
        files = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && PLACEHOLDER_NAME.test(e.name)).map((e) => e.name);
      } catch (error) {
        skip("export subfolder", error);
        continue;
      }
      for (const name of files) {
        const path = join(folder, name);
        if (livePlaceholders.has(nodePath.resolve(path))) continue;
        try {
          const facts = await lstatOrNull(fs, path);
          // A 0-byte MP4 is never a real video; anything with content is the owner's.
          if (facts !== null && facts.isFile && !facts.isSymbolicLink && facts.size === 0 && facts.nlink === 1) {
            await fs.unlink(path);
            report.removed.placeholders++;
          }
        } catch (error) {
          skip("placeholder", error);
        }
      }
    }
  } catch (error) {
    skip("export folder", error);
  }

  // ---- 3. render temps (the runner's own `.studio-part-*`), except live jobs'
  const parts = await sweepPartFiles(nodePath.resolve(root.ref.root), { except: input.liveTemps ?? new Set<string>() });
  report.removed.partTemps += parts.removed.length;
  for (const skipped of parts.skipped) report.skipped.push({ what: "render temp", code: skipped.code });

  // ---- 4. Studio's own scratch in the root: marker temps (healing a marker they are linked to) and empty probes
  try {
    const marker = await lstatOrNull(fs, join(root.ref.root, EXPORT_MARKER_FILE));
    for (const entry of await readdir(root.ref.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(root.ref.root, entry.name);
      try {
        if (MARKER_TEMP_NAME.test(entry.name)) {
          const facts = await lstatOrNull(fs, path);
          if (facts === null || !facts.isFile) continue;
          const linkedToMarker = marker !== null && marker.isFile && marker.ino === facts.ino && marker.dev === facts.dev;
          // Linked to the marker: an interrupted publish (heal the marker's link count). Alone: a publish that never linked.
          // Linked to something else: not ours.
          if (linkedToMarker || facts.nlink === 1) {
            await fs.unlink(path);
            report.removed.markerTemps++;
          }
        } else if (PROBE_NAME.test(entry.name)) {
          const facts = await lstatOrNull(fs, path);
          if (facts !== null && facts.isFile && facts.size === 0) {
            await fs.unlink(path);
            report.removed.probes++;
          }
        }
      } catch (error) {
        skip("root scratch file", error);
      }
    }
  } catch (error) {
    skip("export root", error);
  }
  return report;
}

