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
import { LockWaitTimeout, withRootLock } from "./rootLock";

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
// scratch in the root (`.studio-export.json.tmp-*`, 0-byte `.studio-probe-*` of our two shapes), the
// last two only once they are older than `SCRATCH_MIN_AGE_MS`: a live export check may own a fresh one.
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
  readonly library: Pick<Library, "root" | "listAvatars" | "holdPendingPhotos" | "releasePendingPhotos"> & IndexPort;
  /** The current export root, or null when the last check refused it (its intents are then kept). */
  readonly exportRoot: ExportRootRef | null;
  /** The renders running now (`CommitTracker`). */
  readonly live?: LiveCommits;
  /**
   * Ends the run early: checked between steps, so a library that is no longer the live one (a switch) stops holding the
   * export root's lock. What was done stays done, and every step is idempotent, so the next open settles the rest.
   */
  readonly signal?: AbortSignal;
  /**
   * TARGETED settle: only the commit intents of these video ids, and none of the sweeps (placeholders, render temps, the
   * root's scratch). Used after a render failed in this session, to settle a leftover intent under the root lock at once
   * instead of leaving its photos free until the next open.
   */
  readonly only?: { readonly videoIds: readonly string[] };
}

export interface RecoverDeps {
  readonly fs?: CommitFs;
  /** How long to wait for the export root's lock (a commit holds it from its claim to its record) before deferring the root as `root-busy`. 30 s when absent. */
  readonly lockWaitMs?: number;
  /**
   * How long ONE disk call may take (the library's or the export folder's) before the whole run is given up: a pulled USB
   * drive must not hold the export root's lock for ever. 30 s when absent.
   */
  readonly ioTimeoutMs?: number;
  /** The age below which the root's probe and marker-temp files are left alone (a live export check may own them); `SCRATCH_MIN_AGE_MS` when absent. */
  readonly scratchMinAgeMs?: number;
  /** How the LIBRARY's pending folders and intents are read (before the export root's lock is taken); the real disk unless a test plays a library that does not answer. */
  readonly libraryFs?: LibraryReadFs;
  /** Test seams. `locked` runs inside the lock, before anything is settled. */
  readonly hooks?: { locked?: () => void | Promise<void> };
  /** Ids, counts and codes only; never a path or a file value. */
  readonly log?: (line: string) => void;
}

export type DropReason = "empty-placeholder" | "mismatch" | "no-file" | "not-a-file" | "not-a-folder" | "outside-root" | "record-exists" | "file-claimed";

export interface RecoveryReport {
  /** Video ids whose intent was promoted to a record. */
  readonly adopted: string[];
  readonly dropped: Array<{ videoId: string; reason: DropReason }>;
  /** Intents kept: their file cannot be judged now (another root, no usable root) or their job is running. */
  readonly deferred: Array<{ videoId: string; reason: "other-root" | "export-unavailable" | "live" | "root-busy" | "file-shared" }>;
  /** Files in `.pending/` recovery cannot settle, relative to the library. */
  readonly left: Array<{ file: string; reason: "unreadable" | "too-new" | "foreign" }>;
  readonly removed: { placeholders: number; intentTemps: number; markerTemps: number; probes: number; partTemps: number };
  /** Steps a disk error stopped; they are retried at the next open. */
  readonly skipped: Array<{ what: string; code: string }>;
}

/** The two reads recovery makes of the library itself. */
export interface LibraryReadFs {
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean }>>;
  readFile(path: string): Promise<string>;
}

const NODE_LIBRARY_READ_FS: LibraryReadFs = {
  readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile() })),
  readFile: (path) => readFile(path, "utf8"),
};

const INTENT_NAME = /^([a-z0-9-]{8,64})\.json$/;
const PLACEHOLDER_NAME = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_[a-z][a-z0-9]{0,15}_\d{3,6}\.mp4$/;
const MARKER_TEMP_NAME = /^\.studio-export\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Our two probe shapes: the case probe's `case-<id>z`, and the write probe's id (an `Id` or a uuid). */
const PROBE_NAME = /^\.studio-probe-(?:case-[a-z0-9]+z|[a-z0-9-]{8,64})$/;
const MAX_INTENT_BYTES = 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS = 30_000;

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

/**
 * Whether another record of the library (and, with `includeIntents`, another commit intent) names `(rootId, relPath)` AND the same bytes
 * (`sha256`), other than `exceptVideoId`: a file must belong to one video. A record that names the path with other bytes does not own
 * the file that stands there (its own file was deleted, and a later one took the name): it must not make this one's verified file
 * look claimed, or the video would lose its record while its file lives on.
 */
