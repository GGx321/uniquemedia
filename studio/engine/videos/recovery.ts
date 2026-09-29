import { readdir, readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { dirname, join } from "node:path";
import { isSafeName } from "../../shared/engine";
import { placeOf } from "../exportName";
import { EXPORT_MARKER_FILE } from "../exportRoot";
import { hasErrorCode, isTempName } from "../library/durableFs";
import { isFromNewerVersion, VIDEO_RECORD_SCHEMA_VERSION } from "../library/layout";
import type { Library } from "../library";
import { sweepPartFiles } from "../renderQueue/sweep";
import { NODE_COMMIT_FS, type CommitFs, type FileFacts } from "./commitFs";
import { hashFile } from "./fileBytes";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { commitIntent } from "./intents";
import type { LiveCommits } from "./live";
import { scenePhotoIds, videoPaths, VideoRecordSchema, type VideoRecord } from "./record";
import { readRootId } from "./rootMarker";
import { withRootLock } from "./rootLock";

// Settling the video commit's crash windows when a library is opened (Stage 3
// plan, "Commit" row and invariant 23). The commit leaves the disk in one of a
// small set of states (see commit.ts); each has one answer here:
//
//   .studio-part-<jobId>.mp4 alone ............ swept
//   an empty placeholder, no intent ........... deleted (a 0-byte MP4 is never a real video)
//   an intent, its file still 0 bytes ......... intent and placeholder dropped
//   an intent, its file = size + sha256 ....... ADOPTED: the intent is linked to the record and the
//                                               used index is told
//   an intent and a record with the same id ... the intent dropped, the record stands
//   any other intent .......................... dropped; the file, if any, is left as it is
//
// EXCLUSION. Recovery holds the export root's lock (rootLock.ts) for its whole run, the same
// lock a commit holds from its name claim to its record, so it never sees a live commit
// half done. A job that is live (`live`) has its intent deferred, and its temp and placeholder
// kept, whatever the lock says.
//
// A ROOT IS JUDGED BY ITS MARKER: it is usable only if `.studio-export.json` is there and holds the
// id the caller named. An empty folder at the same path (an unplugged drive's mount point) defers the
// intents; it must never read as "the files are gone".
//
// HANDS OFF: nothing is deleted that no intent or record of ours names, except `.studio-part-*`
// temps, 0-byte placeholders of our name pattern in a real `<SafeName>/` folder, and Studio's own
// scratch in the root (`.studio-export.json.tmp-*`, 0-byte `.studio-probe-*` of our two shapes).
// A symlink is never followed and never removed, and a folder is checked again (identity and real
// path) right before anything in it is removed.
//
// Nothing here throws for a disk problem: it is skipped and reported, and the library still opens.
// Every step is idempotent, so a crash inside recovery is settled by the next run.

export interface ExportRootRef {
  /** The export root as the settings name it. */
  readonly root: string;
  /** The marker's id, from the last successful check. */
  readonly rootId: string;
  readonly caseInsensitive: boolean;
}

export interface RecoverInput {
  readonly library: Pick<Library, "root" | "listAvatars"> & IndexPort;
  /** The current export root, or null when the last check refused it (its intents are then kept). */
  readonly exportRoot: ExportRootRef | null;
  /** The renders running now (`CommitTracker`). */
  readonly live?: LiveCommits;
}

export interface RecoverDeps {
  readonly fs?: CommitFs;
  /** Ids, counts and codes only; never a path or a file value. */
  readonly log?: (line: string) => void;
}

export type DropReason = "empty-placeholder" | "mismatch" | "no-file" | "not-a-file" | "not-a-folder" | "outside-root" | "record-exists" | "file-claimed";

export interface RecoveryReport {
  /** Video ids whose intent was promoted to a record. */
  readonly adopted: string[];
  readonly dropped: Array<{ videoId: string; reason: DropReason }>;
  /** Intents kept: their file cannot be judged now (another root, no usable root) or their job is running. */
  readonly deferred: Array<{ videoId: string; reason: "other-root" | "export-unavailable" | "live" }>;
  /** Files in `.pending/` recovery cannot settle, relative to the library. */
  readonly left: Array<{ file: string; reason: "unreadable" | "too-new" | "foreign" }>;
  readonly removed: { placeholders: number; intentTemps: number; markerTemps: number; probes: number; partTemps: number };
  /** Steps a disk error stopped; they are retried at the next open. */
  readonly skipped: Array<{ what: string; code: string }>;
}

const INTENT_NAME = /^([a-z0-9-]{8,64})\.json$/;
const PLACEHOLDER_NAME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_[a-z][a-z0-9]{0,15}_\d{3,6}\.mp4$/;
const MARKER_TEMP_NAME = /^\.studio-export\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Our two probe shapes: the case probe's `case-<id>z`, and the write probe's id (an `Id` or a uuid). */
const PROBE_NAME = /^\.studio-probe-(?:case-[a-z0-9]+z|[a-z0-9-]{8,64})$/;
const MAX_INTENT_BYTES = 1024 * 1024;

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

const sameInode = (a: FileFacts, b: FileFacts): boolean => a.dev === b.dev && a.ino === b.ino;

interface UsableRoot {
  readonly ref: ExportRootRef;
  readonly real: string;
}

/** The root as a real folder whose marker holds the expected id, or null: "cannot judge", never "nothing there". */
async function usableRoot(fs: CommitFs, ref: ExportRootRef | null, log: (line: string) => void): Promise<UsableRoot | null> {
  if (ref === null) return null;
  try {
    const real = await fs.realpath(ref.root);
    if (!(await fs.lstat(real)).isDirectory) return null;
    let marker = await readRootId(ref.root);
    // A marker with a second link is an interrupted publish when its own `.tmp-*` sibling is on the same inode: the sweep heals it below.
    if (marker.rootId === null && marker.code === "EMLINK" && (await hasPublishSibling(fs, ref.root))) marker = await readRootId(ref.root, { allowLinked: true });
    if (marker.rootId === null) {
      log(`recovery: the export folder has no valid marker (${marker.code}); its intents are kept`);
      return null;
    }
    if (marker.rootId !== ref.rootId) {
      log("recovery: the export folder's marker holds another id; its intents are kept");
      return null;
    }
    return { ref, real };
  } catch (error) {
    log(`recovery: the export folder could not be checked (${codeOf(error)}); its intents are kept`);
    return null;
  }
}

/** Whether a `.studio-export.json.tmp-*` sits on the marker's own inode: the leftover of a publish that was cut short after its link. */
async function hasPublishSibling(fs: CommitFs, root: string): Promise<boolean> {
  const marker = await lstatOrNull(fs, join(root, EXPORT_MARKER_FILE));
  if (marker === null || !marker.isFile) return false;
  for (const entry of await fs.readdir(root)) {
    if (!entry.isFile || !MARKER_TEMP_NAME.test(entry.name)) continue;
    const facts = await lstatOrNull(fs, join(root, entry.name));
    if (facts !== null && sameInode(marker, facts)) return true;
  }
  return false;
}

/** Every record of the library that names `(rootId, relPath)`, other than `exceptVideoId`: a file must belong to one record. */
async function recordNamingFile(libraryRoot: string, avatarIds: readonly string[], rootId: string, relPath: string, exceptVideoId: string): Promise<boolean> {
  for (const avatarId of avatarIds) {
    const dir = videoPaths(libraryRoot, avatarId).videosDir;
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && INTENT_NAME.test(e.name)).map((e) => e.name);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    for (const name of names) {
      if (name === `${exceptVideoId}.json`) continue;
      try {
        const parsed = VideoRecordSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
        if (parsed.success && parsed.data.file.rootId === rootId && parsed.data.file.relPath === relPath) return true;
      } catch (error) {
        if (!(error instanceof SyntaxError) && !hasErrorCode(error, "ENOENT")) throw error;
      }
    }
  }
  return false;
}

