import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { errorResponseFor, Id, isSafeName, PROTOCOL_VERSION, type AvatarDeleteResult, type CommandMessage, type EngineError, type ResponseMessage } from "../shared/engine";
import type { AvatarDeletePlan } from "../engine/control";

// «Удалить аватар» (owner request 2026-10-05): the avatar, its photos, candidates, master, drafts and finished videos go to the system Trash (macOS Trash,
// Windows Recycle Bin), so they can be restored from there. Only main has `shell.trashItem`; the window names an avatar and never a path.
//
// WHAT MAIN DOES, in this order (the engine's side is in engine.ts, `#deletePrepare` and `#deleteFinish`):
//   1. `avatar.deletePrepare`: the engine refuses while anything of the avatar runs; otherwise it hands over the PLAN: the avatar's folder and each of its
//      video files, which IT resolved from its own records, inside the library and the export folder. The avatar is claimed from here to step 4. A prepare
//      that got no answer (a timeout, a lost reply) may still have claimed it: main then sends a best-effort `kept`.
//   2. Main checks every path of the plan against ITS OWN roots (the settings' library and export folders), by real path, and never follows a link out:
//      the folder must be exactly `<library>/avatars/<avatarId>` and a real folder; a video file must be a regular file exactly `<export>/<folder>/<file>`
//      in a real folder of the export root, and the two roots may not overlap. A file that fails is LEFT where it is (counted as kept); a folder that
//      fails stops the whole delete.
//   3. The avatar's FOLDER goes to the Trash first, looked at once more right before it moves, and it must be GONE afterwards before `trashed` is said.
//      Everything the avatar is (photos, master, candidates, drafts, its video records) is in it, so until it has moved the disk is exactly as it was: a crash
//      or a refusal before this leaves a normal avatar. A Trash that cannot take it (a network drive, a Windows share with no Recycle Bin, a failed move)
//      refuses with TRASH_UNAVAILABLE and the avatar stays. NEVER a permanent delete in its place: the Trash is asked about the REAL place of each path.
//   4. `avatar.deleteFinish` tells the engine `trashed` or `kept`; it is sent whatever happened, so the engine's claim never outlives the delete. An engine
//      that no longer knew the delete (it restarted) is asked to forget what the disk no longer has (`avatars.pruneMissing`).
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
    prepareAvatarDelete(avatarId: string, token: string): Promise<{ error: EngineError | null; deletePlan?: AvatarDeletePlan | undefined }>;
    /** `avatar.deleteFinish`. */
    finishAvatarDelete(avatarId: string, token: string, outcome: "trashed" | "kept"): Promise<{ error: EngineError | null }>;
    /** `avatars.pruneMissing`: the engine forgets the avatars whose manifest is no longer on the disk. */
    pruneMissingAvatars(): Promise<{ error: EngineError | null }>;
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
    /**
     * The entry's identity (device and inode), read WITHOUT following a link, so a link has an identity of its own; null when it does not exist or the disk
     * cannot say. Two spellings of a path are one place only when this says so: case is never folded by guess.
     */
    identity(path: string): Promise<string | null>;
  };
  /** A fresh id for one delete: the engine ties the finish to its prepare by it, so a stray or late finish never releases another delete. */
  newToken(): string;
  /** `shell.trashItem`: moves to the system Trash and rejects when it cannot. */
  trash(path: string): Promise<void>;
  /** Whether the system Trash takes this REAL path. False for a place it cannot (a Windows network share): that is refused up front. */
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
  identity: async (path) => {
    try {
      const info = await lstat(path, { bigint: true });
      // An inode of 0 is a disk that cannot say (some network and FAT volumes): that is no identity.
      return info.ino === 0n ? null : `${info.dev}:${info.ino}`;
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
  const token = deps.newToken();
  const prepared = await deps.engine.prepareAvatarDelete(avatarId, token);
  if (prepared.error !== null) {
    // Only an answer that never came (INTERNAL: a timeout, a lost reply, a dead engine) may have left the avatar claimed; the engine's own refusals hold nothing.
    if (prepared.error.code === "INTERNAL") await deps.engine.finishAvatarDelete(avatarId, token, "kept").catch(() => undefined);
    return errorResponseFor(command, prepared.error);
  }
  const plan = prepared.deletePlan;
  if (plan === undefined) {
    await deps.engine.finishAvatarDelete(avatarId, token, "kept").catch(() => undefined);
    return errorResponseFor(command, { code: "INTERNAL", detail: "the engine answered the delete without a plan" });
  }

  // From here the engine holds the avatar claimed: exactly one finish must follow, whatever happens.
  let finished = false;
  const finish = async (outcome: "trashed" | "kept"): Promise<EngineError | null> => {
    finished = true;
    const answer = await deps.engine.finishAvatarDelete(avatarId, token, outcome).catch((): { error: EngineError | null } => ({ error: { code: "INTERNAL" } }));
    if (answer.error !== null) log(`the engine did not take the end of an avatar delete (${answer.error.code})`);
    return answer.error;
  };

  try {
    const checked = await verifyFolder(plan, avatarId, deps);
    if (!checked.ok) {
      log(`an avatar delete was refused by main's own check of the folder (${checked.reason})`);
      await finish("kept");
      return errorResponseFor(command, NOT_VERIFIED);
    }
    // The Trash is asked about where the folder REALLY is, not about how the plan spells it.
    if (!(await deps.trashable(checked.real))) {
      await finish("kept");
      return errorResponseFor(command, TRASH_REFUSED);
    }
    // The files are checked against the roots while the folder is still there to compare with.
    const candidates = await verifyFiles(plan, deps);

    // The folder once more, right before it moves: nothing between the first look and here may have put a link in its place.
    const again = await verifyFolder(plan, avatarId, deps);
    if (!again.ok) {
      log(`an avatar delete was refused by main's second check of the folder (${again.reason})`);
      await finish("kept");
      return errorResponseFor(command, NOT_VERIFIED);
    }

    let moveError: unknown = null;
    try {
      await deps.trash(again.real);
    } catch (error) {
      moveError = error;
    }
    // The shell can report an error after the move was done, and can report success without one: only the folder being GONE counts.
    if ((await deps.fs.lstat(again.real).catch((): EntryKind | null => "directory")) !== null) {
      log(`the system Trash did not take an avatar's folder (${moveError === null ? "reported done" : codeOf(moveError)})`);
      await finish("kept");
      return errorResponseFor(command, TRASH_REFUSED);
    }
    const lost = await finish("trashed");
    // The engine did not know this delete (it restarted): it still lists an avatar whose folder is gone, so it is asked to look at the disk.
    if (lost !== null && lost.code === "NOT_FOUND") {
      const pruned = await deps.engine.pruneMissingAvatars().catch((): { error: EngineError | null } => ({ error: { code: "INTERNAL" } }));
      if (pruned.error !== null) log(`the engine could not forget the avatars the disk no longer has (${pruned.error.code})`);
    }

    let trashed = 0;
    let kept = candidates.skipped;
    for (const file of candidates.files) {
      // Looked at again right before it moves: a file replaced by a link meanwhile is left alone.
      const real = await fileIsOurs(file, candidates.exportRoot, candidates.libraryRoot, plan.exportRoot ?? "", deps).catch(() => null);
      if (real === null) {
        kept++;
        continue;
      }
      // Its own volume may have no Trash (the export folder on a network share): moved there it could be deleted for good, so it stays.
      if (!(await deps.trashable(real).catch(() => false))) {
        kept++;
        continue;
      }
      try {
        await deps.trash(real);
        trashed++;
      } catch (error) {
        kept++;
        log(`a video file could not be moved to the Trash (${codeOf(error)}); it stays where it is`);
      }
    }
    const result: AvatarDeleteResult = { avatarId, videoFilesTrashed: trashed, videoFilesKept: kept, videoFilesUnchecked: plan.unlisted, videoFolder: videoFolderOf(plan, deps.platform) };
    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result };
  } catch (error) {
    log(`an avatar delete failed in main (${codeOf(error)})`);
    if (!finished) await finish("kept");
    return errorResponseFor(command, finished ? { code: "INTERNAL", detail: "the avatar was deleted, but main could not finish moving its video files" } : NOT_VERIFIED);
  }
}

