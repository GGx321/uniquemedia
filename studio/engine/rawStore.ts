import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fsyncDir } from "./library/durableFs";
import { RAW_KEEP_BYTES_CHAT, RAW_KEEP_BYTES_IMAGE, RAW_PREFIX_BYTES } from "./openrouter/transport";

// userData/raw: bodies of paid answers the engine could not use (already
// redacted by the client), and a paid descriptor whose draft could not be
// written. Evidence for the owner, next to the ledger, so it outlives a
// library move; bounded in size and count.
//
// The client's own string/key redaction (openrouter/redact.ts) only shrinks
// values it recognises as text: an image sent as an array of byte numbers,
// or as many short base64 chunks each under its 256-char string threshold,
// survives it untouched. This is the last line of defence (invariant 8): no
// body kept on disk holds more than a small, fixed prefix, whatever shape
// escaped redaction. Chat, descriptor and age-check attempts (through the
// OpenRouter client) pass their own cap, RAW_KEEP_BYTES_CHAT — text worth
// keeping longer than an image, but still bounded, not this store's own
// (larger) default; an image attempt passes its own tighter one,
// RAW_KEEP_BYTES_IMAGE (image.ts), since a usable image is never unusable
// text worth keeping long. RAW_KEEP_BYTES, this store's own default, applies
// only to a caller that bypasses the client and calls saveRawBody directly
// with no keepBytes at all — e.g. a paid descriptor kept here because the
// draft's own write failed (engine.ts): our own short JSON, never an
// attacker-controlled body, so the larger default costs nothing in practice.

/** Default cap for a saved body: the client's own 64 KiB prefix of an oversized chat/descriptor/age-check body, with its note, fits whole. */
export const RAW_KEEP_BYTES = RAW_PREFIX_BYTES + 4_096;
/** Cap for an image attempt's saved body: image.ts's own scrub already strips recognisable image data; this is the last-line-of-defence cap for whatever slips through it. Re-exported for callers that only know rawStore.ts (the constant itself lives in openrouter/transport.ts, see its comment). */
export { RAW_KEEP_BYTES_IMAGE };
/** Cap for a chat/descriptor/age-check attempt's saved body (M7 leftover). Re-exported for callers that only know rawStore.ts (the constant itself lives in openrouter/transport.ts, see its comment). */
export { RAW_KEEP_BYTES_CHAT };
/** The folder keeps at most this many bodies; past it the oldest go. */
export const RAW_MAX_FILES = 200;

/** The id in base64url: ids that differ only in characters a file name cannot hold stay apart, and the name decodes back. */
export function rawFileName(id: string): string {
  return `${Buffer.from(id, "utf8").toString("base64url")}.txt`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The largest prefix of `bytes`, at most `max` bytes long, that ends on a
 * whole UTF-8 character. A continuation byte (`10xxxxxx`) right at the cut
 * means the character that started earlier is not finished within the
 * prefix: the cut backs up to drop that whole character rather than split it.
 */
function utf8SafePrefixLength(bytes: Buffer, max: number): number {
  if (bytes.length <= max) return bytes.length;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return end;
}

function kept(text: string, keepBytes: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= keepBytes) return bytes;
  const cut = utf8SafePrefixLength(bytes, keepBytes);
  // "the redacted body": this length and hash describe what this function
  // received, which for an already-truncated transport body is not the true
  // original response size — never claimed as such.
  const note = `\n[truncated: the redacted body was ${bytes.length} bytes, sha256 ${sha256Hex(bytes)} of the redacted body; the first ${cut} are kept]\n`;
  return Buffer.concat([bytes.subarray(0, cut), Buffer.from(note, "utf8")]);
}

/**
 * Writes one body under its id, never over an existing one (a second save of
 * an id fails with EEXIST), fsynced before it resolves; then removes the
 * oldest bodies past `maxFiles`, never the one just written. `keepBytes`
 * defaults to `RAW_KEEP_BYTES`; an image attempt passes `RAW_KEEP_BYTES_IMAGE`.
 */
export async function saveRawBody(dir: string, id: string, text: string, opts: { maxFiles?: number; keepBytes?: number } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = rawFileName(id);
  const handle = await open(join(dir, name), "wx");
  try {
    await handle.writeFile(kept(text, opts.keepBytes ?? RAW_KEEP_BYTES));
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
