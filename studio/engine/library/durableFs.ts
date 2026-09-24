import { randomBytes } from "node:crypto";
import { open, readFile, rm, type FileHandle } from "node:fs/promises";
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
