import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Id, isUnsafePickedPath, MEDIA_BYTE_CAPS, type MediaKind, type MediaPickKind, type MediaUnsupportedReason, type PickedFileIdentity } from "../../shared/engine";
import { openRegularNoFollow, UnsafeOpenError, type OpenRegularOps } from "../library/openRegular";
import { renameWithRetry } from "../library/renameRetry";
import { unlinkWithRetry } from "../library/unlinkRetry";
import { pickedIdentityOf, sameIdentity } from "./identity";
import { formatOf, resolveMediaKind, SNIFF_HEAD_BYTES, unfitReason, type MediaFormat } from "./sniff";

// The engine's half of the own-media hand-off (3f.1, invariant 34). Main's native dialog names a path; this opens it ONCE and turns it
// into a STAGED COPY inside the engine's own area (`<library>/media/.staging`). From then on nothing reads the user's path again:
// the per-kind importers (3f.2 to 3f.5) read the staged copy only, and the copy is theirs to dispose of.
//
// What is checked, and where it is checked (never on the path alone, which is a TOCTOU: the path can name something else a moment later):
//  0. The path is not one Windows reads as a device, a stream or a reserved name (`isUnsafePickedPath`, also checked in main).
//  1. `openRegularNoFollow`: an `lstat` that refuses a link, a folder or a device, an open with `O_NOFOLLOW` and `O_NONBLOCK` where there
//     are any (a FIFO would otherwise block the open for ever), and a `fstat` of the OPEN HANDLE that must say "a regular file" and be
//     the same file as the `lstat` named. On Windows, which has neither flag, the lstat and the identity check carry it alone.
//  2. The identity main saw when the dialog answered (`expected`: device, inode, size and times, from the handle): another file under the
//     name, or the same file changed, is `changed`. It is compared with the stat of the OPEN HANDLE, never of the path.
//  3. The size, read from the handle (zero is `empty`; over the kind's cap is `too-large`, before a byte is copied).
//  4. The bytes: the start of the file names its kind (`sniff.ts`); the extension is never read. Judged BEFORE the copy so that the wrong
//     thing is not copied, and AGAIN on the staged copy, so that what the importers get is what was judged.
//  5. Room: the library's disk must have the file's size and a margin free, or it is `no-space` and nothing is written.
//  6. The copy reads at most the size the handle reported plus one byte, whatever the file does meanwhile, and must end at exactly that
//     size: a file that grew or shrank while it was copied is not the file the owner picked (`changed`). Every write is checked whole, and
//     so is the copy on disk.
//
// The staging folder is the library's own and nothing else: `media` and `.staging` must be real folders (not links or junctions) that
// resolve inside the library root, or nothing is written there and nothing is removed. Its cleanup removes only files that have the shape
// of ours, never recursively.

export interface StagedMedia {
  readonly stagingId: string;
  /** The kind the BYTES are (never the extension's). */
  readonly kind: MediaKind;
  /** The container the BYTES are: the importer forces its demuxer from this and never from the name. */
  readonly format: MediaFormat;
  readonly bytes: number;
  /** Of the staged copy. */
  readonly sha256: string;
  /** The staged copy, inside the engine's own area, under a neutral name (`<stagingId>.media`). The picked file's path is never kept and never passed on. */
  readonly path: string;
  /** The first bytes of the staged copy (at most `SNIFF_HEAD_BYTES`). */
  readonly head: Uint8Array;
  /** Removes the staged copy; the importer calls it when it is done with it. Harmless when repeated, and never throws: a copy that cannot be removed is left to the next cleanup. */
  dispose(): Promise<void>;
}

/** Why nothing was staged: a refusal the window may be told about, or a cancel. */
export type StageRefusal = MediaUnsupportedReason;
export type StageResult = { ok: true; staged: StagedMedia } | { ok: false; reason: StageRefusal; detail: string };

export interface StageRequest {
  /** From main's dialog, over the control channel. Never from the window. */
  readonly path: string;
  readonly kind: MediaPickKind;
  /** The file main's check saw when the dialog answered; another file under the name, or the same one changed, is refused as `changed`. */
  readonly expected: PickedFileIdentity;
  readonly signal?: AbortSignal | undefined;
  /** After each chunk: the bytes copied so far and the size the file had when it was opened. */
  readonly onProgress?: ((copied: number, total: number) => void) | undefined;
}

