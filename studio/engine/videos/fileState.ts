import * as nodePath from "node:path";
import { dirname, join } from "node:path";
import type { FileState } from "../../shared/engine";
import { placeOf } from "../exportName";
import { hasErrorCode } from "../library/durableFs";
import { NODE_COMMIT_FS, type CommitFs, type FileFacts } from "./commitFs";
import { hashFile } from "./fileBytes";
import type { VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";
import { RootMarkerCheck } from "./rootMarker";

// Where a record's file stands (`FileState`, derived on read, never stored):
//
//   present   the root matches and the size matches (and, when it had to be looked at, the sha256)
//   missing   the root matches and there is no file (the owner deleted or moved it)
//   changed   a different size or sha256, or the path no longer leads to a plain file of ours
//             (a link where the folder or file was, a folder where the file was)
//   elsewhere the record names another export root, or the root at that path does not hold that root's marker
//             (an empty folder at the same path, an unplugged drive's mount point), or there is no usable root to look in
//
// COST. A listing may show hundreds of records, so the answer is bounded:
//   1. one `lstat` per record: absent -> missing, wrong size -> changed;
//   2. the size matches. The record stores the file's mtime (whole ms, taken at commit; a rename keeps it):
//      an equal mtime is "unchanged" with no read at all;
//   3. otherwise (no stored mtime, or it moved: the owner copied the folder) the file is hashed, once:
//      a match is remembered against the file's (size, mtime, inode, device), so the next listing is step 2 again;
//   4. hashing is capped per listing by a shared `HashBudget` (32 MiB by default: a few files). Once it is spent a size
//      match reads as `present` without a hash, which is what the contract's `present` means, and is not remembered.
// A caller that must NOT act on a guess (the avatar delete, which moves files to the Trash) passes `whenSpent: "unchecked"`: a size match that the spent
// budget could not hash is then `unchecked`, never `present`.
// `verify: "full"` skips 2-4 and always hashes: it is what a destructive action (delete) asks for, so no cheap answer
// ever decides to remove a file.
//
// A vanished or unplugged root reads `elsewhere`, not `missing`: "the file is gone" would be a claim nobody checked,
// and would invite «Удалить запись» for a drive that is merely not there. (The plan left this to 3a.8b.)
//
// A disk error other than "not there" rejects: the caller decides what it shows.

export interface HashBudget {
  remaining: number;
}

export const DEFAULT_HASH_BUDGET_BYTES = 32 * 1024 * 1024;

export function newHashBudget(bytes: number = DEFAULT_HASH_BUDGET_BYTES): HashBudget {
  return { remaining: bytes };
}

export interface FileStateDeps {
  readonly fs?: CommitFs;
  readonly hashFile?: (path: string) => Promise<string>;
}

export type Verification = "cheap" | "full";

export interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: string;
  readonly dev: string;
}

const stampOf = (facts: FileFacts): Stamp => ({ size: facts.size, mtimeMs: Math.floor(facts.mtimeMs), ino: facts.ino, dev: facts.dev });
const sameStamp = (a: Stamp, b: Stamp): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;

async function lstatOrNull(fs: CommitFs, path: string): Promise<FileFacts | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

/** The place a record's file should be, if the record and the root agree. Never leaves the root: the relative path is validated by the record's schema. */
export function recordFilePath(record: VideoRecord, root: ExportRootRef): { folder: string; file: string } {
  const [folderName, fileName] = record.file.relPath.split("/");
  if (folderName === undefined || fileName === undefined) throw new TypeError("a record's relPath is <folder>/<file>");
  const folder = join(root.root, folderName);
  return { folder, file: join(folder, fileName) };
}

export class FileStateChecker {
  readonly #fs: CommitFs;
  readonly #hash: (path: string) => Promise<string>;
  /** The last (size, mtime, inode, device) a file was found to match its record's sha256 at, per video. */
  readonly #verified = new Map<string, Stamp>();
  readonly #markers: RootMarkerCheck;

  constructor(deps: FileStateDeps = {}) {
    this.#fs = deps.fs ?? NODE_COMMIT_FS;
    this.#hash = deps.hashFile ?? hashFile;
    this.#markers = new RootMarkerCheck(this.#fs);
  }

  /** The (size, mtime, inode, device) of the file the last successful hash of this video was taken over: what a delete must find again right before it unlinks. */
  verifiedStamp(videoId: string): Stamp | undefined {
    return this.#verified.get(videoId);
  }

  async check(record: VideoRecord, root: ExportRootRef | null, options: { verify: Verification; budget?: HashBudget; whenSpent?: "present" | "unchecked" }): Promise<FileState> {
    if (root === null || record.file.rootId !== root.rootId) return "elsewhere";
    // The id alone proves nothing: the marker at this path must hold it (an empty folder there is another root).
    if (!(await this.#markers.matches(root.root, root.rootId))) return "elsewhere";
    const fs = this.#fs;
    const { folder, file } = recordFilePath(record, root);

    const folderFacts = await lstatOrNull(fs, folder);
    if (folderFacts === null) return "missing";
    if (folderFacts.isSymbolicLink || !folderFacts.isDirectory) return "changed";
    const [realFolder, realRoot] = [await fs.realpath(folder), await fs.realpath(root.root)];
    if (placeOf(nodePath, dirname(realFolder), root.caseInsensitive) !== placeOf(nodePath, realRoot, root.caseInsensitive)) return "changed";

    const facts = await lstatOrNull(fs, file);
    if (facts === null) return "missing";
    if (facts.isSymbolicLink || !facts.isFile) return "changed";
    if (facts.size !== record.file.bytes) return "changed";

    const stamp = stampOf(facts);
    if (options.verify === "cheap") {
      if (record.file.mtimeMs !== undefined && record.file.mtimeMs === stamp.mtimeMs) return "present";
      const known = this.#verified.get(record.id);
      if (known !== undefined && sameStamp(known, stamp)) return "present";
      const budget = options.budget;
      if (budget !== undefined) {
        // Spent: a size match alone reads `present` (what the contract means by it for a listing), unless the caller must not guess (a delete): then it is `unchecked`.
        if (budget.remaining < facts.size) return options.whenSpent ?? "present";
        budget.remaining -= facts.size;
      }
    }
    const digest = await this.#hash(file);
    // The file that was hashed must be the file that is there now: one replaced while it was read is `changed`.
    const after = await lstatOrNull(fs, file);
    if (after === null || after.isSymbolicLink || !after.isFile || !sameStamp(stamp, stampOf(after))) {
      this.#verified.delete(record.id);
      return "changed";
    }
    if (digest === record.file.sha256) {
      this.#verified.set(record.id, stamp);
      return "present";
    }
    this.#verified.delete(record.id);
    return "changed";
  }
}
