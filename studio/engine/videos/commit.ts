import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as nodePath from "node:path";
import type { z } from "zod";
import type { EngineError, ExportUnavailableReason, RenderResult } from "../../shared/engine";
import type { MontageShape } from "../../shared/engine/montage";
import { claimExportName, ExportNamesExhaustedError, placeOf, type PreparedFolder } from "../exportName";
import { hasErrorCode } from "../library/durableFs";
import { VIDEO_RECORD_SCHEMA_VERSION } from "../library/layout";
import { RenderFailure } from "../renderQueue/queue";
import { verifyAndHashMp4, type VerifiedFile, type VerifyExpected, type VerifyReasonCode } from "../verify";
import type { CommitFs, FileFacts, FileIdentity } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { parseRecordSpec, partNameOf, videoPaths, VideoRecordSchema, type VideoRecord } from "./record";
import { withRootLock } from "./rootLock";

// The commit of one finished render (Stage 3 plan, "Commit" row, steps 2-6 and
// invariants 23 and 33). The runner leaves `.studio-part-<jobId>.mp4` next to
// where the video will live; this function turns it into a committed video or
// into nothing:
//
//   verify (+ sha256 in the same pass) -> fsync the temp -> claim the name ->
//   intent -> rename the temp over its placeholder -> fsync the folder ->
//   link the intent to the record (the COMMIT POINT) -> remove the intent, fsync.
//
// CANCEL ("done wins", decision (a)): a cancel is honoured up to the moment the
// name is claimed and ignored from then on. Everything after the claim is a
// few renames and fsyncs, while undoing a half-done commit is itself a sequence of
// steps that can be interrupted. The render queue already treats a job whose work
// finished as done even if a cancel arrived meanwhile.
//
// EXCLUSION. From the claim to the record the commit holds the export root's lock
// (rootLock.ts), the same lock the recovery that runs when a library opens holds:
// recovery never sees a live commit's placeholder, intent or renamed file, and never
// misses a placeholder claimed while it was running.
//
// IDENTITY. The name we claimed is a placeholder we made (`createExclusive` reports its
// inode). Before the rename it is still that inode, empty, a plain file with one link; the
// renamed file is the temp's own inode. A rollback removes a name ONLY when it still leads to
// the inode we expect; anything else (an owner's file that took the name meanwhile) is left and
// logged. (Between the last check and the rename there is a window of microseconds that POSIX
// gives no way to close; a file replaced in it is found by the next full `fileState` check.)
//
// FAILURE after the claim rolls back, in an order where every intermediate disk state is one
// the open-time recovery settles: the file first, then the intent, then the temp. A step
// that fails to undo stops the undoing there (an intent whose file could not be removed stays,
// so recovery adopts the file). If the export folder cannot be checked any more the intent
// STAYS too: recovery, which checks it again, decides. After the record is linked nothing is
// ever rolled back: the record is the commit.

export type CommitStep =
  | "verified"
  | "temp-synced"
  | "name-claimed"
  /** The intent's temp file is durable and not yet renamed: mid-write. */
  | "intent-temp-written"
  | "intent-written"
  | "renamed"
  | "dir-synced"
  /** The record exists and the intent has not been removed yet: both are on disk. */
  | "record-linked"
  | "record-committed";

/** The verifier refused the output. `codes` are the reasons; `autoRetryable` is false when the source photos' own text is in it (the same spec fails the same way). */
export class VerifyRefusedError extends RenderFailure {
  readonly codes: readonly VerifyReasonCode[];
  readonly autoRetryable: boolean;

  constructor(codes: readonly VerifyReasonCode[]) {
    super({ code: "RENDER_VERIFY_FAILED", detail: `the output failed verification (${codes.join(", ")})` });
    this.codes = codes;
    this.autoRetryable = !codes.includes("SOURCE_METADATA_STRING");
  }
}

/** The export folder is not where (or what) it was, or a name no longer leads to the file we made. */
class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentError";
  }
}

/** The temp changed after it was verified. */
class TempChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TempChangedError";
  }
}