async function otherNamesFile(lib: LibraryReadFs, libraryRoot: string, avatarIds: readonly string[], rootId: string, relPath: string, sha256: string, caseInsensitive: boolean, exceptVideoId: string, includeIntents: boolean): Promise<boolean> {
  for (const avatarId of avatarIds) {
    const paths = videoPaths(libraryRoot, avatarId);
    for (const dir of includeIntents ? [paths.videosDir, paths.pendingDir] : [paths.videosDir]) {
      let names: string[];
      try {
        names = (await lib.readdir(dir)).filter((e) => e.isFile && INTENT_NAME.test(e.name)).map((e) => e.name);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) continue;
        throw error;
      }
      for (const name of names) {
        if (name === `${exceptVideoId}.json`) continue;
        try {
          const parsed = VideoRecordSchema.safeParse(JSON.parse(await lib.readFile(join(dir, name))));
          if (parsed.success && parsed.data.file.rootId === rootId && (caseInsensitive ? parsed.data.file.relPath.toLowerCase() === relPath.toLowerCase() : parsed.data.file.relPath === relPath) && parsed.data.file.sha256 === sha256) return true;
        } catch (error) {
          if (!(error instanceof SyntaxError) && !hasErrorCode(error, "ENOENT")) throw error;
        }
      }
    }
  }
  return false;
}

/** One file of an avatar's `.pending/` folder, read (or not) BEFORE the export root's lock is taken. */
interface PendingFile {
  readonly avatarId: string;
  readonly name: string;
  readonly relative: string;
  readonly kind: "foreign" | "temp" | "intent";
  /** An intent: what it turned out to be. */
  readonly videoId?: string;
  readonly left?: "unreadable" | "too-new";
  readonly record?: VideoRecord;
}

const IO_TIMEOUT_MS = 30_000;
/** A probe or marker temp younger than this is not a crash's leftover (see `isFresh`). */
export const SCRATCH_MIN_AGE_MS = 60_000;

