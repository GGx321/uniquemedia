import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { errorResponseFor, Id, PROTOCOL_VERSION, type AvatarDeleteResult, type CommandMessage, type EngineError, type ResponseMessage } from "../shared/engine";
import type { AvatarDeletePlan } from "../engine/control";

// «Удалить аватар» (owner request 2026-10-05): the avatar, its photos, candidates, master, drafts and finished videos go to the system Trash (macOS Trash,
// Windows Recycle Bin), so they can be restored from there. Only main has `shell.trashItem`; the window names an avatar and never a path.
//
// WHAT MAIN DOES, in this order (the engine's side is in engine.ts, `#deletePrepare` and `#deleteFinish`):
//   1. `avatar.deletePrepare`: the engine refuses while anything of the avatar runs; otherwise it hands over the PLAN: the avatar's folder and each of its
//      video files, which IT resolved from its own records, inside the library and the export folder. The avatar is claimed from here to step 4.
//   2. Main checks every path of the plan against ITS OWN roots (the settings' library and export folders), by real path, and never follows a link out:
//      the folder must be exactly `<library>/avatars/<avatarId>` and a real folder; a video file must be a regular file exactly `<export>/<folder>/<file>`
//      in a real folder of the export root. A file that fails is LEFT where it is (counted as kept); a folder that fails stops the whole delete.
//   3. The avatar's FOLDER goes to the Trash first. Everything the avatar is (photos, master, candidates, drafts, its video records) is in it, so until
//      it has moved the disk is exactly as it was: a crash or a refusal before this leaves a normal avatar. A Trash that cannot take it (a network drive, a
//      Windows share with no Recycle Bin, a failed move) refuses with TRASH_UNAVAILABLE and the avatar stays. NEVER a permanent delete in its place.
//   4. `avatar.deleteFinish` tells the engine `trashed` or `kept`; it is sent whatever happened, so the engine's claim never outlives the delete.
//   5. Only then the video files, one by one, each looked at again right before it moves. A crash here leaves plain mp4 files without records: nothing is
//      lost, the owner still has them. A file the Trash refuses stays a plain file and is counted in `videoFilesKept`, which the owner is told.

export type AvatarDeleteCommand = Extract<CommandMessage, { type: "avatars.delete" }>;

export function isAvatarDeleteCommand(command: CommandMessage): command is AvatarDeleteCommand {
  return command.type === "avatars.delete";
}

/** What `lstat` says an entry is; null (from `lstat`) for one that does not exist. A link is never followed. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface AvatarDeleteFlowDeps {
  engine: {
    /** `avatar.deletePrepare`: `error` is null with a `deletePlan` on success. */
    prepareAvatarDelete(avatarId: string): Promise<{ error: EngineError | null; deletePlan?: AvatarDeletePlan | undefined }>;
    /** `avatar.deleteFinish`. */
    finishAvatarDelete(avatarId: string, outcome: "trashed" | "kept"): Promise<{ error: EngineError | null }>;
  };
  /** The library folder as main saved it. */
  libraryPath(): string;
  /** The export folder as main saved it. */
  exportPath(): string;
  fs: {
    /** The real path (every link resolved); rejects for a path that does not exist. */
    realpath(path: string): Promise<string>;
    /** What the entry is, without following a link; null when it does not exist. */
    lstat(path: string): Promise<EntryKind | null>;
  };
  /** `shell.trashItem`: moves to the system Trash and rejects when it cannot. */
  trash(path: string): Promise<void>;
  /** Whether the system Trash takes this path. False for a place it cannot (a Windows network share): that is refused up front. */
  trashable(path: string): Promise<boolean>;
  platform: NodeJS.Platform;
  /** Fixed sentences and counts only: never a path. */
  log?(line: string): void;
}

/** The real disk for `AvatarDeleteFlowDeps.fs`: `lstat` never follows a link, and a missing entry (ENOENT, ENOTDIR) is null, not an error. */
export const NODE_FLOW_FS: AvatarDeleteFlowDeps["fs"] = {
  realpath: (path) => realpath(path),
  lstat: async (path) => {
    try {
      const info = await lstat(path);
      return info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      throw error;
    }
  },
};

const apiOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The refusal answered when the Trash cannot take the avatar: nothing was deleted. */
const TRASH_REFUSED: EngineError = { code: "TRASH_UNAVAILABLE", detail: "the system Trash did not take the avatar's folder; nothing was deleted" };

/** The answer when main could not make sure of a path: nothing was moved. */
const NOT_VERIFIED: EngineError = { code: "INTERNAL", detail: "the avatar's folder could not be verified, so nothing was deleted" };

export async function handleAvatarDeleteCommand(command: AvatarDeleteCommand, deps: AvatarDeleteFlowDeps): Promise<ResponseMessage> {
  const { avatarId } = command.payload;
  const log = deps.log ?? (() => undefined);
  const prepared = await deps.engine.prepareAvatarDelete(avatarId);
  if (prepared.error !== null) return errorResponseFor(command, prepared.error);
  const plan = prepared.deletePlan;
  if (plan === undefined) return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the delete without a plan" });

  // From here the engine holds the avatar claimed: exactly one finish must follow, whatever happens.
  let finished = false;
  const finish = async (outcome: "trashed" | "kept"): Promise<void> => {
    finished = true;
    const answer = await deps.engine.finishAvatarDelete(avatarId, outcome).catch((): { error: EngineError | null } => ({ error: { code: "INTERNAL" } }));
    if (answer.error !== null) log(`the engine did not take the end of an avatar delete (${answer.error.code})`);
  };

  try {
    const checked = await verifyFolder(plan, avatarId, deps);
    if (checked !== null) {
      log(`an avatar delete was refused by main's own check of the folder (${checked})`);
      await finish("kept");
      return errorResponseFor(command, NOT_VERIFIED);
    }
    if (!(await deps.trashable(plan.folder))) {
      await finish("kept");
      return errorResponseFor(command, TRASH_REFUSED);
    }
    // Looked at BEFORE the move too: the files are checked against the roots while the folder is still there to compare with.
    const candidates = await verifyFiles(plan, deps);

    try {
      await deps.trash(plan.folder);
    } catch (error) {
      // The shell can report an error after the move was done: the folder being gone is what counts.
      if ((await deps.fs.lstat(plan.folder).catch((): EntryKind | null => "directory")) !== null) {
        log(`the system Trash did not take an avatar's folder (${codeOf(error)})`);
        await finish("kept");
        return errorResponseFor(command, TRASH_REFUSED);
      }
    }
    await finish("trashed");

    let trashed = 0;
    let kept = candidates.skipped + plan.unlisted;
    for (const file of candidates.files) {
      // Looked at again right before it moves: a file replaced by a link meanwhile is left alone.
      if (!(await fileIsOurs(file, candidates.exportRoot, candidates.libraryRoot, plan.exportRoot ?? "", deps).catch(() => false))) {
        kept++;
        continue;
      }
      try {
        await deps.trash(file);
        trashed++;
      } catch (error) {
        kept++;
        log(`a video file could not be moved to the Trash (${codeOf(error)}); it stays where it is`);
      }
    }
    const result: AvatarDeleteResult = { avatarId, videoFilesTrashed: trashed, videoFilesKept: kept };
    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result };
  } catch (error) {
    log(`an avatar delete failed in main (${codeOf(error)})`);
    if (!finished) await finish("kept");
    return errorResponseFor(command, finished ? { code: "INTERNAL", detail: "the avatar was deleted, but main could not finish moving its video files" } : NOT_VERIFIED);
  }
}