export async function recoverVideos(input: RecoverInput, deps: RecoverDeps = {}): Promise<RecoveryReport> {
  const fs = deps.fs ?? NODE_COMMIT_FS;
  const log = deps.log ?? (() => undefined);
  const report: RecoveryReport = { adopted: [], dropped: [], deferred: [], left: [], removed: { placeholders: 0, intentTemps: 0, markerTemps: 0, probes: 0, partTemps: 0 }, skipped: [] };
  const skip = (what: string, error: unknown): void => {
    report.skipped.push({ what, code: codeOf(error) });
    log(`recovery: ${what} skipped (${codeOf(error)})`);
  };
  const root = await usableRoot(fs, input.exportRoot, log);
  const live = input.live;

  async function settleIntent(videoId: string, avatarId: string, relative: string, avatarIds: readonly string[]): Promise<void> {
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
    const record: VideoRecord = parsed.data;

    const drop = async (reason: DropReason): Promise<void> => {
      await fs.unlink(intentPath);
      await fs.fsyncDir(paths.pendingDir).catch((error: unknown) => skip("pending folder flush", error));
      report.dropped.push({ videoId, reason });
      log(`recovery: dropped the intent of ${videoId} (${reason})`);
    };

    // A job that is running owns its intent.
    if (live?.hasJob(record.jobId) === true) return void report.deferred.push({ videoId, reason: "live" });
    // A record with this id already stands (the commit linked it, or an earlier recovery did): it wins.
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
    if (facts.isSymbolicLink || !facts.isFile || facts.nlink > 1) return drop("not-a-file");

    if (facts.size === 0) {
      // Our placeholder, never filled: file first, then the intent, so every step is a state this recovery settles.
      await fs.unlink(file);
      report.removed.placeholders++;
      return drop("empty-placeholder");
    }

    // Adoption needs the file to be the verified one, the very file this intent stored (its mtime survives a rename),
    // and to belong to no other record: two records must never name one file.
    const isVerifiedFile = facts.size === record.file.bytes && (await hashFile(file)) === record.file.sha256;
    if (!isVerifiedFile) return drop("mismatch");
    if (record.file.mtimeMs !== undefined && record.file.mtimeMs !== Math.floor(facts.mtimeMs)) return drop("mismatch");
    if (await recordNamingFile(input.library.root, avatarIds, record.file.rootId, record.file.relPath, videoId)) return drop("file-claimed");

    try {
      await commitIntent(fs, input.library.root, avatarId, videoId, { log });
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) return drop("record-exists");
      // The link may have happened even though an error was reported: judge by the disk.
      if ((await lstatOrNull(fs, paths.record(videoId))) === null) throw error;
      log(`recovery: the record of ${videoId} exists although its link reported ${codeOf(error)}`);
    }
    // The record is on disk: whatever else went wrong, the index must learn of it (reload, then flag).
    await indexCommittedRecord(input.library, record, log);
    report.adopted.push(videoId);
    log(`recovery: adopted ${videoId}`);
  }

  async function settleIntents(): Promise<void> {
    const avatars = input.library.listAvatars();
    const avatarIds = avatars.map((a) => a.id);
    for (const avatar of avatars) {
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
          await settleIntent(match[1], avatar.id, relative, avatarIds);
        } catch (error) {
          skip("intent", error);
        }
      }
    }
  }

  /** Empty placeholders no intent names, in real `<SafeName>/` folders only, each checked again right before it goes. */
  async function sweepPlaceholders(ready: UsableRoot): Promise<void> {
    let rootEntries;
    try {
      rootEntries = await fs.readdir(ready.ref.root);
    } catch (error) {
      return skip("export folder", error);
    }
    for (const folderEntry of rootEntries) {
      // A real folder with a SafeName: never a symlink (the entry says so without following), never a folder of the owner's own naming.
      if (!folderEntry.isDirectory || folderEntry.isSymbolicLink || !isSafeName(folderEntry.name)) continue;
      const folder = join(ready.ref.root, folderEntry.name);
      try {
        const before = await lstatOrNull(fs, folder);
        if (before === null || before.isSymbolicLink || !before.isDirectory) continue;
        const files = (await fs.readdir(folder)).filter((e) => e.isFile && !e.isSymbolicLink && PLACEHOLDER_NAME.test(e.name)).map((e) => e.name);
        const after = await lstatOrNull(fs, folder);
        if (after === null || !after.isDirectory || after.isSymbolicLink || !sameInode(before, after)) {
          log("recovery: an export subfolder changed while it was listed; it is skipped");
          continue;
        }
        for (const name of files) {
          const path = join(folder, name);
          if (live?.hasPlaceholder(path) === true) continue;
          const facts = await lstatOrNull(fs, path);
          // A 0-byte MP4 is never a real video; anything with content is the owner's.
          if (facts === null || !facts.isFile || facts.isSymbolicLink || facts.size !== 0 || facts.nlink > 1) continue;
          // The folder is still the real folder directly under the root, right before the unlink.
          const realFolder = await fs.realpath(folder);
          const inside = placeOf(nodePath, dirname(realFolder), ready.ref.caseInsensitive) === placeOf(nodePath, ready.real, ready.ref.caseInsensitive);
          if (!inside || placeOf(nodePath, nodePath.basename(realFolder), ready.ref.caseInsensitive) !== placeOf(nodePath, folderEntry.name, ready.ref.caseInsensitive)) {
            log("recovery: an export subfolder no longer resolves inside the export root; it is skipped");
            break;
          }
          await fs.unlink(path);
          report.removed.placeholders++;
        }
      } catch (error) {
        skip("export subfolder", error);
      }
    }
  }

  /** Studio's own scratch in the root: marker temps (healing a marker they are linked to) and empty probes of our shapes. */
  async function sweepRootScratch(ready: UsableRoot): Promise<void> {
    try {
      const marker = await lstatOrNull(fs, join(ready.ref.root, EXPORT_MARKER_FILE));
      for (const entry of await fs.readdir(ready.ref.root)) {
        if (!entry.isFile || entry.isSymbolicLink) continue;
        const path = join(ready.ref.root, entry.name);
        try {
          if (MARKER_TEMP_NAME.test(entry.name)) {
            const facts = await lstatOrNull(fs, path);
            if (facts === null || !facts.isFile) continue;
            const linkedToMarker = marker !== null && marker.isFile && sameInode(marker, facts);
            // Linked to the marker: an interrupted publish (heal the marker's link count). Alone: a publish that never linked.
            // Linked to something else: not ours.
            if (linkedToMarker || facts.nlink <= 1) {
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
  }

  async function body(): Promise<void> {
    // 1. the intents of every avatar (before any sweep of temps)
    await settleIntents();
    if (root === null) return;
    // 2. empty placeholders no intent names
    await sweepPlaceholders(root);
    // 3. render temps (the runner's own `.studio-part-*`), except live jobs'
    const parts = await sweepPartFiles(nodePath.resolve(root.ref.root), { keep: (path) => live?.hasTemp(path) === true });
    report.removed.partTemps += parts.removed.length;
    for (const skipped of parts.skipped) report.skipped.push({ what: "render temp", code: skipped.code });
    // 4. Studio's own scratch in the root
    await sweepRootScratch(root);
  }

  if (root === null) await body();
  else await withRootLock(fs, root.ref.root, root.ref.caseInsensitive, body);
  return report;
}
