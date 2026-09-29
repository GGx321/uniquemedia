import { lstat, mkdir, open, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import type { PathFlavour } from "./pathFlavour";
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
 * neighbour is also a capital is a whole capitalised word (`МИЯ` → `MIYA`); a
 * capital that writes nothing (`Ъ`, `Ь`) passes its capital on to the next
 * letter that is written (`Ъя` → `Ya`).
 */
function transliterate(raw: string): string {
  const chars = Array.from(raw);
  let owedCapital = false;
  let out = "";
  chars.forEach((ch, i) => {
    const lower = ch.toLowerCase();
    const latin = CYRILLIC_TO_LATIN[lower];
    if (latin === undefined) {
      out += ch;
      owedCapital = false;
      return;
    }
    const upper = ch !== lower;
    if (latin === "") {
      owedCapital = owedCapital || upper;
      return;
    }
    const wholeWord = upper && (isUpperLetter(chars[i - 1]) || isUpperLetter(chars[i + 1]));
    const capital = upper || owedCapital;
    out += wholeWord ? latin.toUpperCase() : capital ? latin[0].toUpperCase() + latin.slice(1) : latin;
    owedCapital = false;
  });
  return out;
}

function trimSeparators(text: string): string {
  return text.replace(/^[_-]+|[_-]+$/g, "");
}

/** Decomposes letters and drops their marks (`ñ` → `n`, `ў` → `у`). */
function stripMarks(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "");
}

function reduceToSafe(raw: string): string {
  // NFC first, so a decomposed `Е` + diaeresis is the table's `Ё` and not an `Е`. A letter outside the
  // table that loses its mark (`Ў` → `У`) is written a second time, now that its base is showing.
  const ascii = transliterate(stripMarks(transliterate(raw.normalize("NFC")))).replace(/[^A-Za-z0-9_-]+/g, "_");
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

/** Held only by this module: nothing outside can name it, so nothing outside can build a `PreparedFolder`. */
const ISSUE = Symbol("prepared export folder");

/**
 * The avatar's folder, opened: its name exactly as the disk stores it, and where
 * it is. Only `prepareExportFolder` makes one (a `#` field makes the class
 * nominal, and the constructor wants a token nobody else holds), so a caller
 * cannot hand-build a folder and skip the checks.
 */
export class PreparedFolder {
  readonly name: string;
  readonly path: string;
  readonly #issued = true;
  readonly #api: PathFlavour;

  constructor(token: typeof ISSUE, name: string, path: string, api: PathFlavour) {
    if (token !== ISSUE) throw new Error("a PreparedFolder comes from prepareExportFolder");
    this.name = name;
    this.path = path;
    this.#api = api;
  }

  /**
   * A file inside this folder, spelled the way the folder's own path is. The name must be one plain name:
   * not empty, not `.` or `..`, and not a path (`basename` of it, in the folder's flavour, is itself), so a
   * name cannot walk out of the folder or name a drive.
   */
  fileIn(fileName: string): string {
    if (fileName === "" || fileName === "." || fileName === ".." || fileName.includes("/") || this.#api.basename(fileName) !== fileName) {
      throw new Error("a file name inside the export folder must be one plain name");
    }
    return this.#api.join(this.path, fileName);
  }

  static isIssued(value: unknown): value is PreparedFolder {
    return typeof value === "object" && value !== null && #issued in value;
  }
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
  /** The path flavour; the platform's own unless a test plays another. */
  api?: PathFlavour;
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
  const api = options.api ?? nodePath;
  if (!isSafeName(options.safeName)) throw new Error("the export folder name is not a SafeName");
  for (const candidate of [options.safeName, suffixedFolderName(options.safeName, options.avatarId)]) {
    const opened = await tryOpenFolder(fs, api, root, candidate, options.caseInsensitive);
    if (opened !== null) return opened;
  }
  throw new ExportFolderError("not-writable", "the avatar's export folder is taken by something that is not a folder of ours");
}

/**
 * A real path reduced to what identifies the place: Windows' extended-length prefix (`\\?\C:\x`, and
 * `\\?\UNC\srv\share` for `\\srv\share`) is dropped, separators are normalised, a trailing one is trimmed
 * (a drive root keeps its own), and letter case is folded on a case-insensitive volume.
 */
function placeOf(api: PathFlavour, path: string, caseInsensitive: boolean): string {
  const unprefixed = api.sep === "\\" ? path.replace(/^\\\\[?.]\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\/, "") : path;
  const normal = api.normalize(unprefixed);
  // A backslash separates paths only on Windows; on POSIX it is a legal name character and stays.
  const trimmed = normal.replace(api.sep === "\\" ? /[\\/]+$/ : /\/+$/, "");
  const place = trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? normal : trimmed;
  return caseInsensitive ? place.toLowerCase() : place;
}

async function tryOpenFolder(fs: ExportFolderFs, api: PathFlavour, root: string, name: string, caseInsensitive: boolean): Promise<PreparedFolder | null> {
  const path = api.join(root, name);
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
  const onDisk = api.basename(real);
  if (placeOf(api, api.dirname(real), caseInsensitive) !== placeOf(api, rootReal, caseInsensitive) || !isSafeName(onDisk)) return null;
  return new PreparedFolder(ISSUE, onDisk, api.join(root, onDisk), api);
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
  if (!PreparedFolder.isIssued(folder)) throw new Error("the export folder did not come from prepareExportFolder");
  if (!isSafeName(folder.name)) throw new Error("the export folder name is not a SafeName");
  if (!VideoKindToken.safeParse(kind).success) throw new Error("the export kind is not a kind token");
  // The first candidate is checked against the contract before any disk is touched.
  const first = `${folder.name}/${exportFileName(date, kind, options.startAt ?? 1)}`;
  if (!RelativePath.safeParse(first).success) throw new Error("the export name is not a valid relative path");
  for (let n = options.startAt ?? 1; n <= MAX_COUNTER; n++) {
    const name = exportFileName(date, kind, n);
    const absPath = folder.fileIn(name);
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
