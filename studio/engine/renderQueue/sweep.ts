import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// The leftovers of renders that a crash, a kill or a cancel could not clean:
// job folders in `userData/render-tmp` and `.studio-part-*` temps in the
// export folder. Both sweeps are TOLERANT: a locked file (Windows keeps one for
// a moment after its process died: EBUSY, EPERM) is retried a few times and
// then skipped, to be caught by the next start; nothing here throws.

export interface SweepResult {
  /** Absolute paths that are gone. */
  readonly removed: string[];
  /** What is still there and why: the error code, or `UNKNOWN`. Logged by the caller; never a failure. */
  readonly skipped: Array<{ path: string; code: string }>;
}

export interface SweepDeps {
  /** Removes one path (a file, or a folder with what it holds). `rm` unless a test plays a locked one. */
  readonly remove?: (path: string) => Promise<void>;
  /** Waits between two tries of a locked entry. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Tries per locked entry, with a growing wait (100, 200, 300, 400 ms) between them. */
const ATTEMPTS = 5;
const RETRY_STEP_MS = 100;
/** What a file another process still holds reports. Anything else is not worth waiting for. */
const LOCK_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}

/** Removes `path`, retrying a lock; the error code of the last failure when it stays. */
async function removeTolerant(path: string, remove: (path: string) => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(path);
      return null;
    } catch (error) {
      const code = codeOf(error);
      if (!LOCK_CODES.has(code) || attempt >= ATTEMPTS) return code;
      await sleep(RETRY_STEP_MS * attempt);
    }
  }
}

async function listOrNothing(dir: string, result: SweepResult): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = codeOf(error);
    if (code !== "ENOENT") result.skipped.push({ path: dir, code });
    return null;
  }
}

/**
 * Removes everything in `userData/render-tmp` (the folder itself stays): at the
 * engine's start no job is running, so every job folder is a leftover. A
 * folder that does not exist yet is nothing to do.
 */
export async function sweepRenderTmp(dir: string, deps: SweepDeps = {}): Promise<SweepResult> {
  const remove = deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const sleep = deps.sleep ?? defaultSleep;
  const result: SweepResult = { removed: [], skipped: [] };

  const entries = await listOrNothing(dir, result);
  for (const entry of entries ?? []) {
    const path = join(dir, entry.name);
    const failure = await removeTolerant(path, remove, sleep);
    if (failure === null) result.removed.push(path);
    else result.skipped.push({ path, code: failure });
  }
  return result;
}

/** The temp a render writes on the export volume: `.studio-part-<jobId>.mp4`. */
const PART_NAME = /^\.studio-part-[A-Za-z0-9_-]+\.mp4$/;

export interface SweepPartsDeps extends SweepDeps {
  /** Absolute paths of temps that belong to renders still running: kept. */
  readonly except?: ReadonlySet<string>;
}

/**
 * Removes the `.studio-part-*.mp4` temps of the export folder: in the root and
 * in each folder directly under it (`<root>/<SafeName>/`, where renders write).
 * Only a regular file with that exact name shape goes: never a folder, never a
 * symlink, never a folder that is a symlink, never anything deeper. A root
 * that is gone (an unplugged drive) is nothing to do.
 */
export async function sweepPartFiles(exportRoot: string, deps: SweepPartsDeps = {}): Promise<SweepResult> {
  const remove = deps.remove ?? ((path: string) => rm(path, { force: true }));
  const sleep = deps.sleep ?? defaultSleep;
  const except = deps.except ?? new Set<string>();
  const result: SweepResult = { removed: [], skipped: [] };

  /** Sweeps one folder; the names of the real folders in it (a symlink to one is not a folder here). */
  const sweepFolder = async (folder: string): Promise<string[]> => {
    const entries = await listOrNothing(folder, result);
    const folders: string[] = [];
    for (const entry of entries ?? []) {
      if (entry.isDirectory()) folders.push(entry.name);
      if (!entry.isFile() || !PART_NAME.test(entry.name)) continue;
      const path = join(folder, entry.name);
      if (except.has(path)) continue;
      const failure = await removeTolerant(path, remove, sleep);
      if (failure === null) result.removed.push(path);
      else result.skipped.push({ path, code: failure });
    }
    return folders;
  };

  const subfolders = await sweepFolder(exportRoot);
  for (const name of subfolders) await sweepFolder(join(exportRoot, name));
  return result;
}
