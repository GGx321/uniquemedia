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

/** Moves things a crash or a hand edit left behind into
 *  `quarantine/<timestamp>/<same relative path>`. Nothing is ever deleted. */
export class Quarantine {
  readonly entries: QuarantineEntry[] = [];
  readonly #root: string;
  readonly #now: () => Date;
  #dir: string | null = null;

  constructor(root: string, now: () => Date) {
    this.#root = root;
    this.#now = now;
  }

  async move(path: string, reason: QuarantineReason, detail?: string): Promise<void> {
    const dir = await this.#ensureDir();
    const from = relative(this.#root, path);
    const target = join(dir, from);
    await mkdir(dirname(target), { recursive: true });
    await renameWithRetry(path, target);
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
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target, constants.COPYFILE_EXCL);
    await fsyncFile(target);
    await fsyncDir(dirname(target));
    this.entries.push({ from, to: relative(this.#root, target), reason, ...(detail === undefined ? {} : { detail }) });
  }

  async #ensureDir(): Promise<string> {
    if (this.#dir !== null) return this.#dir;
    const parent = join(this.#root, QUARANTINE_DIR);
    await mkdir(parent, { recursive: true });
    // Windows forbids ":" in file names.
    const stamp = this.#now().toISOString().replace(/[:.]/g, "-");
    for (let n = 0; ; n++) {
      const candidate = join(parent, n === 0 ? stamp : `${stamp}-${n}`);
      try {
        await mkdir(candidate);
        this.#dir = candidate;
        return candidate;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
    }
  }
}