export interface CommitTarget {
  /** From `prepareExportFolder`: the only way to name a path inside the export root. */
  readonly folder: PreparedFolder;
  /** The export root as the settings name it (`check.root`). */
  readonly root: string;
  /** The root marker's id (`check.rootId`): what the record names the file's place by. */
  readonly rootId: string;
  /** The volume's case folding, from `CaseSensitivityProbe`. */
  readonly caseInsensitive: boolean;
}

export interface CommitInput {
  readonly jobId: string;
  readonly videoId: string;
  readonly avatarId: string;
  /** The kind token of the file name (`photo`, `collage3`, `mix`). */
  readonly videoKind: string;
  /** `YYYY-MM-DD` for the file name. */
  readonly date: string;
  readonly createdAt: string;
  /** The exact frame count the verifier must find. */
  readonly frames: number;
  readonly durationMs: number;
  readonly montageId: string | null;
  readonly music: VideoRecord["music"];
  /** The RESOLVED spec: what was rendered. Kept whole in the record. */
  readonly spec: z.infer<typeof MontageShape>;
  /** From `collectForbiddenStrings`. */
  readonly forbiddenStrings: readonly string[];
}

export interface CommitDeps {
  readonly fs: CommitFs;
  readonly libraryRoot: string;
  /** `verifyAndHashMp4` unless a test plays the verifier. */
  readonly verify?: (path: string, expected: VerifyExpected) => Promise<VerifiedFile>;
  /** A cancel is honoured until the claim (see above). */
  readonly signal?: AbortSignal;
  /** Called after each step completes; a throw there is a crash at that point (test seam). */
  readonly hooks?: { reached?: (step: CommitStep) => void | Promise<void> };
  /** Codes and box paths only: never a value from a file, a forbidden string or a path. */
  readonly log?: (line: string) => void;
  /** The claimed placeholder's path, as soon as it exists (informs the live tracker). */
  readonly onClaimed?: (placeholder: string) => void;
  /** The first number the claim tries; 1 in production (test seam for a full range). */
  readonly claimStartAt?: number;
}

export interface CommittedVideo {
  readonly record: VideoRecord;
  readonly absPath: string;
  readonly result: RenderResult;
}

type Phase = "verify" | "export" | "library" | "internal";

/** An error tagged with the part of the disk it came from, so the mapping can tell a full export volume from a full library. */
class PhaseError extends Error {
  constructor(
    readonly phase: Phase,
    readonly original: unknown,
  ) {
    super("commit step failed");
  }
}

async function inPhase<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new PhaseError(phase, error);
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** What the caller may be told: no path, no file value, just the kind of failure. */
function failureFrom(phase: Phase, error: unknown): RenderFailure {
  if (error instanceof RenderFailure) return error;
  const code = codeOf(error);
  const failure = (engine: EngineError): RenderFailure => new RenderFailure(engine);
  const exportRefusal = (exportReason: ExportUnavailableReason, detail: string): RenderFailure => failure({ code: "EXPORT_UNAVAILABLE", exportReason, detail });
  if (error instanceof ContainmentError) return exportRefusal("not-writable", "the export folder changed while the video was being saved");
  if (error instanceof TempChangedError) return failure({ code: "RENDER_VERIFY_FAILED", detail: "the video file changed after it was checked" });
  if (phase === "library") {
    if (code === "ENOSPC" || code === "EDQUOT") return failure({ code: "INTERNAL", detail: "the library's disk is full: the video's record could not be saved" });
    return failure({ code: "INTERNAL", detail: `the library could not save the video's record (${code ?? "error"})` });
  }
  if (phase === "export") {
    if (code === "ENOSPC" || code === "EDQUOT") return exportRefusal("not-enough-space", "the export folder's disk is full");
    if (code === "ENOENT" || code === "ENOTDIR") return exportRefusal("missing", "the export folder is gone");
    if (code === "EXDEV") return exportRefusal("not-writable", "the export folder spans two volumes");
    return exportRefusal("not-writable", `the export folder could not be written (${code ?? "error"})`);
  }
  if (phase === "verify") return failure({ code: "INTERNAL", detail: `the render output could not be checked (${code ?? "error"})` });
  return failure({ code: "INTERNAL", detail: `the commit failed (${code ?? "error"})` });
}

