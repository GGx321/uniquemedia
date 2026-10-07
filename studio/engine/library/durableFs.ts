import { randomBytes } from "node:crypto";
import { open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";
import type { z } from "zod";
import { LibraryError } from "./errors";
import { runExclusive } from "./keyedMutex";
import { renameWithRetry } from "./renameRetry";

export interface AtomicWriteOptions {
  /** Test seam: runs after the temp file is durable and before the rename.
   *  Throwing here leaves the disk exactly as a crash at that point would. */
  beforeRename?: (finalPath: string) => void | Promise<void>;
  /** Test seam: runs after the rename and before the folder's flush. Throwing here is a flush that failed with the new file already in place. */
  afterRename?: (finalPath: string) => void | Promise<void>;
}

/** Temp names are dot-prefixed siblings ending in `.tmp`, so startup
 *  reconciliation can recognise (and quarantine) leftovers of a crash. */
export function tempSiblingPath(finalPath: string): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.${randomBytes(6).toString("hex")}.tmp`);
}

export function isTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".tmp");
}

/**
 * Creates `path` (must not exist), writes `data` and fsyncs it.
 *
 * Durability note: on macOS a plain fsync() does not flush the drive's write
 * cache. Under Electron this is covered — libuv's uv__fs_fsync (behind
 * FileHandle.sync) issues fcntl(F_FULLFSYNC), falling back to F_BARRIERFSYNC
 * and then fsync. Bun, where the tests run, has its own fs implementation and
 * is not relied on for durability. As a second line of defence every photo's
 * size and sha256 are re-checked on open.
 */
export async function writeFileDurable(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes a file's data to disk. `r+` because Windows needs write access to flush. */
export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes a rename or a new directory entry durable. Skipped on Windows: a
 *  directory opens there, but its fsync fails with EPERM (as the Windows CI
 *  runner showed), so Windows relies on the file's own fsync and on NTFS
 *  journaling the rename or new entry (as money/ledger.ts does). */
export async function fsyncDir(dir: string): Promise<void> {
  if (platform() === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Temp file in the same directory + fsync + rename + fsync of the directory:
 *  a reader (or a restart) sees either the old content or the new, never a mix. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const temp = tempSiblingPath(path);
  try {
    await writeFileDurable(temp, data);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await options.beforeRename?.(path);
  await renameWithRetry(temp, path);
  await options.afterRename?.(path);
  await fsyncDir(dirname(path));
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export interface LogAccessOptions {
  /** Runs inside the log's lock, before the access; throw to cancel it. */
  guard?: () => Promise<void>;
}

// One queue per log file for appends and reads alike: healing a torn tail
// reads, moves and truncates, and a reader must neither see a line that is
// still being written nor miss an append issued before it.
function logLockKey(path: string): string {
  return `log:${path}`;
}

/**
 * Appends one JSON line and fsyncs it. A line is committed once its newline
 * is on disk; a tail without one is the remains of a crash mid-append. That
 * tail is moved to `<file>.torn` (kept, never discarded) and cut off first —
 * otherwise the new line would be glued onto it and become unreadable too.
 */
export async function appendJsonLine(path: string, value: unknown, options: LogAccessOptions = {}): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  // Queued synchronously, before any await, so appends land in call order.
  await runExclusive(logLockKey(path), async () => {
    await options.guard?.();
    const isNew = await healTornTail(path);
    await appendDurable(path, line);
    if (isNew) await fsyncDir(dirname(path));
  });
}

/**
 * Moves a tail without a newline to `<path>.torn` (durably, first) and cuts
 * it off. Uses its own `r+` handle: on Windows an append-mode handle has no
 * FILE_WRITE_DATA right, so it cannot truncate. Returns true when the file
 * does not exist yet, i.e. the append will create a new directory entry.
 */
async function healTornTail(path: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r+");
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    const content = await readFile(path);
    const cut = content.lastIndexOf(0x0a) + 1;
    await appendDurable(`${path}.torn`, Buffer.concat([content.subarray(cut), Buffer.from("\n")]));
    await handle.truncate(cut);
    await handle.sync();
    return false;
  } finally {
    await handle.close();
  }
}

async function appendDurable(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.appendFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface JsonlRead<T> {
  entries: T[];
  /** The text after the last newline, if any: an append a crash cut short. */
  torn: string | null;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Reads and parses a JSON file; a missing file or bad JSON is a result, not a throw. */
export async function readJsonFile(path: string): Promise<Parsed<unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { ok: false, detail: `${path} is missing` };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, detail: `${path} is not valid JSON` };
  }
}

/** How long a paid write waits before its one retry, so a file an antivirus holds for a moment (EBUSY, EPERM on Windows) can be let go. */
export const RETRY_PAUSE_MS = 200;

/** The pause before a retry; a plain timer, never a busy loop. */
export function pauseBeforeRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
}

/** A path no file can be read from: it is not there (ENOENT) or a part of it is not a folder (ENOTDIR). */
export function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

/** A record's place held by a folder: nothing a read could ever return, so it is a record that is not usable, not an OS failure that may pass. */
export function isFolderInPlace(error: unknown): boolean {
  return hasErrorCode(error, "EISDIR");
}

/**
 * How a record read ended, told apart because the callers act differently. `missing`: no such file. `invalid`: the file cannot be a record (not JSON, a
 * folder in its place). `io`: the OS refused the read (EIO, EMFILE, EBUSY under an antivirus, EACCES, EPERM, a cloud placeholder that cannot be
 * fetched): nothing is known of the record, `error` is what the OS said. A listing counts `io` as unreadable; a change rethrows `error`; a check that
 * decides whether a new write may go ahead refuses.
 */
export type RecordRead = { ok: true; value: unknown } | { ok: false; reason: "missing" | "invalid" } | { ok: false; reason: "io"; error: unknown };

/** Reads and parses a record file; never throws. `beforeRead` is a test seam: what it throws is what the read threw. */
export async function readRecordFile(path: string, beforeRead?: (path: string) => void | Promise<void>): Promise<RecordRead> {
  let text: string;
  try {
    await beforeRead?.(path);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return { ok: false, reason: "missing" };
    if (isFolderInPlace(error)) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "io", error };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** The names in a folder, or the OS's error when it cannot be listed (not a folder, no permission, EMFILE); a folder that is not there is empty. `beforeList` is a test seam. */
export async function readFolderNames(dir: string, beforeList?: (dir: string) => void | Promise<void>): Promise<{ ok: true; names: string[] } | { ok: false; error: unknown }> {
  try {
    await beforeList?.(dir);
    return { ok: true, names: await readdir(dir) };
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? { ok: true, names: [] } : { ok: false, error };
  }
}

/** Reads a JSONL log. A torn last line is reported, not returned; any
 *  complete line that is not valid JSON or fails `schema` is corruption and
 *  throws, since it cannot be the result of a crash. Sees every append issued
 *  before it. */
export function readJsonl<T>(path: string, schema: z.ZodType<T>, options: LogAccessOptions = {}): Promise<JsonlRead<T>> {
  return runExclusive(logLockKey(path), async () => {
    await options.guard?.();
    return readJsonlNow(path, schema);
  });
}

async function readJsonlNow<T>(path: string, schema: z.ZodType<T>): Promise<JsonlRead<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { entries: [], torn: null };
    throw error;
  }
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const entries: T[] = [];
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LibraryError("corrupt-log", `${path}:${index + 1} is not valid JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new LibraryError("corrupt-log", `${path}:${index + 1} failed validation: ${result.error.message}`);
    }
    entries.push(result.data);
  }
  return { entries, torn: tail === "" ? null : tail };
}
