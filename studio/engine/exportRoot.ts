import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import * as nodePath from "node:path";
import { z } from "zod";
import { ExportStatus, Id, type ExportUnavailableReason } from "../shared/engine";
import { hasErrorCode } from "./library/durableFs";
import { openRegularNoFollow, type OpenRegularOptions } from "./library/openRegular";

// The export folder «Готовые видео» (Stage 3 plan, "Outputs and export" and
// invariant 35): the check made BEFORE a render is queued, and the root marker
// that gives the folder an identity. The disk is reached through an injected
// `ExportRootFs`, so every refusal can be played in a test.

/** The root's identity file: `<exportRoot>/.studio-export.json`. */
export const EXPORT_MARKER_FILE = ".studio-export.json";
const MARKER_LINK_RETRIES = 10;
const MARKER_LINK_RETRY_MS = 10;
/**
 * A marker is a few short fields; a bigger file is not ours. The format constraint for every layout,
 * present and future: plain UTF-8 JSON, no BOM, at most this many bytes. A layout that outgrows it
 * would have to read its version before applying the cap, which is a change to this reader.
 */
const MAX_MARKER_BYTES = 4096;

/** Version of the marker's own layout. A build that meets a higher one refuses it as `newer-marker` and never touches it. */
export const EXPORT_MARKER_VERSION = 1;

/**
 * Loose on purpose: a later build of the same version may add a field, and an
 * older one must still read the root id. Unknown keys are ignored, and the file
 * is never rewritten.
 */
export const ExportMarker = z.looseObject({ schemaVersion: z.literal(EXPORT_MARKER_VERSION), rootId: Id, createdAt: z.iso.datetime() });
export type ExportMarker = z.infer<typeof ExportMarker>;