/** The parts of `lstat` that say whether a file is still the file that was checked. */
const sameFile = (a: FileFacts, b: FileFacts): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
const isIdentity = (facts: FileFacts, identity: FileIdentity): boolean => facts.dev === identity.dev && facts.ino === identity.ino;

export async function commitVideo(target: CommitTarget, input: CommitInput, deps: CommitDeps): Promise<CommittedVideo> {
  const { fs, signal } = deps;
  const { folder } = target;
  const log = deps.log ?? (() => undefined);
  const reached = async (step: CommitStep): Promise<void> => {
    await deps.hooks?.reached?.(step);
  };
  const verify = deps.verify ?? ((path: string, expected: VerifyExpected) => verifyAndHashMp4(path, expected));
  const temp = folder.fileIn(partNameOf(input.jobId));
  const paths = videoPaths(deps.libraryRoot, input.avatarId);

  // What exists on disk, and whose it is, for the rollback.
  let placeholder: { path: string; identity: FileIdentity } | null = null;
  let tempFacts: FileFacts | null = null;
  let placed = false;
  let intentMayExist = false;
  let committed = false;
  let leaveEverything = false;
  let rolledBack = false;

  /** The export folder is still a real folder directly under the root, at its own name. Returns its real path. */
  const checkFolder = async (): Promise<string> => {
    const info = await fs.lstat(folder.path);
    if (info.isSymbolicLink || !info.isDirectory) throw new ContainmentError("the avatar's export folder is not a real folder any more");
    const [realFolder, realRoot] = [await fs.realpath(folder.path), await fs.realpath(target.root)];
    const inside = placeOf(nodePath, dirname(realFolder), target.caseInsensitive) === placeOf(nodePath, realRoot, target.caseInsensitive);
    if (!inside || placeOf(nodePath, basename(realFolder), target.caseInsensitive) !== placeOf(nodePath, folder.name, target.caseInsensitive)) {
      throw new ContainmentError("the avatar's export folder resolves outside the export root");
    }
    return realFolder;
  };

  /** Before the rename: the claimed name is still the empty plain file we made. */
  const checkPlaceholder = async (claimed: { path: string; identity: FileIdentity }): Promise<void> => {
    const info = await fs.lstat(claimed.path);
    if (info.isSymbolicLink || !info.isFile || info.size !== 0 || info.nlink > 1 || !isIdentity(info, claimed.identity)) throw new ContainmentError("the claimed name no longer leads to our placeholder");
  };

  /** After the rename: the name leads to the temp's own file, of the verified size, in the folder we checked. */
  const checkPlaced = async (absPath: string, bytes: number, identity: FileIdentity): Promise<void> => {
    const realFolder = await checkFolder();
    const info = await fs.lstat(absPath);
    if (info.isSymbolicLink || !info.isFile || info.nlink > 1 || info.size !== bytes || !isIdentity(info, identity)) throw new ContainmentError("the saved file is not the file that was written");
    const realFile = await fs.realpath(absPath);
    if (placeOf(nodePath, dirname(realFile), target.caseInsensitive) !== placeOf(nodePath, realFolder, target.caseInsensitive)) throw new ContainmentError("the saved file resolves outside its folder");
  };

  /** Removes `path` only if it is the inode we expect. True when nothing of ours is left there; false when it is ours and would not go. */
  const removeIfOurs = async (what: string, path: string, expected: FileIdentity): Promise<boolean> => {
    let facts: FileFacts;
    try {
      facts = await fs.lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return true;
      log(`commit ${input.jobId}: could not look at the ${what} (${codeOf(error) ?? "error"})`);
      return false;
    }
    if (facts.isSymbolicLink || !facts.isFile || !isIdentity(facts, expected)) {
      log(`commit ${input.jobId}: the ${what}'s name no longer leads to our file; it is left as it is`);
      return true;
    }
    try {
      await fs.unlink(path);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return true;
      log(`commit ${input.jobId}: could not remove the ${what} (${codeOf(error) ?? "error"})`);
      return false;
    }
  };

  const undoIntent = async (): Promise<void> => {
    try {
      await fs.unlink(paths.intent(input.videoId));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) log(`commit ${input.jobId}: could not remove the commit intent (${codeOf(error) ?? "error"})`);
    }
  };

  /** Puts the disk back as it was before this commit, in the order recovery can settle at every step. Never throws. */
  const rollback = async (): Promise<void> => {
    if (rolledBack || committed || leaveEverything) return;
    rolledBack = true;
    let foldersAreOurs = false;
    try {
      await checkFolder();
      foldersAreOurs = true;
    } catch (error) {
      log(`commit ${input.jobId}: the export folder could not be checked for the rollback (${codeOf(error) ?? "containment"}); its files are left as they are`);
    }
    let fileGone = true;
    if (foldersAreOurs && placeholder !== null) fileGone = await removeIfOurs("unfinished video file", placeholder.path, placed && tempFacts !== null ? tempFacts : placeholder.identity);
    // The intent goes only once the file is gone, and only if the folder could be judged: an intent whose file
    // could not be removed, or whose folder could not be checked, stays for recovery, which decides.
    const folderJudged = foldersAreOurs || placeholder === null;
    if (fileGone && folderJudged && intentMayExist) await undoIntent();
    if (foldersAreOurs && tempFacts !== null && !placed) await removeIfOurs("temp file", temp, tempFacts);
    // The unlinks are made durable, so a crash right after the rollback does not bring the leftovers back.
    if (foldersAreOurs) await fs.fsyncDir(folder.path).catch((error: unknown) => log(`commit ${input.jobId}: the export folder could not be flushed after the rollback (${codeOf(error) ?? "error"})`));
    if (intentMayExist) await fs.fsyncDir(paths.pendingDir).catch((error: unknown) => log(`commit ${input.jobId}: .pending/ could not be flushed after the rollback (${codeOf(error) ?? "error"})`));
  };

  try {
    // 2. The temp must be the plain file the runner wrote.
    const before = await inPhase("verify", () => fs.lstat(temp));
    if (before.isSymbolicLink || !before.isFile) throw new RenderFailure({ code: "INTERNAL", detail: "the render output is not a regular file" });
    tempFacts = before;
    signal?.throwIfAborted();

    // Verify, hashing in the verifier's own pass: one read, no window between "verified" and "hashed".
    const verified = await inPhase("verify", () => verify(temp, { frames: input.frames, forbiddenStrings: input.forbiddenStrings }));
    if (!verified.result.ok) {
      const reasons = verified.result.reasons;
      // Codes and box paths only. A reason's message may quote the file, and must never carry a source string.
      for (const reason of reasons) log(`commit ${input.jobId}: verifier refused: ${reason.code}${reason.path === undefined ? "" : ` at ${reason.path}`}`);
      throw new VerifyRefusedError([...new Set(reasons.map((r) => r.code))]);
    }
    if (verified.sha256 === null) throw new RenderFailure({ code: "INTERNAL", detail: "the verifier did not read the whole file" });
    if (verified.bytes !== before.size) throw new TempChangedError("the temp changed while it was verified");
    const { sha256, bytes } = { sha256: verified.sha256, bytes: verified.bytes };
    await reached("verified");
    signal?.throwIfAborted();

    await inPhase("export", () => fs.fsyncFile(temp));
    await reached("temp-synced");

    const spec = parseRecordSpec(input.spec);
    await inPhase("export", () => fs.realpath(target.root)); // a root that cannot be resolved is refused here, tagged as the export folder's
    return await withRootLock(fs, target.root, target.caseInsensitive, async (): Promise<CommittedVideo> => {
        // The LAST cancel point (after a wait for the lock, which recovery may hold). From the claim on, the commit runs to its record.
        signal?.throwIfAborted();
        try {
          // 3. Claim the name: an empty placeholder, exclusively. The folder is checked first.
          await inPhase("export", checkFolder);
          let identity: FileIdentity | null = null;
          const claim = await inPhase("export", async () => {
            try {
              return await claimExportName({
                fs: {
                  createExclusive: async (path) => {
                    identity = await fs.createExclusive(path);
                  },
                },
                folder,
                date: input.date,
                kind: input.videoKind,
                ...(deps.claimStartAt === undefined ? {} : { startAt: deps.claimStartAt }),
              });
            } catch (error) {
              if (error instanceof ExportNamesExhaustedError) throw new RenderFailure({ code: "INTERNAL", detail: "no free export name is left for today" });
              throw error;
            }
          });
          if (identity === null) throw new Error("the claim reported no identity");
          const claimed = { path: claim.absPath, identity };
          placeholder = claimed;
          deps.onClaimed?.(claim.absPath);
          await reached("name-claimed");

          // 4. The intent: the full record-to-be.
          const record: VideoRecord = VideoRecordSchema.parse({
            schemaVersion: VIDEO_RECORD_SCHEMA_VERSION,
            id: input.videoId,
            avatarId: input.avatarId,
            jobId: input.jobId,
            createdAt: input.createdAt,
            kind: input.videoKind,
            durationMs: input.durationMs,
            frames: input.frames,
            montageId: input.montageId,
            music: input.music,
            file: { rootId: target.rootId, relPath: claim.relPath, bytes, sha256, mtimeMs: Math.floor(before.mtimeMs) },
            spec,
          });
          intentMayExist = true;
          await inPhase("library", () => writeIntent(fs, deps.libraryRoot, record, { beforeRename: () => reached("intent-temp-written") }));
          await reached("intent-written");

          // 5. Containment, the temp's identity and the placeholder's identity are re-checked BEFORE the rename; then the rename.
          await inPhase("export", checkFolder);
          const now = await inPhase("export", () => fs.lstat(temp));
          if (!sameFile(before, now)) throw new TempChangedError("the temp changed after it was verified");
          await inPhase("export", () => checkPlaceholder(claimed));
          // Temp and placeholder share one folder, so this cannot cross a volume; an EXDEV is a refusal, never a copy.
          await inPhase("export", () => fs.rename(temp, claim.absPath));
          placed = true;
          await reached("renamed");
          // ...and AFTER it: the name leads to the temp's own file, of the verified size, in the folder we checked.
          await inPhase("export", () => checkPlaced(claim.absPath, bytes, before));
          await inPhase("export", () => fs.fsyncDir(folder.path));
          await reached("dir-synced");

          // 6. The record: the COMMIT POINT is the link. From here nothing rolls back.
          try {
            await inPhase("library", () => commitIntent(fs, deps.libraryRoot, input.avatarId, input.videoId, { log, afterLink: () => reached("record-linked") }));
          } catch (error) {
            const original = error instanceof PhaseError ? error.original : error;
            if (hasErrorCode(original, "EEXIST")) {
              // A record with our id is already there: leave every file alone. It is ours if it names our file (a recovery adopted it); anything else is a conflict to report.
              leaveEverything = true;
              if (!(await recordIsOurs(paths.record(input.videoId), record))) throw new RenderFailure({ code: "INTERNAL", detail: "another video record already has this video's id" });
              await undoIntent();
              intentMayExist = false;
            } else if (await exists(fs, paths.record(input.videoId))) {
              // The link did happen (an error reported after it): it is committed.
              log(`commit ${input.jobId}: the record exists although its link reported ${codeOf(original) ?? "an error"}`);
            } else {
              throw error;
            }
          }
          committed = true;
          intentMayExist = false;
          await reached("record-committed");

          return {
            record,
            absPath: claim.absPath,
            result: { kind: "render", videoId: record.id, avatarId: record.avatarId, bytes, durationMs: record.durationMs, videoKind: record.kind, relPath: claim.relPath },
          };
        } catch (error) {
          await rollback();
          throw error;
        }
    });
  } catch (error) {
    await rollback();
    // A cancel (the signal's own reason) passes through; the rest is told without paths.
    if (signal?.aborted === true && error === signal.reason) throw error;
    const failure = error instanceof PhaseError ? failureFrom(error.phase, error.original) : failureFrom("internal", error);
    log(`commit ${input.jobId}: failed: ${failure.engineError.code}`);
    throw failure;
  }
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

/** Whether the record on disk is this commit's own (same video, job and file), rather than another one under the same id. */
async function recordIsOurs(path: string, ours: VideoRecord): Promise<boolean> {
  try {
    const parsed = VideoRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success && parsed.data.id === ours.id && parsed.data.jobId === ours.jobId && parsed.data.file.relPath === ours.file.relPath && parsed.data.file.sha256 === ours.file.sha256;
  } catch {
    return false;
  }
}
