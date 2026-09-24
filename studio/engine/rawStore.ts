import { Buffer } from "node:buffer";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fsyncDir } from "./library/durableFs";
import { RAW_PREFIX_BYTES } from "./openrouter/transport";

// userData/raw: bodies of paid answers the engine could not use (already
// redacted by the client), and a paid descriptor whose draft could not be
// written. Evidence for the owner, next to the ledger, so it outlives a
// library move; bounded in size and count.

/** A body is kept up to this many bytes: the client's own 64 KiB prefix of an oversized body, with its note, fits whole. */
export const RAW_KEEP_BYTES = RAW_PREFIX_BYTES + 4_096;
/** The folder keeps at most this many bodies; past it the oldest go. */
export const RAW_MAX_FILES = 200;

/** The id in base64url: ids that differ only in characters a file name cannot hold stay apart, and the name decodes back. */
export function rawFileName(id: string): string {
  return `${Buffer.from(id, "utf8").toString("base64url")}.txt`;
}

function kept(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RAW_KEEP_BYTES) return bytes;
  const note = `\n[truncated: the body was ${bytes.length} bytes; the first ${RAW_KEEP_BYTES} are kept]\n`;
  return Buffer.concat([bytes.subarray(0, RAW_KEEP_BYTES), Buffer.from(note, "utf8")]);
}

/**
 * Writes one body under its id, never over an existing one (a second save of
 * an id fails with EEXIST), fsynced before it resolves; then removes the
 * oldest bodies past `maxFiles`, never the one just written.
 */
export async function saveRawBody(dir: string, id: string, text: string, opts: { maxFiles?: number } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = rawFileName(id);
  const handle = await open(join(dir, name), "wx");
  try {
    await handle.writeFile(kept(text));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDir(dir);
  await rotate(dir, name, opts.maxFiles ?? RAW_MAX_FILES);
}

async function rotate(dir: string, keep: string, maxFiles: number): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".txt") && name !== keep);
  const excess = names.length + 1 - maxFiles;
  if (excess <= 0) return;
  const aged = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  aged.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
  for (const { name } of aged.slice(0, excess)) await rm(join(dir, name), { force: true });
}
