import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isSafeName, RelativePath, VideoKindToken, type ExportUnavailableReason } from "../shared/engine";
import { hasErrorCode } from "./library/durableFs";

// How a rendered video is named inside the export folder (Stage 3 plan,
// "Outputs and export"): `<exportRoot>/<SafeName>/<YYYY-MM-DD>_<kind>_<NNN>.mp4`.
// The rules here are pure (they run the same on macOS and Windows); only
// `prepareExportFolder` and `claimExportName` touch a disk, through injected
// interfaces.

/** The most a name can count up to: `RelativePath` allows a counter of 3 to 6 digits. */
const MAX_COUNTER = 999_999;

/** A passport-style Russian (and Ukrainian) table, ГОСТ 7.79 system B in spirit: fixed and deterministic, so a name always maps the same way. ь and ъ are dropped. */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

function isUpperLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch !== ch.toLowerCase();
}

/**
 * Cyrillic to Latin before the ASCII reduction, so «Мия» becomes `Miya` and not
 * an opaque id. A capital gives a capital first letter (`Yolka`); a letter whose
 * neighbour is also a capital is a whole capitalised word (`МИЯ` → `MIYA`).
 */
function transliterate(raw: string): string {
  const chars = Array.from(raw);
  return chars
    .map((ch, i) => {
      const lower = ch.toLowerCase();
      const latin = CYRILLIC_TO_LATIN[lower];
      if (latin === undefined) return ch;
      if (ch === lower || latin === "") return latin;
      return isUpperLetter(chars[i - 1]) || isUpperLetter(chars[i + 1]) ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1);
    })
    .join("");
}

function trimSeparators(text: string): string {
  return text.replace(/^[_-]+|[_-]+$/g, "");
}

function reduceToSafe(raw: string): string {
  const ascii = transliterate(raw)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_");
  return trimSeparators(trimSeparators(ascii).slice(0, 64));
}

/**
 * The avatar's folder inside the export folder: ASCII `[A-Za-z0-9_-]`, at
 * most 64 characters, never a Windows device name. Every name this returns
 * satisfies `isSafeName`, the exact predicate `RelativePath` applies to its
 * folder, so a path the engine builds always parses.
 *
 * - Cyrillic is transliterated first (`Мия` → `Miya`); accents are dropped
 *   (`Zoë` → `Zoe`); a letter with no ASCII form (emoji, other scripts) is a
 *   separator, and any run of separators is one `_`.
 * - The result starts and ends on a letter or a digit: no leading `-` (an
 *   option to a command line), no trailing `.` or space (Windows strips them),
 *   and none of either exists in the charset anyway.
 * - When fewer than two letters are left, or what is left is a device name
 *   (`CON`, `nul`, `COM1`), the folder is the avatar's id instead. Two avatars
 *   can share a folder (`Mia!` and `Mia?`); files stay unique through the counter.
 */
export function safeName(avatarName: string, avatarId: string): string {
  const own = reduceToSafe(avatarName);
  if ((own.match(/[A-Za-z]/g) ?? []).length >= 2 && isSafeName(own)) return own;
  const byId = reduceToSafe(avatarId);
  return isSafeName(byId) ? byId : "avatar";
}

/**
 * The folder used when `safeName`'s own is taken by something that is not a
 * real folder of ours (a file, a link): the name plus the first 8 characters
 * of the avatar's id, at most 64 in all.
 */
export function suffixedFolderName(name: string, avatarId: string): string {
  const id = trimSeparators(avatarId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, ""));
  const joined = `${trimSeparators(name.slice(0, 55))}_${id === "" ? "id" : id}`;
  return isSafeName(joined) ? joined : "avatar";
}

/**
 * The kind part of a file name: lowercase ASCII letters and digits, starting
 * with a letter, at most 16 (`VideoKindToken`). The engine's own kinds
 * (`photo`, `collage3`, `mix`) pass unchanged; anything else is reduced, and
 * `video` stands in when nothing is left.
 */
export function kindToken(raw: string): string {
  const reduced = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 16);
  return reduced === "" ? "video" : reduced;
}

/** The local calendar date as `YYYY-MM-DD`: what the owner reads in the file name. */
export function formatExportDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** `<date>_<kind>_<NNN>.mp4`; the counter is padded to 3 digits and grows past 999. */
export function exportFileName(date: string, kind: string, n: number): string {
  return `${date}_${kind}_${String(n).padStart(3, "0")}.mp4`;
}

// ---------- the avatar's folder ----------

/** The part of the filesystem the folder rules need; injected so tests can play links and other volumes. */
export interface ExportFolderFs {
  /** NON-recursive: rejects with EEXIST when the entry exists and with ENOENT when the parent is gone. */
  mkdir(path: string): Promise<void>;
  /** Does not follow a symlink (Node reports a Windows junction as one too). */
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
}

export const NODE_EXPORT_FOLDER_FS: ExportFolderFs = {
  mkdir: async (path) => {
    await mkdir(path);
  },
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
};

/** The avatar's folder, opened: its name exactly as the disk stores it, and where it is. */
export interface PreparedFolder {
  name: string;
  path: string;
}

/** The export folder cannot take this folder; `reason` is the one the render is refused with (invariant 35). */
export class ExportFolderError extends Error {
  readonly reason: ExportUnavailableReason;

