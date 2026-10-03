import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
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
    await this.#makeFolders(dirname(target));
    await renameWithRetry(path, target);
    await this.#durable.fsyncDir(dirname(target));
    await this.#durable.fsyncDir(dirname(path));
    this.entries.push({ from, to: relative(this.#root, target), reason, ...(detail === undefined ? {} : { detail }) });
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