/** The avatar's folder NAME inside the export folder (the first segment of a planned file, never a path); null when no file was planned or it is not a safe name. */
function videoFolderOf(plan: AvatarDeletePlan, platform: NodeJS.Platform): string | null {
  const first = plan.files[0];
  if (first === undefined || plan.exportRoot === null) return null;
  const api = apiOf(platform);
  const name = api.relative(plan.exportRoot, first).split(api.sep)[0];
  return name !== undefined && isSafeName(name) ? name : null;
}

/** A system error's code (`EACCES`, `EIO`) when it is a plain one, else the error's name. Never its message: that carries the path. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code)) return error.code;
  return error instanceof Error ? error.name : "error";
}

/** A path normalised, spelled exactly: the shape the plan must have. */
function exactly(platform: NodeJS.Platform, path: string): string {
  return apiOf(platform).normalize(path);
}

/**
 * A path normalised and with the case folded, for REFUSALS only (the two roots overlapping, a folder being the library itself): folding there can only add a
 * refusal, never let a path through that an exact look would not.
 */
function folded(platform: NodeJS.Platform, path: string): string {
  return exactly(platform, path).toLowerCase();
}

/** `path` is strictly below `root` (both real); folded, so it only ever adds refusals. */
function isBelow(platform: NodeJS.Platform, root: string, path: string): boolean {
  const api = apiOf(platform);
  const rel = api.relative(folded(platform, root), folded(platform, path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/**
 * Whether two REAL paths name one place. Spelled exactly alike: yes. Spelled differently (a volume that folds case, a Finder rename): only when the disk says
 * they are ONE THING, the same device and inode, each read without following a link (so `Mia` that is a link to `mia` is not `mia`). Case is never folded by
 * guess: on a case-sensitive volume `Mia` and `mia` are two folders, and a path the disk cannot vouch for is not accepted.
 */
async function samePlace(deps: AvatarDeleteFlowDeps, a: string, b: string): Promise<boolean> {
  if (exactly(deps.platform, a) === exactly(deps.platform, b)) return true;
  const [first, second] = await Promise.all([deps.fs.identity(a), deps.fs.identity(b)]);
  return first !== null && first === second;
}

/**
 * `real` (a REAL path) is the place `base/…names` names: spelled exactly alike, or, when only the spelling differs, every name below `base` is a real folder (not a
 * link: a link at `avatars` or at `Mia` would lead to somewhere else that happens to share an inode when looked at through it) and the disk says both are one thing.
 */
async function samePlaceBelow(deps: AvatarDeleteFlowDeps, real: string, base: string, names: readonly string[]): Promise<boolean> {
  const api = apiOf(deps.platform);
  const named = api.join(base, ...names);
  if (exactly(deps.platform, real) === exactly(deps.platform, named)) return true;
  let walk = base;
  for (const name of names) {
    walk = api.join(walk, name);
    if ((await deps.fs.lstat(walk)) !== "directory") return false;
  }
  return samePlace(deps, real, named);
}

type FolderCheck ={ readonly ok: true; readonly real: string } | { readonly ok: false; readonly reason: string };

/** The folder of the plan when it is exactly `<library>/avatars/<avatarId>`, a real folder, in the library main's settings name (its REAL path); else why not. */
async function verifyFolder(plan: AvatarDeletePlan, avatarId: string, deps: AvatarDeleteFlowDeps): Promise<FolderCheck> {
  const api = apiOf(deps.platform);
  if (plan.avatarId !== avatarId || !Id.safeParse(avatarId).success) return { ok: false, reason: "another avatar" };
  // The place the library keeps the avatar, by its own naming, spelled exactly: nothing the plan says is trusted beyond this shape.
  if (exactly(deps.platform, plan.folder) !== exactly(deps.platform, api.join(plan.libraryRoot, "avatars", avatarId))) return { ok: false, reason: "not the avatar's place" };
  const realLibrary = await deps.fs.realpath(plan.libraryRoot);
  if (!(await samePlace(deps, realLibrary, await deps.fs.realpath(deps.libraryPath())))) return { ok: false, reason: "not the saved library" };
  // A link at the folder itself would move the link and leave what it points at: a real folder only.
  if ((await deps.fs.lstat(plan.folder)) !== "directory") return { ok: false, reason: "not a folder" };
  const real = await deps.fs.realpath(plan.folder);
  if (!(await samePlaceBelow(deps, real, realLibrary, ["avatars", avatarId]))) return { ok: false, reason: "outside the library" };
  return { ok: true, real };
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
  try {
    const exportRoot = await deps.fs.realpath(plan.exportRoot);
    const libraryRoot = await deps.fs.realpath(plan.libraryRoot);
    // The export folder the settings name, and one that neither holds the library nor lies in it (a refusal in any spelling: folded, or the same inode).
    if (!(await samePlace(deps, exportRoot, await deps.fs.realpath(deps.exportPath())))) return none;
    if (folded(deps.platform, exportRoot) === folded(deps.platform, libraryRoot) || isBelow(deps.platform, libraryRoot, exportRoot) || isBelow(deps.platform, exportRoot, libraryRoot)) return none;
    if (await samePlace(deps, exportRoot, libraryRoot)) return none;
    const files: string[] = [];
    for (const file of plan.files) {
      if ((await fileIsOurs(file, exportRoot, libraryRoot, plan.exportRoot, deps).catch(() => null)) !== null) files.push(file);
    }
    return { files, skipped: plan.files.length - files.length, exportRoot, libraryRoot };
  } catch {
    return none;
  }
}

/**
 * The REAL path of `file` when it is a video file main may move, else null: exactly `<export>/<folder>/<file>` by the plan's own spelling, a regular file
 * (never a link), in a folder that really is `<export>/<folder>` (the same place by identity: no link out of the export folder, and no other folder that only
 * a case tells apart), and nowhere in the library.
 */
async function fileIsOurs(file: string, realExport: string, realLibrary: string, planExport: string, deps: AvatarDeleteFlowDeps): Promise<string | null> {
  if (realExport === "") return null;
  const api = apiOf(deps.platform);
  const rel = api.relative(planExport, file);
  const parts = rel.split(api.sep);
  if (parts.length !== 2 || parts.some((part) => part === "" || part === "." || part === "..") || api.isAbsolute(rel)) return null;
  const [folderName] = parts;
  if (folderName === undefined) return null;
  if ((await deps.fs.lstat(file)) !== "file") return null;
  const realFolder = await deps.fs.realpath(api.dirname(file));
  if (!(await samePlaceBelow(deps, realFolder, realExport, [folderName]))) return null;
  if (isBelow(deps.platform, realLibrary, realFolder) || folded(deps.platform, realFolder) === folded(deps.platform, realLibrary)) return null;
  return api.join(realFolder, api.basename(file));
}
