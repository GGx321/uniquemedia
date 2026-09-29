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
import type { CommitFs, FileFacts } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { partNameOf, videoPaths, type VideoRecord } from "./record";

// The commit of one finished render (Stage 3 plan, "Commit" row, steps 2-6 and
// invariants 23 and 33). The runner leaves `.studio-part-<jobId>.mp4` next to
// where the video will live; this function turns it into a committed video or
// into nothing:
//
//   verify (+ sha256 in the same pass) -> fsync the temp -> claim the name ->
//   intent -> rename the temp over its placeholder -> fsync the folder ->
//   rename the intent to the record -> fsync videos/.
//
// CANCEL ("done wins", decision (a)): a cancel is honoured up to the moment the
// name is claimed and ignored from then on. Everything after the claim is a
// few renames and fsyncs (or one copy of at most ~8 MB), so finishing costs
// milliseconds, while undoing a half-done commit is itself a sequence of steps
// that can be interrupted. So the commit either ends before the claim with
// nothing left, or runs to the record. The render queue already treats a job whose
// work finished as done even if a cancel arrived meanwhile.
//
// FAILURE after the claim rolls back, in an order where every intermediate disk
// state is one the open-time recovery settles: the file first, then the record,
// then the intent, then the temp. A step that fails to undo stops the undoing
// there (an intent whose file could not be removed stays, so recovery adopts
// the file rather than orphaning it).
//
// Nothing here reads or writes a path except through `CommitFs`, and every
// path inside the export root is built by `PreparedFolder.fileIn`.

export type CommitStep =
  | "verified"
  | "temp-synced"
  | "name-claimed"
  /** The intent's temp file is durable and not yet renamed: mid-write. */
  | "intent-temp-written"
  | "intent-written"
  /** The EXDEV copy is complete and synced; the temp is not deleted yet. */
  | "exdev-copied"
  | "renamed"
  | "dir-synced"
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

/** The export folder is not where (or what) it was: swapped for a link, moved, or a different folder. */
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
  /** The RESOLVED spec: what was rendered. */
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
  /** The claimed placeholder's path, as soon as it exists: the recovery sweep must not take it from a live job. */
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
  if (error instanceof TempChangedError || (error instanceof Error && error.name === "CopyMismatchError")) {
    return failure({ code: "RENDER_VERIFY_FAILED", detail: "the video file changed after it was checked" });
  }
  if (phase === "library") {
    if (code === "ENOSPC" || code === "EDQUOT") return failure({ code: "INTERNAL", detail: "the library's disk is full: the video's record could not be saved" });
    return failure({ code: "INTERNAL", detail: `the library could not save the video's record (${code ?? "error"})` });
  }
  if (phase === "export") {
    if (code === "ENOSPC" || code === "EDQUOT") return exportRefusal("not-enough-space", "the export folder's disk is full");
    if (code === "ENOENT" || code === "ENOTDIR") return exportRefusal("missing", "the export folder is gone");
    return exportRefusal("not-writable", `the export folder could not be written (${code ?? "error"})`);
  }
  if (phase === "verify") return failure({ code: "INTERNAL", detail: `the render output could not be checked (${code ?? "error"})` });
  return failure({ code: "INTERNAL", detail: `the commit failed (${code ?? "error"})` });
}