export interface ExportRootFs {
  /** Follows symlinks. Rejects with ENOENT / ENOTDIR like `fs.stat`. */
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
  /** Creates the folder and any missing parents. */
  mkdirp(path: string): Promise<void>;
  /** Reads a regular file of at most `maxBytes`; rejects for anything else (a directory, a bigger file) and with ENOENT when absent. */
  readSmallFile(path: string, maxBytes: number): Promise<string>;
  /** Writes a new file (`wx`) and flushes it; rejects with EEXIST when there is one. For the probe. */
  createExclusive(path: string, text: string): Promise<void>;
  /**
   * Makes a new file appear under its final name with all its bytes or not at all, and never over an
   * existing file: EEXIST when there is one. For the marker, which a racing reader must never see half written.
   */
  publishExclusive(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Bytes an unprivileged writer can still use on the volume of `path`; null when unknown. */
  freeBytes(path: string): Promise<number | null>;
}

export const NODE_EXPORT_ROOT_FS: ExportRootFs = {
  stat: (path) => stat(path),
  realpath: (path) => realpath(path),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readSmallFile: (path, maxBytes) => readSmallRegularFile(path, maxBytes),
  createExclusive: (path, text) => createFileExclusive(path, text),
  publishExclusive: (path, text) => publishFileExclusive(path, text),
  remove: (path) => rm(path),
  freeBytes: async (path) => {
    try {
      const info = await statfs(path);
      const free = info.bavail * info.bsize;
      return Number.isFinite(free) ? free : null;
    } catch {
      return null;
    }
  },
};

/** The calls `publishFileExclusive` makes, injectable so a test can play a volume without hard links or a full disk. */
export interface PublishOps {
  open(path: string, flags: string): Promise<FileHandle>;
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const NODE_PUBLISH_OPS: PublishOps = { open: (path, flags) => open(path, flags), link, unlink };

async function writeAndSync(handle: FileHandle, text: string): Promise<void> {
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Creates a new file (`wx`) holding `text`, flushed. A file that was created and then could not be
 * written or synced is removed, so a failed write never leaves an empty or partial file behind;
 * EEXIST (somebody else's file) is reported and that file is left alone.
 */
export async function createFileExclusive(path: string, text: string, ops: PublishOps = NODE_PUBLISH_OPS): Promise<void> {
  const handle = await ops.open(path, "wx");
  try {
    await writeAndSync(handle, text);
  } catch (error) {
    await ops.unlink(path).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads a small regular file that nothing else links to:
 * - a symlink or a junction is refused, on every platform (`openRegularNoFollow`: an `lstat`, `O_NOFOLLOW` where there is one, and the handle must be the same file);
 * - a FIFO or a device is refused without blocking (`O_NONBLOCK` where there is one, and the handle is checked, not the path);
 * - more than one hard link is refused: a marker hard-linked from another root would adopt its id;
 * - more than `maxBytes` is refused. ENOENT is passed through, so an absent file is told from a bad one.
 */
export async function readSmallRegularFile(path: string, maxBytes: number, open: OpenRegularOptions = {}): Promise<string> {
  const handle = await openRegularNoFollow(path, open);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.nlink > 1) throw Object.assign(new Error("file has more than one hard link"), { code: "EMLINK" });
    if (info.size > maxBytes) throw new Error("file is too large");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error("file is too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Publishes `text` at `path` atomically and exclusively: the bytes are written and
 * fsynced to a temp file next to it, which is then hard-linked to the final name
 * (`link()` fails with EEXIST rather than replace anything) and removed. A reader
 * sees no file or the whole file, and a crash or a full disk leaves no half-written
 * one behind. When `link()` fails for any other reason (no hard links on exFAT and
 * FAT, where Windows reports it as EISDIR; some shares) an exclusive create is used
 * instead, and it reports the real permission or space error if there is one.
 */
export async function publishFileExclusive(path: string, text: string, ops: PublishOps = NODE_PUBLISH_OPS): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeAndSync(await ops.open(temp, "wx"), text);
  } catch (error) {
    await ops.unlink(temp).catch(() => undefined);
    throw error;
  }
  try {
    await ops.link(temp, path);
  } catch (error) {
    await ops.unlink(temp).catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw error;
    // The exclusive create says EEXIST for a file that is there, as `link()` would have.
    await createFileExclusive(path, text, ops);
    return;
  }
  await ops.unlink(temp).catch(() => undefined);
}

export type ExportRootCheck =
  | { ok: true; rootId: string; /** The folder as the settings name it. */ root: string }
  | { ok: false; reason: ExportUnavailableReason };

/** The snapshot's view of a check. */
export function exportStatusOf(check: ExportRootCheck): ExportStatus {
  return check.ok ? { status: "ok" } : { status: "unavailable", reason: check.reason };
}

export interface PathsOverlapOptions {
  /** The path flavour; the platform's own unless a test plays another. */
  api?: Pick<typeof nodePath.posix, "relative" | "isAbsolute" | "resolve">;
  /** Windows and macOS disks: `Lib` and `lib` are one folder. */
  caseInsensitive: boolean;
}

/**
 * Whether two folders are the same or one lies inside the other. Compares
 * whole path segments (`/a/lib2` is not inside `/a/lib`). Both paths should be
 * canonical already (`checkExportRoot` resolves symlinks first).
 */
export function pathsOverlap(a: string, b: string, options: PathsOverlapOptions): boolean {
  const api = options.api ?? nodePath;
  const fold = (path: string) => api.resolve(options.caseInsensitive ? path.toLowerCase() : path);
  const inside = (parent: string, child: string) => {
    const rel = api.relative(parent, child);
    return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !api.isAbsolute(rel));
  };
  const left = fold(a);
  const right = fold(b);
  return inside(left, right) || inside(right, left);
}

/**
 * The real path of `path` even when the tail does not exist yet: the nearest
 * existing ancestor is resolved (symlinks and the disk's own letter case
 * included) and the missing names are appended. So a folder that is about to
 * be created inside a symlinked library is still seen inside it.
 */
async function canonicalize(fs: ExportRootFs, path: string): Promise<string> {
  const absolute = nodePath.resolve(path);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    const parent = nodePath.dirname(absolute);
    if (parent === absolute || !(hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR"))) return absolute;
    return nodePath.join(await canonicalize(fs, parent), nodePath.basename(absolute));
  }
}

export interface CheckExportRootOptions {
  fs: ExportRootFs;
  /** `Settings.exportPath`. */
  exportPath: string;
  /** `Settings.libraryPath`. */
  libraryPath: string;
  /** True for the default folder only: it is created on first use. A folder the owner chose must already exist. */
  mayCreate: boolean;
  /** A fresh id for a new marker. */
  newId: () => string;
  now: () => Date;
  caseInsensitive: boolean;
  /** The render's size estimate; the folder needs twice this free (invariant 35). Omit for the status check without a render. */
  requiredBytes?: number;
}

/**
 * The export folder's health, checked in this order and stopping at the first
 * refusal (invariant 35):
 *
 * 1. it does not overlap the library (before anything is created or written,
 *    so a refused check never touches the library);
 * 2. it exists (the default one is created), and is a directory;
 * 3. a real probe file can be created and removed there (not `access()`, which
 *    lies on read-only mounts and ACLs);
 * 4. its root marker is valid, or is written now; an unreadable or invalid one
 *    is refused and never replaced;
 * 5. with an estimate, the volume has twice that free (unknown free space does
 *    not block).
 *
 * Refusals are results. Only a programming error (a `newId` that is not an
 * id) throws.
 */
export async function checkExportRoot(options: CheckExportRootOptions): Promise<ExportRootCheck> {
  const { fs, exportPath } = options;
  const refuse = (reason: ExportUnavailableReason): ExportRootCheck => ({ ok: false, reason });

  const [exportCanonical, libraryCanonical] = await Promise.all([canonicalize(fs, exportPath), canonicalize(fs, options.libraryPath)]);
  if (pathsOverlap(exportCanonical, libraryCanonical, { caseInsensitive: options.caseInsensitive })) return refuse("overlaps-library");

  const shape = await folderShape(fs, exportPath, options.mayCreate);
  if (shape !== "ok") return refuse(shape);

  const probe = nodePath.join(exportPath, `.studio-probe-${options.newId()}`);
  // Only a probe this call created is removed: an EEXIST names somebody else's file.
  let created = false;
  try {
    await fs.createExclusive(probe, "");
    created = true;
    await fs.remove(probe);
  } catch {
    if (created) await fs.remove(probe).catch(() => undefined);
    return refuse("not-writable");
  }

  const marker = await readOrCreateMarker(fs, exportPath, options);
  if (!marker.ok) return refuse(marker.reason);

  if (options.requiredBytes !== undefined && options.requiredBytes > 0) {
    const free = await fs.freeBytes(exportPath);
    if (free !== null && free < 2 * options.requiredBytes) return refuse("not-enough-space");
  }
  return { ok: true, rootId: marker.rootId, root: exportPath };
}

/** Whether the folder is there and is a directory, creating the default one; otherwise the reason. */
async function folderShape(fs: ExportRootFs, path: string, mayCreate: boolean): Promise<"ok" | ExportUnavailableReason> {
  try {
    return (await fs.stat(path)).isDirectory() ? "ok" : "not-a-directory";
  } catch (error) {
    if (hasErrorCode(error, "ENOTDIR")) return "not-a-directory";
    if (!hasErrorCode(error, "ENOENT")) return "not-writable";
  }
  if (!mayCreate) return "missing";
  try {
    await fs.mkdirp(path);
    return (await fs.stat(path)).isDirectory() ? "ok" : "not-a-directory";
  } catch (error) {
    return hasErrorCode(error, "ENOTDIR") ? "not-a-directory" : "not-writable";
  }
}

type MarkerRead = { kind: "valid"; marker: ExportMarker } | { kind: "absent" } | { kind: "invalid" } | { kind: "newer" };

async function readMarker(fs: ExportRootFs, root: string): Promise<MarkerRead> {
  let text: string | null = null;
  // A marker being published has two names for a moment (its temp file and its own): EMLINK is retried briefly, and a marker that keeps
  // a second name (hard-linked from elsewhere) is invalid.
  for (let attempt = 0; text === null; attempt++) {
    try {
      text = await fs.readSmallFile(nodePath.join(root, EXPORT_MARKER_FILE), MAX_MARKER_BYTES);
    } catch (error) {
      if (hasErrorCode(error, "EMLINK") && attempt < MARKER_LINK_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, MARKER_LINK_RETRY_MS));
        continue;
      }
      return hasErrorCode(error, "ENOENT") ? { kind: "absent" } : { kind: "invalid" };
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  // A newer layout is judged by its version alone: it may have changed everything else.
  if (typeof raw === "object" && raw !== null && "schemaVersion" in raw && typeof raw.schemaVersion === "number" && Number.isInteger(raw.schemaVersion) && raw.schemaVersion > EXPORT_MARKER_VERSION) {
    return { kind: "newer" };
  }
  const parsed = ExportMarker.safeParse(raw);
  return parsed.success ? { kind: "valid", marker: parsed.data } : { kind: "invalid" };
}

/** The root id of a valid marker, writing a new marker when there is none. */
async function readOrCreateMarker(
  fs: ExportRootFs,
  root: string,
  options: Pick<CheckExportRootOptions, "newId" | "now">,
): Promise<{ ok: true; rootId: string } | { ok: false; reason: "invalid-marker" | "newer-marker" | "not-writable" }> {
  const first = await readMarker(fs, root);
  if (first.kind === "valid") return { ok: true, rootId: first.marker.rootId };
  if (first.kind === "invalid") return { ok: false, reason: "invalid-marker" };
  if (first.kind === "newer") return { ok: false, reason: "newer-marker" };
  const marker = ExportMarker.parse({ schemaVersion: EXPORT_MARKER_VERSION, rootId: options.newId(), createdAt: options.now().toISOString() });
  try {
    await fs.publishExclusive(nodePath.join(root, EXPORT_MARKER_FILE), `${JSON.stringify(marker)}\n`);
    return { ok: true, rootId: marker.rootId };
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) return { ok: false, reason: "not-writable" };
  }
  // Another check wrote it between our read and our write: theirs stands.
  const second = await readMarker(fs, root);
  if (second.kind === "valid") return { ok: true, rootId: second.marker.rootId };
  return { ok: false, reason: second.kind === "newer" ? "newer-marker" : "invalid-marker" };
}