export async function recoverVideos(input: RecoverInput, deps: RecoverDeps = {}): Promise<RecoveryReport> {
  const log = deps.log ?? (() => undefined);
  const report: RecoveryReport = { adopted: [], dropped: [], deferred: [], left: [], removed: { placeholders: 0, intentTemps: 0, markerTemps: 0, probes: 0, partTemps: 0 }, skipped: [] };
  const skip = (what: string, error: unknown): void => {
    report.skipped.push({ what, code: codeOf(error) });
    log(`recovery: ${what} skipped (${codeOf(error)})`);
  };

  // A run that is told to stop, or whose disk stops answering, ends: the export root's lock is held across these calls, and
  // a pulled drive would otherwise hold it (and every commit that needs it) for ever. The FIRST call that times out ends the
  // whole run (a dead drive is not asked again and again); what was done stays done and every step is idempotent.
  const stopper = new AbortController();
  const signal = input.signal === undefined ? stopper.signal : AbortSignal.any([input.signal, stopper.signal]);
  const ioMs = deps.ioTimeoutMs ?? IO_TIMEOUT_MS;
  const io = async <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const out = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeout = Object.assign(new Error("a disk call did not answer"), { code: "ETIMEDOUT" });
        stopper.abort(timeout);
        reject(timeout);
      }, ioMs);
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    out.catch(() => undefined);
    try {
      return await Promise.race([work(), out]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };
  const baseFs = deps.fs ?? NODE_COMMIT_FS;
  const fs: CommitFs = {
    lstat: (p) => io(() => baseFs.lstat(p)),
    realpath: (p) => io(() => baseFs.realpath(p)),
    readdir: (p) => io(() => baseFs.readdir(p)),
    mkdir: (p) => io(() => baseFs.mkdir(p)),
    createExclusive: (p) => io(() => baseFs.createExclusive(p)),
    writeNew: (p, text) => io(() => baseFs.writeNew(p, text)),
    fsyncFile: (p) => io(() => baseFs.fsyncFile(p)),
    fsyncDir: (p) => io(() => baseFs.fsyncDir(p)),
    rename: (a, b) => io(() => baseFs.rename(a, b)),
    link: (a, b) => io(() => baseFs.link(a, b)),
    unlink: (p) => io(() => baseFs.unlink(p)),
  };
  const baseLib = deps.libraryFs ?? NODE_LIBRARY_READ_FS;
  const lib: LibraryReadFs = { readdir: (p) => io(() => baseLib.readdir(p)), readFile: (p) => io(() => baseLib.readFile(p)) };
  const only = input.only === undefined ? null : new Set(input.only.videoIds);
  /** The report, once the run is over: a disk call that did not answer is said (a stop asked from outside is not a fault). */
  const finished = (): RecoveryReport => {
    if (stopper.signal.aborted) skip("a disk call did not answer", stopper.signal.reason);
    return report;
  };

  if (signal.aborted) return finished();
  const live = input.live;
  // The library is read FIRST, with no lock held and before the export root is looked at: it reads the library only, and it is what holds the pending intents'
  // photos (`loadPending`). A root that hangs or errors must not end the run before the holds are made, or the photos would look free all session.
  // A library that does not answer ends the run here, having blocked nobody.
  let pending: PendingFile[];
  try {
    pending = await loadPending();
  } catch (error) {
    if (!signal.aborted) skip("library", error);
    return finished();
  }
  if (signal.aborted) return finished();

  let root: UsableRoot | null;
  try {
    root = await io(() => usableRoot(fs, input.exportRoot, log));
  } catch (error) {
    skip("export root", error);
    return finished();
  }
  /** A path under the real root, as the running jobs know it: through the root as the settings spell it. */
  const configured = (path: string): string => (root === null ? path : join(root.ref.root, nodePath.relative(root.real, path)));

  /**
   * The library's pending intents, read and parsed with NO lock held: a library on a drive that has been pulled hangs here,
   * and it must not hang inside the export root's lock. What the lock is then taken for is the export root's files.
   */
  async function loadPending(): Promise<PendingFile[]> {
    const loaded: PendingFile[] = [];
    for (const avatar of input.library.listAvatars()) {
      signal.throwIfAborted();
      const paths = videoPaths(input.library.root, avatar.id);
      let names: Array<{ name: string; isFile: boolean }>;
      try {
        names = await lib.readdir(paths.pendingDir);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) skip("pending folder", error);
        continue;
      }
      for (const { name, isFile } of names.sort((x, y) => (x.name < y.name ? -1 : 1))) {
        const relative = `avatars/${avatar.id}/videos/.pending/${name}`;
        if (!isFile) {
          if (only === null) loaded.push({ avatarId: avatar.id, name, relative, kind: "foreign" });
          continue;
        }
        if (isTempName(name)) {
          if (only === null) loaded.push({ avatarId: avatar.id, name, relative, kind: "temp" });
          continue;
        }
        const match = INTENT_NAME.exec(name);
        if (match?.[1] === undefined) {
          if (only === null) loaded.push({ avatarId: avatar.id, name, relative, kind: "foreign" });
          continue;
        }
        const videoId = match[1];
        if (only !== null && !only.has(videoId)) continue;
        const base = { avatarId: avatar.id, name, relative, kind: "intent" as const, videoId };
        try {
          const info = await fs.lstat(paths.intent(videoId));
          if (info.size > MAX_INTENT_BYTES || !info.isFile) {
            loaded.push({ ...base, left: "unreadable" });
            continue;
          }
          let value: unknown;
          try {
            value = JSON.parse(await lib.readFile(paths.intent(videoId)));
          } catch (error) {
            if (hasErrorCode(error, "ETIMEDOUT") || signal.aborted) throw error;
            loaded.push({ ...base, left: "unreadable" });
            continue;
          }
          if (isFromNewerVersion(value, VIDEO_RECORD_SCHEMA_VERSION)) {
            loaded.push({ ...base, left: "too-new" });
            continue;
          }
          const parsed = VideoRecordSchema.safeParse(value);
          if (!parsed.success || parsed.data.id !== videoId || parsed.data.avatarId !== avatar.id) loaded.push({ ...base, left: "unreadable" });
          else {
            loaded.push({ ...base, record: parsed.data });
            // Until this intent is adopted or dropped, its photos are held: its file may be adopted at any time, and a run that defers it
            // (the export folder absent, another root, a busy lock) must not leave them looking free all session. A job that is running
            // owns its intent, and the queue holds its photos: a hold here would outlive a rollback.
            if (live?.hasJob(parsed.data.jobId) !== true) input.library.holdPendingPhotos(avatar.id, videoId, scenePhotoIds(parsed.data.spec.clips));
          }
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) continue; // consumed while we looked: nothing to settle
          if (signal.aborted) throw error;
          skip("intent", error);
        }
      }
    }
    return loaded;
  }

  async function settleIntent(pending: PendingFile, avatarIds: readonly string[]): Promise<void> {
    const { avatarId, relative } = pending;
    const videoId = pending.videoId ?? "";
    const paths = videoPaths(input.library.root, avatarId);
    const intentPath = paths.intent(videoId);
    if (pending.left !== undefined) return void report.left.push({ file: relative, reason: pending.left });
    const record = pending.record;
    if (record === undefined) return;
    // Read before the lock: it may be gone by now (a commit that finished linked it). Nothing to settle then.
    try {
      await fs.lstat(intentPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }

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
    // Everything below works on the root's REAL path, resolved once: a root path re-pointed meanwhile changes nothing here.
    const folder = join(root.real, folderName);
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

    // Adoption needs the file to be the verified one (size and sha256) and to belong to no other record: two records must
    // never name one file. Its stored mtime (which survives a rename) settles a tie between intents, and nothing more.
    const isVerifiedFile = facts.size === record.file.bytes && (await io(() => hashFile(file))) === record.file.sha256;
    if (!isVerifiedFile) return drop("mismatch");
    if (await otherNamesFile(lib, input.library.root, avatarIds, record.file.rootId, record.file.relPath, record.file.sha256, root.ref.caseInsensitive, videoId, false)) return drop("file-claimed");
    // Right bytes, other mtime (DST on FAT32, a copy round trip): still ours, unless another intent names the same file and this one cannot show it is the one.
    if (record.file.mtimeMs !== undefined && record.file.mtimeMs !== facts.mtimeMs && (await otherNamesFile(lib, input.library.root, avatarIds, record.file.rootId, record.file.relPath, record.file.sha256, root.ref.caseInsensitive, videoId, true))) {
      // Two intents, one file, and neither can show it is the one: both wait (whichever is looked at first), nothing is dropped or adopted.
      return void report.deferred.push({ videoId, reason: "file-shared" });
    }

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

  async function settleIntents(pending: readonly PendingFile[]): Promise<void> {
    const avatarIds = input.library.listAvatars().map((a) => a.id);
    for (const file of pending) {
      if (signal.aborted) return;
      const paths = videoPaths(input.library.root, file.avatarId);
      if (file.kind === "foreign") {
        report.left.push({ file: file.relative, reason: "foreign" });
        continue;
      }
      if (file.kind === "temp") {
        // The remains of an intent whose write never finished: ours by shape, in our own folder.
        try {
          await fs.unlink(join(paths.pendingDir, file.name));
          report.removed.intentTemps++;
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) skip("intent temp", error);
        }
        continue;
      }
      try {
        const deferredBefore = report.deferred.length;
        await settleIntent(file, avatarIds);
        // Adopted (its record makes the photos used), dropped, gone, or a live job's: the hold ends. Deferred for anything else, it stays;
        // a settle that failed stays held too (the catch below), since nothing is known about the intent.
        const deferred = report.deferred.slice(deferredBefore).find((entry) => entry.videoId === file.videoId);
        if (file.videoId !== undefined && (deferred === undefined || deferred.reason === "live")) input.library.releasePendingPhotos(file.videoId);
      } catch (error) {
        if (signal.aborted) return;
        skip("intent", error);
      }
    }
  }

  /** Empty placeholders no intent names, in real `<SafeName>/` folders only, each checked again right before it goes. */
  async function sweepPlaceholders(ready: UsableRoot): Promise<void> {
    let rootEntries;
    try {
      rootEntries = await fs.readdir(ready.real);
    } catch (error) {
      return skip("export folder", error);
    }
    for (const folderEntry of rootEntries) {
      // A real folder with a SafeName: never a symlink (the entry says so without following), never a folder of the owner's own naming.
      if (!folderEntry.isDirectory || folderEntry.isSymbolicLink || !isSafeName(folderEntry.name)) continue;
      const folder = join(ready.real, folderEntry.name);
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
          if (live?.hasPlaceholder(configured(path)) === true) continue;
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

  /**
   * Scratch made moments ago may be LIVE: an export check's probe (created and removed within a call) or a marker's publish
   * temp. Recovery runs in the background while checks run, so it cannot tell a live one from a leftover by its name. A
   * leftover of a crash is only as old as the time the restart took: after an automatic restart (`RESTART_DELAY_MS`, 1 s)
   * that is about a second, so such leftovers are NOT swept by that open and wait for the next library open (they are
   * empty or tiny, and harmless). `scratchMinAgeMs: 0` turns the gate off.
   */
  const scratchMinAgeMs = deps.scratchMinAgeMs ?? SCRATCH_MIN_AGE_MS;
  const isFresh = (facts: FileFacts): boolean => scratchMinAgeMs > 0 && Date.now() - facts.mtimeMs < scratchMinAgeMs;

  /** Studio's own scratch in the root: marker temps (healing a marker they are linked to) and empty probes of our shapes. */
  async function sweepRootScratch(ready: UsableRoot): Promise<void> {
    try {
      const rootBefore = await fs.lstat(ready.real);
      const marker = await lstatOrNull(fs, join(ready.real, EXPORT_MARKER_FILE));
      const entries = await fs.readdir(ready.real);
      const rootAfter = await fs.lstat(ready.real);
      if (!sameInode(rootBefore, rootAfter)) {
        log("recovery: the export root changed while it was listed; its scratch files are skipped");
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile || entry.isSymbolicLink) continue;
        const path = join(ready.real, entry.name);
        try {
          if (MARKER_TEMP_NAME.test(entry.name)) {
            const facts = await lstatOrNull(fs, path);
            if (facts === null || !facts.isFile || isFresh(facts)) continue;
            const linkedToMarker = marker !== null && marker.isFile && sameInode(marker, facts);
            // Linked to the marker: an interrupted publish (heal the marker's link count). Alone: a publish that never linked.
            // Linked to something else: not ours.
            if (linkedToMarker || facts.nlink <= 1) {
              await fs.unlink(path);
              report.removed.markerTemps++;
            }
          } else if (PROBE_NAME.test(entry.name)) {
            const facts = await lstatOrNull(fs, path);
            if (facts !== null && facts.isFile && facts.size === 0 && !isFresh(facts)) {
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

  /** Every intent of the library kept as deferred, untouched: the root is busy or cannot be locked. */
  async function deferAll(reason: "root-busy" | "export-unavailable"): Promise<void> {
    for (const avatar of input.library.listAvatars()) {
      let names: string[];
      try {
        names = (await lib.readdir(videoPaths(input.library.root, avatar.id).pendingDir)).filter((e) => e.isFile).map((e) => e.name);
      } catch (error) {
        if (signal.aborted) return;
        if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) skip("pending folder", error);
        continue;
      }
      for (const name of names.sort()) {
        const match = INTENT_NAME.exec(name);
        if (match?.[1] !== undefined) report.deferred.push({ videoId: match[1], reason });
      }
    }
  }

  async function body(ready: UsableRoot | null, pending: readonly PendingFile[]): Promise<void> {
    await deps.hooks?.locked?.();
    if (signal.aborted) return;
    // 1. the intents of every avatar (before any sweep of temps)
    await settleIntents(pending);
    // A targeted run settles its intents and nothing else.
    if (ready === null || only !== null || signal.aborted) return;
    // 2. empty placeholders no intent names
    await sweepPlaceholders(ready);
    // 3. render temps (the runner's own `.studio-part-*`), except live jobs'; the real root, each folder and each file checked again
    const insideRoot = async (folder: string): Promise<boolean> => {
      const facts = await lstatOrNull(fs, folder);
      if (facts === null || facts.isSymbolicLink || !facts.isDirectory) return false;
      const realFolder = await fs.realpath(folder);
      return placeOf(nodePath, dirname(realFolder), ready.ref.caseInsensitive) === placeOf(nodePath, ready.real, ready.ref.caseInsensitive);
    };
    // The sweep lists folders with the runtime's own calls: the whole of it is one bounded step.
    const parts = await io(() => sweepPartFiles(ready.real, {
      keep: (path) => live?.hasTemp(configured(path)) === true,
      isRealDirectory: async (folder) => insideRoot(folder).catch(() => false),
      remove: async (path) => {
        if (!(await insideRoot(dirname(path)))) throw Object.assign(new Error("the folder no longer resolves inside the export root"), { code: "ELOOP" });
        await fs.unlink(path).catch((error: unknown) => {
          if (!hasErrorCode(error, "ENOENT")) throw error;
        });
      },
    }));
    report.removed.partTemps += parts.removed.length;
    for (const skipped of parts.skipped) report.skipped.push({ what: "render temp", code: skipped.code });
    // 4. Studio's own scratch in the root
    await sweepRootScratch(ready);
  }

  try {
    if (root === null) {
      await body(null, pending);
      return finished();
    }
    let started = false;
    try {
      await withRootLock(
        fs,
        root.real,
        async () => {
          started = true;
          await body(root, pending);
        },
        { waitMs: deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS },
      );
    } catch (error) {
      if (signal.aborted) return finished();
      if (started) skip("recovery", error);
      else if (error instanceof LockWaitTimeout) {
        log("recovery: the export folder is busy; its intents are kept for the next open");
        await deferAll("root-busy");
      } else {
        skip("export root lock", error);
        await deferAll("export-unavailable");
      }
    }
  } catch (error) {
    if (!signal.aborted) skip("recovery", error);
  }
  return finished();
}