/** A system error's code (`EACCES`, `EIO`) when it is a plain one, else the error's name. Never its message: that carries the path. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code)) return error.code;
  return error instanceof Error ? error.name : "error";
}

function fold(platform: NodeJS.Platform, path: string): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

/** `path` is strictly below `root` (both real, spelled the same way). */
function isBelow(platform: NodeJS.Platform, root: string, path: string): boolean {
  const api = apiOf(platform);
  const rel = api.relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/** The reason the folder of the plan cannot be moved, or null when it is exactly `<library>/avatars/<avatarId>`, a real folder, in the library main's settings name. */
async function verifyFolder(plan: AvatarDeletePlan, avatarId: string, deps: AvatarDeleteFlowDeps): Promise<string | null> {
  const api = apiOf(deps.platform);
  const same = (a: string, b: string): boolean => fold(deps.platform, api.normalize(a)) === fold(deps.platform, api.normalize(b));
  if (plan.avatarId !== avatarId || !Id.safeParse(avatarId).success) return "another avatar";
  // The place the library keeps the avatar, by its own naming: nothing the plan says is trusted beyond this shape.
  if (!same(plan.folder, api.join(plan.libraryRoot, "avatars", avatarId))) return "not the avatar's place";
  const realLibrary = await deps.fs.realpath(plan.libraryRoot);
  if (!same(realLibrary, await deps.fs.realpath(deps.libraryPath()))) return "not the saved library";
  // A link at the folder itself would move the link and leave what it points at: a real folder only.
  if ((await deps.fs.lstat(plan.folder)) !== "directory") return "not a folder";
  if (!same(await deps.fs.realpath(plan.folder), api.join(realLibrary, "avatars", avatarId))) return "outside the library";
  return null;
}

/** What `verifyFiles` found: the files that may be moved, how many it left, and the real roots they were judged against. */
interface Candidates {
  readonly files: readonly string[];
  readonly skipped: number;
  readonly exportRoot: string;
  readonly libraryRoot: string;
}

async function verifyFiles(plan: AvatarDeletePlan, deps: AvatarDeleteFlowDeps): Promise<Candidates> {
  const none: Candidates = { files: [], skipped: plan.files.length, exportRoot: "", libraryRoot: "" };
  if (plan.exportRoot === null || plan.files.length === 0) return none;
  const api = apiOf(deps.platform);
  const same = (a: string, b: string): boolean => fold(deps.platform, api.normalize(a)) === fold(deps.platform, api.normalize(b));
  try {
    const exportRoot = await deps.fs.realpath(plan.exportRoot);
    const libraryRoot = await deps.fs.realpath(plan.libraryRoot);
    // The export folder the settings name, and one that neither holds the library nor lies in it.
    if (!same(exportRoot, await deps.fs.realpath(deps.exportPath()))) return none;
    if (same(exportRoot, libraryRoot) || isBelow(deps.platform, libraryRoot, exportRoot) || isBelow(deps.platform, exportRoot, libraryRoot)) return none;
    const files: string[] = [];
    for (const file of plan.files) {
      if (await fileIsOurs(file, exportRoot, libraryRoot, plan.exportRoot, deps).catch(() => false)) files.push(file);
    }
    return { files, skipped: plan.files.length - files.length, exportRoot, libraryRoot };
  } catch {
    return none;
  }
}

/**
 * Whether `file` is a video file main may move: exactly `<export>/<folder>/<file>` by the plan's own spelling, a regular file (never a link), in a folder
 * that really is `<export>/<folder>` (no link out of the export folder), and nowhere in the library.
 */
async function fileIsOurs(file: string, realExport: string, realLibrary: string, planExport: string, deps: AvatarDeleteFlowDeps): Promise<boolean> {
  if (realExport === "") return false;
  const api = apiOf(deps.platform);
  const rel = api.relative(planExport, file);
  const parts = rel.split(api.sep);
  if (parts.length !== 2 || parts.some((part) => part === "" || part === "." || part === "..") || api.isAbsolute(rel)) return false;
  const [folderName] = parts;
  if (folderName === undefined) return false;
  if ((await deps.fs.lstat(file)) !== "file") return false;
  const realFolder = await deps.fs.realpath(api.dirname(file));
  if (fold(deps.platform, api.normalize(realFolder)) !== fold(deps.platform, api.normalize(api.join(realExport, folderName)))) return false;
  return !isBelow(deps.platform, realLibrary, realFolder) && fold(deps.platform, api.normalize(realFolder)) !== fold(deps.platform, api.normalize(realLibrary));
}