/** The disk calls of the copy's own files, injectable for a test that plays Windows' held handles or a disk that writes short. */
export interface StagingFs {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  /** The platform the retries are for (`win32` retries a held handle); the running one by default. */
  readonly platform?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly delaysMs?: readonly number[];
  /** Creates the staged copy's `.part` file, exclusively; `open(path, "wx")` by default. */
  readonly openOut?: (path: string) => Promise<FileHandle>;
}

export interface MediaStagingOptions {
  /** The library's root: staging lives in `<root>/media/.staging`. */
  readonly root: string;
  readonly newId: () => string;
  /** Per-kind caps in bytes; the contract's `MEDIA_BYTE_CAPS` unless a test plays smaller ones. */
  readonly caps?: Readonly<Record<MediaKind, number>>;
  /** Bytes per read; 1 MiB unless a test wants many small steps. */
  readonly chunkBytes?: number;
  /** The disk calls and `O_NOFOLLOW` of the open, for a test that plays a swap or a platform without the flag. */
  readonly ops?: OpenRegularOps;
  readonly noFollow?: number;
  /** Whether a kind has an importer. A kind without one is refused as `not-yet-supported` before it is copied. Every kind when absent. */
  readonly supports?: (kind: MediaKind) => boolean;
  /** The platform the picked path is read by; the running one by default. */
  readonly platform?: string;
  /** Bytes free for an unprivileged user on the library's disk, or null when the disk cannot say; `statfs` by default. */
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /** Free room kept beyond the file's own size; 64 MiB by default. */
  readonly freeMarginBytes?: number;
  /** Where a failure that does not stop anything is told (never with a path); the engine's log by default. */
  readonly warn?: (text: string) => void;
  readonly fs?: StagingFs;
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_FREE_MARGIN_BYTES = 64 * 1024 * 1024;
/** The shape of a name this module makes: `.<id>.part` while it is copied, `<id>.media` when it is whole. Nothing else is ever removed. */
const STAGED_NAME = /^\.?[a-z0-9-]{8,64}\.(part|media)$/;

const refuse = (reason: StageRefusal, detail: string): StageResult => ({ ok: false, reason, detail });

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof Reflect.get(error, "code") === "string" ? String(Reflect.get(error, "code")) : undefined;
}

/** The staging folder, or a folder on the way to it, is not a plain folder of the library's own. */
class UnsafeStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStagingError";
  }
}