  constructor(reason: ExportUnavailableReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface PrepareExportFolderOptions {
  fs: ExportFolderFs;
  /** The export folder. */
  root: string;
  /** From `safeName`; refused here if it is not one. */
  safeName: string;
  avatarId: string;
  /** Windows and macOS volumes fold letter case. */
  caseInsensitive: boolean;
}

/**
 * Opens `<root>/<SafeName>` for writing, and is the ONE way anything (the name
 * claim, and the render's temp file) gets a folder there:
 *
 * - created with a NON-recursive mkdir: a root that vanished is refused as
 *   `missing`, never recreated with its parents. `EEXIST` is fine;
 * - then `lstat` must say a real directory, not a symlink or junction (a planted
 *   link would send the video outside the export folder, even into the library),
 *   `realpath`'s parent must be the root's own real path, and the on-disk name
 *   must still be a SafeName. Otherwise the folder is not used and
 *   `<SafeName>_<8 of the avatar id>` is tried the same way (a regular file at
 *   the name lands here too); if that fails too the folder is refused;
 * - the name returned is the one the disk stores, so a case variant (`mia` for
 *   `Mia`) is recorded as what it really is.
 *
 * A link swapped in after this returns is not caught here: `claimExportName`'s
 * `wx` protects only the last component. The window is between two calls of one
 * render.
 */
export async function prepareExportFolder(options: PrepareExportFolderOptions): Promise<PreparedFolder> {
  const { fs, root } = options;
  if (!isSafeName(options.safeName)) throw new Error("the export folder name is not a SafeName");
  for (const candidate of [options.safeName, suffixedFolderName(options.safeName, options.avatarId)]) {
    const opened = await tryOpenFolder(fs, root, candidate, options.caseInsensitive);
    if (opened !== null) return opened;
  }
  throw new ExportFolderError("not-writable", "the avatar's export folder is taken by something that is not a folder of ours");
}

async function tryOpenFolder(fs: ExportFolderFs, root: string, name: string, caseInsensitive: boolean): Promise<PreparedFolder | null> {
  const path = join(root, name);
  try {
    await fs.mkdir(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new ExportFolderError("missing", "the export folder is gone");
    if (hasErrorCode(error, "ENOTDIR")) throw new ExportFolderError("not-a-directory", "the export folder is not a folder");
    if (!hasErrorCode(error, "EEXIST")) throw new ExportFolderError("not-writable", "the avatar's export folder could not be created");
  }
  let real: string;
  let rootReal: string;
  try {
    const info = await fs.lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    real = await fs.realpath(path);
    rootReal = await fs.realpath(root);
  } catch {
    return null;
  }
  const fold = (text: string) => (caseInsensitive ? text.toLowerCase() : text);
  const onDisk = basename(real);
  if (fold(dirname(real)) !== fold(rootReal) || !isSafeName(onDisk)) return null;
  return { name: onDisk, path: join(root, onDisk) };
}

// ---------- claiming the file name ----------

/** The part of the filesystem a name claim needs; injected so tests can play other disks. */
export interface ExportNameFs {
  /** Creates an empty file only if there is none (`wx`): rejects with `EEXIST` for any existing entry. */
  createExclusive(path: string): Promise<void>;
}

export const NODE_EXPORT_NAME_FS: ExportNameFs = {
  createExclusive: async (path) => {
    const handle = await open(path, "wx");
    await handle.close();
  },
};

export interface ExportNameClaim {
  /** `<folder name>/<date>_<kind>_<NNN>.mp4`, always a valid `RelativePath`. */
  relPath: string;
  /** The placeholder's place on this machine. */
  absPath: string;
  n: number;
}

export interface ClaimExportNameOptions {
  fs: ExportNameFs;
  /** From `prepareExportFolder`. */
  folder: PreparedFolder;
  /** `YYYY-MM-DD`. */
  date: string;
  /** From `kindToken`; refused here if it is not one. */
  kind: string;
  /** The first counter to try; 1 unless a test says otherwise. */
  startAt?: number;
}

/**
 * Claims the next free name by creating an empty placeholder exclusively
 * (invariant 33): on `EEXIST` the counter moves up by one, so two concurrent
 * renders never share a name and a file the owner put there is never touched.
 * On a case-insensitive disk the existing-entry test is the disk's own, so
 * `Photo_001` and `photo_001` collide as they should. Any other error is the
 * caller's to see.
 */
export async function claimExportName(options: ClaimExportNameOptions): Promise<ExportNameClaim> {
  const { fs, folder, date, kind } = options;
  if (!isSafeName(folder.name)) throw new Error("the export folder name is not a SafeName");
  if (!VideoKindToken.safeParse(kind).success) throw new Error("the export kind is not a kind token");
  // The first candidate is checked against the contract before any disk is touched.
  const first = `${folder.name}/${exportFileName(date, kind, options.startAt ?? 1)}`;
  if (!RelativePath.safeParse(first).success) throw new Error("the export name is not a valid relative path");
  for (let n = options.startAt ?? 1; n <= MAX_COUNTER; n++) {
    const name = exportFileName(date, kind, n);
    const absPath = join(folder.path, name);
    try {
      await fs.createExclusive(absPath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }
    return { relPath: `${folder.name}/${name}`, absPath, n };
  }
  throw new Error("no free name is left in the export folder for today");
}