/** The parts of `lstat` that say whether a file is still the file that was checked. */
const sameFile = (a: FileFacts, b: FileFacts): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

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

  // What exists on disk, for the rollback.
  let placeholder: string | null = null;
  let intentMayExist = false;
  let recordAttempted = false;

  /** The export folder is still a real folder directly under the root, at its own name: a swapped-in link or another folder is not. Returns its real path. */
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

  /** After the rename: the file is a regular, single-link file of the verified size, and its real place is inside the checked folder. */
  const checkPlaced = async (absPath: string, bytes: number): Promise<void> => {
    const realFolder = await checkFolder();
    const info = await fs.lstat(absPath);
    if (info.isSymbolicLink || !info.isFile || info.nlink !== 1 || info.size !== bytes) throw new ContainmentError("the saved file is not the file that was written");
    const realFile = await fs.realpath(absPath);
    if (placeOf(nodePath, dirname(realFile), target.caseInsensitive) !== placeOf(nodePath, realFolder, target.caseInsensitive)) throw new ContainmentError("the saved file resolves outside its folder");
  };

  const undo = async (what: string, work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return true;
      log(`commit ${input.jobId}: could not remove the ${what} (${codeOf(error) ?? "error"})`);
      return false;
    }
  };

  /** Puts the disk back as it was before this commit, in the order recovery can settle at every step. Never throws. */
  const rollback = async (): Promise<void> => {
    let foldersAreOurs = false;
    try {
      await checkFolder();
      foldersAreOurs = true;
    } catch {
      // A swapped or vanished folder: nothing inside the export root is touched below, only the library's own files.
      log(`commit ${input.jobId}: the export folder failed its containment check; its files are left as they are`);
    }
    let fileGone = true;
    if (foldersAreOurs) {
      const claimed = placeholder;
      if (claimed !== null) fileGone = await undo("unfinished video file", () => fs.unlink(claimed));
      if (fileGone && recordAttempted) fileGone = await undo("video record", () => fs.unlink(paths.record(input.videoId)));
    }
    // An intent whose file could not be removed stays: recovery adopts the file, and nothing is orphaned.
    if (fileGone && intentMayExist) await undo("commit intent", () => fs.unlink(paths.intent(input.videoId)));
    if (foldersAreOurs) await undo("temp file", () => fs.unlink(temp));
  };

  try {
    // 2. The temp must be the plain file the runner wrote.
    const before = await inPhase("verify", () => fs.lstat(temp));
    if (before.isSymbolicLink || !before.isFile) throw new RenderFailure({ code: "INTERNAL", detail: "the render output is not a regular file" });
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
    // The LAST cancel point. From the claim on, the commit runs to its record.
    signal?.throwIfAborted();

    // 3. Claim the name: an empty placeholder, exclusively. The folder is checked first.
    await inPhase("export", checkFolder);
    const claim = await inPhase("export", async () => {
      try {
        return await claimExportName({ fs: { createExclusive: (path) => fs.createExclusive(path) }, folder, date: input.date, kind: input.videoKind, ...(deps.claimStartAt === undefined ? {} : { startAt: deps.claimStartAt }) });
      } catch (error) {
        if (error instanceof ExportNamesExhaustedError) throw new RenderFailure({ code: "INTERNAL", detail: "no free export name is left for today" });
        throw error;
      }
    });
    placeholder = claim.absPath;
    deps.onClaimed?.(claim.absPath);
    await reached("name-claimed");

    // 4. The intent: the full record-to-be.
    const record: VideoRecord = {
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
      spec: input.spec,
    };
    intentMayExist = true;
    await inPhase("library", () => writeIntent(fs, deps.libraryRoot, record, { beforeRename: () => reached("intent-temp-written") }));
    await reached("intent-written");

    // 5. Containment and the temp's identity are re-checked BEFORE the rename; then the rename, over our own placeholder.
    await inPhase("export", checkFolder);
    const now = await inPhase("export", () => fs.lstat(temp));
    if (!sameFile(before, now)) throw new TempChangedError("the temp changed after it was verified");
    await inPhase("export", async () => {
      try {
        await fs.rename(temp, claim.absPath);
      } catch (error) {
        if (!hasErrorCode(error, "EXDEV")) throw error;
        // A sub-mount inside the export root: copy into the placeholder (checked against the verified size and sha256), then drop the temp.
        await fs.copyOver(temp, claim.absPath, { bytes, sha256 });
        await reached("exdev-copied");
        await fs.unlink(temp).catch((unlinkError: unknown) => log(`commit ${input.jobId}: the temp could not be removed after the copy (${codeOf(unlinkError) ?? "error"}); the next sweep takes it`));
      }
    });
    await reached("renamed");
    // ...and AFTER it: the file is where the folder is, and is the file that was written.
    await inPhase("export", () => checkPlaced(claim.absPath, bytes));
    await inPhase("export", () => fs.fsyncDir(folder.path));
    await reached("dir-synced");

    // 6. The record: the intent renamed, write-once.
    try {
      await inPhase("library", () => commitIntent(fs, deps.libraryRoot, input.avatarId, input.videoId));
    } catch (error) {
      const original = error instanceof PhaseError ? error.original : error;
      // EEXIST and ENOENT are refusals before the rename: no record of ours exists to remove.
      if (!hasErrorCode(original, "EEXIST") && !hasErrorCode(original, "ENOENT")) recordAttempted = true;
      throw error;
    }
    intentMayExist = false;
    recordAttempted = true;
    await reached("record-committed");

    return {
      record,
      absPath: claim.absPath,
      result: { kind: "render", videoId: record.id, avatarId: record.avatarId, bytes, durationMs: record.durationMs, videoKind: record.kind, relPath: claim.relPath },
    };
  } catch (error) {
    await rollback();
    // A cancel (the signal's own reason) and anything already shaped for the queue pass through; the rest is told without paths.
    if (signal?.aborted === true && error === signal.reason) throw error;
    const failure = error instanceof PhaseError ? failureFrom(error.phase, error.original) : failureFrom("internal", error);
    log(`commit ${input.jobId}: failed: ${failure.engineError.code}`);
    throw failure;
  }
}
