import { constants } from "node:fs";
import { copyFile, mkdir, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fsyncDir, fsyncFile, hasErrorCode } from "./durableFs";
import { QUARANTINE_DIR } from "./layout";
import { renameWithRetry } from "./renameRetry";

export type QuarantineReason =
  | "orphan-image"
  | "orphan-sidecar"
  | "invalid-sidecar"
  | "invalid-image"
  | "invalid-manifest"
  | "temp-file"
  /** A file in `media/` with the name of a stored one and no record: the owner's own, or half of a pair a sync has not finished. */
  | "orphan-media"
  /** 3e.2: a file among an avatar's video records that cannot be read as one, moved aside by «Убрать повреждённую запись». */
  | "invalid-video-record"
  /** 3e.2: a reject log with a line that cannot be read, COPIED aside by «Восстановить отметки» before it is rebuilt. */
  | "invalid-reject-log";

export interface QuarantineEntry {
  /** Paths relative to the library root. */
  from: string;
  to: string;
  reason: QuarantineReason;
  detail?: string;
}

/** Test seam: how a directory is flushed (durableFs.fsyncDir, a no-op on Windows). */
export interface QuarantineDurability {
  fsyncDir(dir: string): Promise<void>;
}

/**
 * The file WAS moved into the quarantine, and the flush of a folder that followed failed: the move happened (its entry is kept), only its durability is in doubt. A caller
 * that counts what was set aside counts it; a caller that only needs «did it fail» treats it as the error it is.
 */
export class QuarantineNotFlushed extends Error {
  constructor(options?: { cause: unknown }) {
    super("the file was set aside but a folder flush failed", options);
    this.name = "QuarantineNotFlushed";
  }
}

/** Moves things a crash or a hand edit left behind into
 *  `quarantine/<timestamp>/<same relative path>`. Nothing is ever deleted, and what is set aside is durable: every folder it
 *  makes is flushed in its parent, and a move is flushed in the folder it left and the folder it entered (3e.2 review). */
export class Quarantine {
  readonly entries: QuarantineEntry[] = [];
  readonly #root: string;
  readonly #now: () => Date;
  readonly #durable: QuarantineDurability;
  #dir: string | null = null;

  constructor(root: string, now: () => Date, durable: QuarantineDurability = { fsyncDir }) {
    this.#root = root;
    this.#now = now;
    this.#durable = durable;
  }

  async move(path: string, reason: QuarantineReason, detail?: string): Promise<void> {
    const dir = await this.#ensureDir();
    const from = relative(this.#root, path);
    const target = join(dir, from);
    try {
      await this.#makeFolders(dirname(target));
      await renameWithRetry(path, target);
    } catch (error) {
      await this.#dropIfEmpty(dirname(target));
      throw error;
    }
    // From here the file is in the quarantine: the entry is kept whatever the flushes do.
    this.entries.push({ from, to: relative(this.#root, target), reason, ...(detail === undefined ? {} : { detail }) });
    try {
      await this.#durable.fsyncDir(dirname(target));
      await this.#durable.fsyncDir(dirname(path));
    } catch (error) {
      throw new QuarantineNotFlushed({ cause: error });
    }
  }

  /** A move that failed before it moved anything leaves no empty stamp folder behind (quiet: an empty folder is harmless, only untidy). */
  async #dropIfEmpty(targetDir: string): Promise<void> {
    if (this.entries.length > 0 || this.#dir === null) return;
    const stamp = this.#dir;
    // From the folder the file would have gone into, up to the stamp: each `rmdir` only removes an empty one.
    for (let dir = targetDir; dir.startsWith(stamp); dir = dirname(dir)) {
      await rmdir(dir).catch(() => undefined);
      if (dir === stamp) break;
    }
    this.#dir = null;
  }

  /**
   * COPIES `path` to the same place under the quarantine, durably (the copy and its folder are flushed), and never over an
   * existing file. For a file that is about to be replaced rather than moved: the original stays until the caller replaces it.
   */
  async copy(path: string, reason: QuarantineReason, detail?: string): Promise<void> {
    const dir = await this.#ensureDir();
    const from = relative(this.#root, path);
    const target = join(dir, from);
    await this.#makeFolders(dirname(target));
    await copyFile(path, target, constants.COPYFILE_EXCL);
    await fsyncFile(target);
    await this.#durable.fsyncDir(dirname(target));
    this.entries.push({ from, to: relative(this.#root, target), reason, ...(detail === undefined ? {} : { detail }) });
  }

  async #ensureDir(): Promise<string> {
    if (this.#dir !== null) return this.#dir;
    const parent = join(this.#root, QUARANTINE_DIR);
    await this.#makeFolders(parent);
    // Windows forbids ":" in file names.
    const stamp = this.#now().toISOString().replace(/[:.]/g, "-");
    for (let n = 0; ; n++) {
      const candidate = join(parent, n === 0 ? stamp : `${stamp}-${n}`);
      try {
        await mkdir(candidate);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        continue;
      }
      await this.#durable.fsyncDir(parent);
      this.#dir = candidate;
      return candidate;
    }
  }

  /** `mkdir -p dir`, then a flush of the parent of every folder it made (top down), so each new entry survives a crash. */
  async #makeFolders(dir: string): Promise<void> {
    const first = await mkdir(dir, { recursive: true });
    if (first === undefined) return;
    const parents: string[] = [];
    for (let made = dir; ; made = dirname(made)) {
      parents.push(dirname(made));
      if (made === first || dirname(made) === made) break;
    }
    for (const parent of parents.reverse()) await this.#durable.fsyncDir(parent);
  }
}