/** What opening the picked path said, as a refusal. */
function refusalOfOpen(error: unknown): StageResult {
  if (error instanceof UnsafeOpenError) {
    if (error.code === "ECHANGED") return refuse("changed", "the file at the path changed while it was being opened");
    return refuse("not-a-file", "the picked path is not a regular file");
  }
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return refuse("not-a-file", "nothing is at the picked path");
  return refuse("unreadable", `the picked file could not be opened${code === undefined ? "" : ` (${code})`}`);
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export class MediaStaging {
  readonly #options: MediaStagingOptions;
  readonly #caps: Readonly<Record<MediaKind, number>>;
  readonly #mediaDir: string;
  readonly #dir: string;
  #ready: Promise<void> | null = null;

  constructor(options: MediaStagingOptions) {
    this.#options = options;
    this.#caps = options.caps ?? MEDIA_BYTE_CAPS;
    this.#mediaDir = join(options.root, "media");
    this.#dir = join(this.#mediaDir, ".staging");
  }

  #warn(text: string): void {
    (this.#options.warn ?? ((message: string) => console.warn(`studio engine: ${message}`)))(text);
  }

  #retry(): { platform?: string; sleep?: (ms: number) => Promise<void>; delaysMs?: readonly number[] } {
    const fs = this.#options.fs;
    return {
      ...(fs?.platform === undefined ? {} : { platform: fs.platform }),
      ...(fs?.sleep === undefined ? {} : { sleep: fs.sleep }),
      ...(fs?.delaysMs === undefined ? {} : { delaysMs: fs.delaysMs }),
    };
  }

  #rename(from: string, to: string): Promise<void> {
    const rename = this.#options.fs?.rename;
    return renameWithRetry(from, to, { ...this.#retry(), ...(rename === undefined ? {} : { rename }) });
  }

  #unlink(path: string): Promise<void> {
    const unlink = this.#options.fs?.unlink;
    return unlinkWithRetry(path, { ...this.#retry(), ...(unlink === undefined ? {} : { unlink }) });
  }

  /** Removes `path` if it is there; a failure is told once (no path) and left to the next cleanup. Never throws. */
  async #removeQuietly(path: string): Promise<void> {
    try {
      await this.#unlink(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") this.#warn("a staged file could not be removed; it stays for the next cleanup");
    }
  }

  /**
   * Whether `<root>/media/.staging` is there and is the library's own: real folders all the way (an `lstat` says so: a link or a junction is
   * not one), resolving inside the library root. `create` makes what is missing (one level at a time, so nothing is created through a link).
   * Null when it is not there and `create` is off. Throws `UnsafeStagingError` for anything that is there and is not a plain folder.
   */
  async #safeDir(create: boolean): Promise<string | null> {
    for (const dir of [this.#mediaDir, this.#dir]) {
      let info = await lstat(dir).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (info === null) {
        if (!create) return null;
        await mkdir(dir).catch((error: unknown) => {
          if (errorCode(error) !== "EEXIST") throw error;
        });
        info = await lstat(dir);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new UnsafeStagingError("the staging folder is not a plain folder");
    }
    const [root, real] = await Promise.all([realpath(this.#options.root), realpath(this.#dir)]);
    const inside = relative(root, real);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new UnsafeStagingError("the staging folder is not inside the library");
    return this.#dir;
  }

  /**
   * Removes what a crash left in the staging folder: files that have the shape of ours (`.<id>.part`, `<id>.media`), nothing else and nothing
   * recursively. A staging folder that is not there, or is a link, is left alone. Never throws; a file that cannot be removed is told once.
   */
  async sweep(): Promise<void> {
    let dir: string | null;
    try {
      dir = await this.#safeDir(false);
    } catch {
      return;
    }
    if (dir === null) return;
    let failed = 0;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !STAGED_NAME.test(entry.name)) continue;
      try {
        await this.#unlink(join(dir, entry.name));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") failed++;
      }
    }
    if (failed > 0) this.#warn(`${failed} leftover staged file${failed === 1 ? "" : "s"} could not be removed; they stay for the next cleanup`);
  }

  /** Makes the staging folder safe and sweeps it, once. A failure is not remembered: the next file tries again. */
  #prepare(): Promise<void> {
    this.#ready ??= (async () => {
      await this.#safeDir(true);
      await this.sweep();
    })().catch((error: unknown) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async stage(request: StageRequest): Promise<StageResult> {
    if (request.signal?.aborted === true) return refuse("cancelled", "the import was cancelled");
    if (isUnsafePickedPath(request.path, this.#options.platform ?? process.platform)) return refuse("not-a-file", "the picked path is not a regular file");
    let handle: FileHandle;
    try {
      handle = await openRegularNoFollow(request.path, {
        ...(this.#options.ops === undefined ? {} : { ops: this.#options.ops }),
        ...(this.#options.noFollow === undefined ? {} : { noFollow: this.#options.noFollow }),
      });
    } catch (error) {
      return refusalOfOpen(error);
    }
    try {
      return await this.#stageOpen(handle, request);
    } catch (error) {
      if (error instanceof UnsafeStagingError) return refuse("unreadable", "the library's staging folder cannot be used");
      return refuse("unreadable", `the picked file could not be read${errorCode(error) === undefined ? "" : ` (${errorCode(error)})`}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #stageOpen(handle: FileHandle, request: StageRequest): Promise<StageResult> {
    const info = await handle.stat({ bigint: true });
    if (!sameIdentity(pickedIdentityOf(info), request.expected)) return refuse("changed", "the file is not the one the dialog showed");
    if (info.size === 0n) return refuse("empty", "the file has no bytes");
    // A size beyond what a number holds exactly is far beyond every cap.
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("too-large", "the file is larger than any import takes");
    const size = Number(info.size);

    // The start of the file names its kind: read from the OPEN handle, before anything is copied.
    const probe = Buffer.alloc(Math.min(SNIFF_HEAD_BYTES, size));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    const head = probe.subarray(0, bytesRead);
    const kind = resolveMediaKind(request.kind, head);
    if (kind === null) {
      const reason = unfitReason(request.kind, head);
      return refuse(reason, reason === "heic" ? "a HEIC picture cannot be imported" : "the file's bytes are not of the kind that was asked for");
    }
    if (this.#options.supports?.(kind) === false) return refuse("not-yet-supported", `${kind} files cannot be imported yet`);
    const cap = this.#caps[kind];
    if (size > cap) return refuse("too-large", `the file is larger than ${cap} bytes`);

    return this.#copy(handle, request, kind, size, cap);
  }

  async #copy(handle: FileHandle, request: StageRequest, kind: MediaKind, size: number, cap: number): Promise<StageResult> {
    const stagingId = this.#options.newId();
    if (!Id.safeParse(stagingId).success) return refuse("unreadable", "no staging name could be made");
    await this.#prepare();

    // Room first: a 2 GiB copy onto a nearly full disk would fill it and fail late.
    const free = await (this.#options.freeBytes ?? defaultFreeBytes)(this.#dir).catch(() => null);
    if (free !== null && free < size + (this.#options.freeMarginBytes ?? DEFAULT_FREE_MARGIN_BYTES)) {
      return refuse("no-space", "the library's disk has too little free room for the copy");
    }

    const part = join(this.#dir, `.${stagingId}.part`);
    const target = join(this.#dir, `${stagingId}.media`);
    const out = await (this.#options.fs?.openOut ?? ((path: string) => open(path, "wx")))(part);
    const abandon = async (result: StageResult): Promise<StageResult> => {
      await out.close().catch(() => undefined);
      await this.#removeQuietly(part);
      return result;
    };
    try {
      const chunk = Buffer.allocUnsafe(this.#options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
      const hash = createHash("sha256");
      // Never more than one byte past the size the handle reported is read, whatever the file does meanwhile.
      const limit = Math.min(cap, size);
      let total = 0;
      for (;;) {
        if (request.signal?.aborted === true) return await abandon(refuse("cancelled", "the import was cancelled"));
        const want = Math.min(chunk.length, limit + 1 - total);
        const { bytesRead } = await handle.read(chunk, 0, want, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limit) return await abandon(refuse("changed", "the file grew while it was being copied"));
        const { bytesWritten } = await out.write(chunk, 0, bytesRead);
        if (bytesWritten !== bytesRead) return await abandon(refuse("unreadable", "the copy could not be written whole"));
        hash.update(chunk.subarray(0, bytesRead));
        request.onProgress?.(total, size);
      }
      if (total !== size) return await abandon(refuse("changed", "the file changed while it was being copied"));
      if ((await out.stat()).size !== total) return await abandon(refuse("unreadable", "the copy on disk is not the size of what was read"));
      await out.close();

      // What the importers get is what is judged: the staged copy's own start must still be this kind.
      const stagedHead = await readHead(part, Math.min(SNIFF_HEAD_BYTES, total));
      const format = formatOf(stagedHead);
      if (resolveMediaKind(request.kind, stagedHead) !== kind || format === null) {
        await this.#removeQuietly(part);
        return refuse("changed", "the file's start changed while it was being copied");
      }
      try {
        await this.#rename(part, target);
      } catch {
        await this.#removeQuietly(part);
        return refuse("unreadable", "the copy could not be put in place");
      }
      return {
        ok: true,
        staged: { stagingId, kind, format, bytes: total, sha256: hash.digest("hex"), path: target, head: stagedHead, dispose: () => this.#removeQuietly(target) },
      };
    } catch (error) {
      await abandon(refuse("unreadable", "the copy failed"));
      throw error;
    }
  }
}

async function readHead(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return Uint8Array.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
