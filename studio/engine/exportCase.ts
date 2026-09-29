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
  /** `path` itself if it is a folder, otherwise its nearest parent that is. */
  nearestExistingFolder(path: string): Promise<string>;
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
  nearestExistingFolder: async (path) => {
    for (let at = nodePath.resolve(path); ; at = nodePath.dirname(at)) {
      try {
        if ((await stat(at)).isDirectory()) return at;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
      }
      if (nodePath.dirname(at) === at) return at;
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
 * runs in the root itself, or in its nearest existing parent when it does not
 * exist yet (the default folder is created on first use). If the probe file
 * cannot be created (a read-only or full volume) the answer is `true`, the
 * cautious one (more names count as the same), and it is NOT remembered, so the
 * next question asks the disk again.
 */
export class CaseSensitivityProbe {
  readonly #fs: CaseProbeFs;
  readonly #newId: () => string;
  readonly #answers = new Map<string, Promise<boolean | null>>();

  constructor(fs: CaseProbeFs = NODE_CASE_PROBE_FS, newId: () => string = defaultNewId) {
    this.#fs = fs;
    this.#newId = newId;
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

  /** True/false from the disk, or null when it could not be asked. */
  async #probe(root: string): Promise<boolean | null> {
    let folder: string;
    try {
      folder = await this.#fs.nearestExistingFolder(root);
    } catch {
      return null;
    }
    const name = probeName(this.#newId());
    const path = nodePath.join(folder, name);
    try {
      await this.#fs.createExclusive(path);
    } catch {
      return null;
    }
    try {
      return await this.#fs.exists(nodePath.join(folder, name.toUpperCase()));
    } catch {
      return null;
    } finally {
      // A probe that cannot be removed is a 0-byte `.studio-probe-*`: the sweep on open collects it.
      await this.#fs.remove(path).catch(() => undefined);
    }
  }
}
