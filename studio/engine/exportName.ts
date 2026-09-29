import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { isSafeName, RelativePath, VideoKindToken } from "../shared/engine";
import { hasErrorCode } from "./library/durableFs";

// How a rendered video is named inside the export folder (Stage 3 plan,
// "Outputs and export"): `<exportRoot>/<SafeName>/<YYYY-MM-DD>_<kind>_<NNN>.mp4`.
// The rules here are pure (they run the same on macOS and Windows); only
// `claimExportName` touches a disk, through an injected `ExportNameFs`.

/** The most a name can count up to: `RelativePath` allows a counter of 3 to 6 digits. */
const MAX_COUNTER = 999_999;

/**
 * The avatar's folder inside the export folder: ASCII `[A-Za-z0-9_-]`, at
 * most 64 characters, never a Windows device name. Every name this returns
 * satisfies `isSafeName`, the exact predicate `RelativePath` applies to its
 * folder, so a path the engine builds always parses.
 *
 * - Accents are dropped (`Zoë` → `Zoe`); a letter with no ASCII form (Cyrillic,
 *   emoji) is a separator, and any run of separators is one `_`.
 * - The result starts and ends on a letter or a digit: no leading `-` (an
 *   option to a command line), no trailing `.` or space (Windows strips them),
 *   and none of either exists in the charset anyway.
 * - When nothing usable is left, or what is left is a device name (`CON`,
 *   `nul`, `COM1`), the folder is the avatar's id instead. Two avatars can
 *   share a folder (`Mia!` and `Mia?`); files stay unique through the counter.
 */
export function safeName(avatarName: string, avatarId: string): string {
  const own = reduceToSafe(avatarName);
  if (isSafeName(own)) return own;
  const byId = reduceToSafe(avatarId);
  return isSafeName(byId) ? byId : "avatar";
}

function reduceToSafe(raw: string): string {
  const ascii = raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_");
  const trimmed = (text: string) => text.replace(/^[_-]+|[_-]+$/g, "");
  return trimmed(trimmed(ascii).slice(0, 64));
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

/** The part of the filesystem a name claim needs; injected so tests can play other disks. */
export interface ExportNameFs {
  /** Creates the folder and any missing parents; fine when it exists. */
  mkdir(path: string): Promise<void>;
  /** Creates an empty file only if there is none (`wx`): rejects with `EEXIST` for any existing entry. */
  createExclusive(path: string): Promise<void>;
}

export const NODE_EXPORT_NAME_FS: ExportNameFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  createExclusive: async (path) => {
    const handle = await open(path, "wx");
    await handle.close();
  },
};

export interface ExportNameClaim {
  /** `<SafeName>/<date>_<kind>_<NNN>.mp4`, always a valid `RelativePath`. */
  relPath: string;
  /** The placeholder's place on this machine. */
  absPath: string;
  n: number;
}

export interface ClaimExportNameOptions {
  fs: ExportNameFs;
  /** The export folder. */
  root: string;
  /** From `safeName`; refused here if it is not one. */
  safeName: string;
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
  const { fs, root, date, kind } = options;
  if (!isSafeName(options.safeName)) throw new Error("the export folder name is not a SafeName");
  if (!VideoKindToken.safeParse(kind).success) throw new Error("the export kind is not a kind token");
  // The first candidate is checked against the contract before any disk is touched.
  const first = `${options.safeName}/${exportFileName(date, kind, options.startAt ?? 1)}`;
  if (!RelativePath.safeParse(first).success) throw new Error("the export name is not a valid relative path");
  const folder = join(root, options.safeName);
  await fs.mkdir(folder);
  for (let n = options.startAt ?? 1; n <= MAX_COUNTER; n++) {
    const name = exportFileName(date, kind, n);
    const absPath = join(folder, name);
    try {
      await fs.createExclusive(absPath);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }
    return { relPath: `${options.safeName}/${name}`, absPath, n };
  }
  throw new Error("no free name is left in the export folder for today");
}
