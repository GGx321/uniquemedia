import { join } from "node:path";
import { EXPORT_MARKER_FILE, ExportMarker, readSmallRegularFile } from "../exportRoot";
import { hasErrorCode } from "../library/durableFs";
import { openRegularNoFollow, type OpenRegularOptions } from "../library/openRegular";
import { NODE_COMMIT_FS, type CommitFs, type FileFacts } from "./commitFs";

// A record names its file by the export root's IDENTITY (`rootId`), and the identity lives in the
// root's marker file. Trusting the id a record remembers without looking at the marker would let an
// empty folder at the same path (an unplugged drive's mount point, a re-created folder) read as "the
// same root with nothing in it": intents would be dropped as `no-file`, records read `missing`.
// So a root matches only when its marker is there, is a plain file, and holds that id.

const MAX_MARKER_BYTES = 4096;

const stampOf = (facts: FileFacts): string => `${facts.dev}:${facts.ino}:${facts.size}:${facts.mtimeMs}`;

/** The same read as `readSmallRegularFile`, but a marker that has a second link is read too: only for healing an interrupted publish. */
async function readLinkedMarker(path: string, open: OpenRegularOptions): Promise<string> {
  const handle = await openRegularNoFollow(path, open);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MARKER_BYTES) throw new Error("not a small regular file");
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_MARKER_BYTES + 1, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The root id in `<root>/.studio-export.json`, or null when there is no readable, valid marker (never throws for a disk problem).
 * A marker with a second hard link is refused (it could be another root's marker linked in) unless `allowLinked` says the caller has
 * found the interrupted publish's own `.tmp-*` sibling on the same inode.
 */
export async function readRootId(root: string, options: { allowLinked?: boolean; open?: OpenRegularOptions } = {}): Promise<{ rootId: string } | { rootId: null; code: string }> {
  let text: string;
  try {
    const path = join(root, EXPORT_MARKER_FILE);
    text = options.allowLinked === true ? await readLinkedMarker(path, options.open ?? {}) : await readSmallRegularFile(path, MAX_MARKER_BYTES, options.open);
  } catch (error) {
    return { rootId: null, code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rootId: null, code: "invalid" };
  }
  const parsed = ExportMarker.safeParse(value);
  return parsed.success ? { rootId: parsed.data.rootId } : { rootId: null, code: "invalid" };
}

/** Answers "does this root's marker hold this id" with one `lstat`; the marker is read again only when it changed. */
export class RootMarkerCheck {
  readonly #fs: CommitFs;
  readonly #seen = new Map<string, { stamp: string; rootId: string | null }>();

  constructor(fs: CommitFs = NODE_COMMIT_FS) {
    this.#fs = fs;
  }

  async matches(root: string, rootId: string): Promise<boolean> {
    let facts: FileFacts;
    try {
      facts = await this.#fs.lstat(join(root, EXPORT_MARKER_FILE));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
      throw error;
    }
    if (!facts.isFile || facts.isSymbolicLink) return false;
    const stamp = stampOf(facts);
    const known = this.#seen.get(root);
    if (known !== undefined && known.stamp === stamp) return known.rootId === rootId;
    const read = await readRootId(root);
    this.#seen.set(root, { stamp, rootId: read.rootId });
    return read.rootId === rootId;
  }
}
