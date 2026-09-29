import { randomBytes } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { hasErrorCode } from "./library/durableFs";

// Whether the export folder's volume folds letter case (Stage 3 plan, 3a.8b
// MUST): a property of the VOLUME, not of the platform. APFS can be formatted
// case-sensitive, a Linux folder can be casefolded, a Windows directory can be
// case-sensitive on its own. So it is measured: create a probe file and look
// for it again under a case-flipped name. The answer feeds `pathsOverlap` and
// `prepareExportFolder` (`/Export/Mia` must not be taken for `/export` on a
// case-sensitive disk, nor `mia` for `Mia` on a folding one).

/** The disk calls a probe makes; injected so a test can play both kinds of volume. */
export interface CaseProbeFs {
  /** Creates an empty file only if there is none (`wx`). */
  createExclusive(path: string): Promise<void>;
  /** Whether something answers to `path` (a `stat` that follows nothing it must not: the probe is a plain file). */
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Whether `path` is a folder now. A root that is not there yet is NOT probed through its parent: another folder can sit on another volume. */
  isDirectory(path: string): Promise<boolean>;
}

export const NODE_CASE_PROBE_FS: CaseProbeFs = {
  createExclusive: async (path) => {
    const handle = await open(path, "wx");
    await handle.close();
  },
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  },
  remove: (path) => rm(path),
  isDirectory: async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
      throw error;
    }
  },
};

/** Prefix of the probe file; it starts with `.studio-probe-`, so the open sweep collects a leftover 0-byte one. */
const PROBE_PREFIX = ".studio-probe-case-";

const defaultNewId = (): string => randomBytes(6).toString("hex");

/** A name whose case can be flipped: lowercase letters only after the prefix (a hex id made of digits alone would flip to itself). */
function probeName(id: string): string {
  const letters = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${PROBE_PREFIX}${letters}z`;
}

/**
 * Answers `isCaseInsensitive(root)` once per root and remembers it. The probe
 * runs in the root itself and nowhere else: a root that does not exist yet (the
 * default folder is created on first use) is not judged by its parent, which can be
 * another volume. If the root is not there, or the probe file cannot be created (a
 * read-only or full volume), the answer is `true`, the cautious one (more names count
 * as the same), and it is NOT remembered, so the next question asks the disk again.
 */
export class CaseSensitivityProbe {
  readonly #fs: CaseProbeFs;
  readonly #newId: () => string;
  readonly #log: (line: string) => void;
  readonly #answers = new Map<string, Promise<boolean | null>>();

  /** `log` gets the codes of a probe that could not be made (never a path). */
  constructor(fs: CaseProbeFs = NODE_CASE_PROBE_FS, newId: () => string = defaultNewId, log: (line: string) => void = () => undefined) {
    this.#fs = fs;
    this.#newId = newId;
    this.#log = log;
  }

  async isCaseInsensitive(root: string): Promise<boolean> {
    const key = nodePath.resolve(root);
    const cached = this.#answers.get(key);
    const answer = cached ?? this.#probe(key);
    if (cached === undefined) this.#answers.set(key, answer);
    const result = await answer;
    if (result === null) {
      // Not remembered: whatever went wrong may be gone at the next question.
      if (this.#answers.get(key) === answer) this.#answers.delete(key);
      return true;
    }
    return result;
  }

  /** True/false from the disk, or null when it could not be asked (a root that is not there yet, or a probe that could not be made). */
  async #probe(root: string): Promise<boolean | null> {
    const code = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error");
    try {
      // Only the root itself is probed: its parent may be another volume, with another answer.
      if (!(await this.#fs.isDirectory(root))) {
        this.#log("case probe: the export folder is not there yet; the cautious answer is used until it is");
        return null;
      }
    } catch (error) {
      this.#log(`case probe: the export folder could not be looked at (${code(error)})`);
      return null;
    }
    const name = probeName(this.#newId());
    const path = nodePath.join(root, name);
    try {
      await this.#fs.createExclusive(path);
    } catch (error) {
      this.#log(`case probe: the probe file could not be created (${code(error)})`);
      return null;
    }
    try {
      return await this.#fs.exists(nodePath.join(root, name.toUpperCase()));
    } catch (error) {
      this.#log(`case probe: the case-flipped name could not be looked up (${code(error)})`);
      return null;
    } finally {
      // A probe that cannot be removed is a 0-byte `.studio-probe-*`: the sweep on open collects it.
      await this.#fs.remove(path).catch((error: unknown) => this.#log(`case probe: the probe file could not be removed (${code(error)}); the next sweep takes it`));
    }
  }
}
