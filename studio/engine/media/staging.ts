import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Id, MEDIA_BYTE_CAPS, type MediaKind, type MediaPickKind, type MediaUnsupportedReason } from "../../shared/engine";
import { openRegularNoFollow, UnsafeOpenError, type FileIdentity, type OpenRegularOps } from "../library/openRegular";
import { resolveMediaKind, SNIFF_HEAD_BYTES, unfitReason } from "./sniff";

// The engine's half of the own-media hand-off (3f.1, invariant 34). Main's native dialog names a path; this opens it ONCE and turns it
// into a STAGED COPY inside the engine's own area (`<library>/media/.staging`). From then on nothing reads the user's path again:
// the per-kind importers (3f.2 to 3f.5) read the staged copy only, and the copy is theirs to dispose of.
//
// What is checked, and where it is checked (never on the path alone, which is a TOCTOU: the path can name something else a moment later):
//  1. `openRegularNoFollow`: an `lstat` that refuses a link, a folder or a device, an open with `O_NOFOLLOW` and `O_NONBLOCK` where there
//     are any (a FIFO would otherwise block the open for ever), and a `fstat` of the OPEN HANDLE that must say "a regular file" and be
//     the same file as the `lstat` named. On Windows, which has neither flag, the lstat and the identity check carry it alone.
//  2. The identity main saw when the dialog answered (`expected`): another file under the same name is `changed`.
//  3. The size, read from the handle (zero is `empty`; over the kind's cap is `too-large`, before a byte is copied).
//  4. The bytes: the start of the file names its kind (`sniff.ts`); the extension is never read. Judged BEFORE the copy so that the wrong
//     thing is not copied, and AGAIN on the staged copy, so that what the importers get is what was judged.
//  5. The copy is capped at the kind's cap plus one byte, whatever the file does meanwhile, and it must end at exactly the size the handle
//     reported: a file that grew or shrank while it was copied is not the file the owner picked (`changed`).

export interface StagedMedia {
  readonly stagingId: string;
  /** The kind the BYTES are (never the extension's). */
  readonly kind: MediaKind;
  readonly bytes: number;
  /** Of the staged copy. */
  readonly sha256: string;
  /** The staged copy, inside the engine's own area. The picked file's path is never kept and never passed on. */
  readonly path: string;
  /** The first bytes of the staged copy (at most `SNIFF_HEAD_BYTES`). */
  readonly head: Uint8Array;
  /** Removes the staged copy; the importer calls it when it is done with it. Harmless when repeated. */
  dispose(): Promise<void>;
}

/** Why nothing was staged: a refusal the window may be told about, or a cancel. */
export type StageRefusal = MediaUnsupportedReason | "cancelled";
export type StageResult = { ok: true; staged: StagedMedia } | { ok: false; reason: StageRefusal; detail: string };

export interface StageRequest {
  /** From main's dialog, over the control channel. Never from the window. */
  readonly path: string;
  readonly kind: MediaPickKind;
  /** The file main's check saw when the dialog answered; another file under the name is refused as `changed`. */
  readonly expected?: FileIdentity | undefined;
  readonly signal?: AbortSignal | undefined;
  /** After each chunk: the bytes copied so far and the size the file had when it was opened. */
  readonly onProgress?: ((copied: number, total: number) => void) | undefined;
}

export interface MediaStagingOptions {
  /** `<library>/media/.staging`. Created on first use; whatever is in it then is a crash's leftover and is removed. */
  readonly dir: string;
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
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

const refuse = (reason: StageRefusal, detail: string): StageResult => ({ ok: false, reason, detail });

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof Reflect.get(error, "code") === "string" ? String(Reflect.get(error, "code")) : undefined;
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

export class MediaStaging {
  readonly #options: MediaStagingOptions;
  readonly #caps: Readonly<Record<MediaKind, number>>;
  #ready: Promise<void> | null = null;

  constructor(options: MediaStagingOptions) {
    this.#options = options;
    this.#caps = options.caps ?? MEDIA_BYTE_CAPS;
  }

  /** The cap a pick is held to before its bytes name the kind: its own, or for `any` the largest. */
  #capOf(kind: MediaPickKind): number {
    return kind === "any" ? Math.max(...Object.values(this.#caps)) : this.#caps[kind];
  }

  /** Creates the staging folder and empties it, once. Nothing staged by an earlier run is referenced by anything, so all of it is garbage. */
  #prepare(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#options.dir, { recursive: true });
      for (const name of await readdir(this.#options.dir)) await rm(join(this.#options.dir, name), { recursive: true, force: true });
    })();
    return this.#ready;
  }

  async stage(request: StageRequest): Promise<StageResult> {
    if (request.signal?.aborted === true) return refuse("cancelled", "the import was cancelled");
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
      return refuse("unreadable", `the picked file could not be read${errorCode(error) === undefined ? "" : ` (${errorCode(error)})`}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #stageOpen(handle: FileHandle, request: StageRequest): Promise<StageResult> {
    const info = await handle.stat({ bigint: true });
    if (request.expected !== undefined && (String(info.dev) !== request.expected.dev || String(info.ino) !== request.expected.ino)) {
      return refuse("changed", "the file is not the one the dialog showed");
    }
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
    const part = join(this.#options.dir, `.${stagingId}.part`);
    const target = join(this.#options.dir, `${stagingId}.media`);
    const out = await open(part, "wx");
    const abandon = async (result: StageResult): Promise<StageResult> => {
      await out.close().catch(() => undefined);
      await rm(part, { force: true });
      return result;
    };
    try {
      const chunk = Buffer.allocUnsafe(this.#options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
      const hash = createHash("sha256");
      let total = 0;
      for (;;) {
        if (request.signal?.aborted === true) return await abandon(refuse("cancelled", "the import was cancelled"));
        // Never more than one byte past the cap is read, whatever the file does meanwhile.
        const want = Math.min(chunk.length, cap + 1 - total);
        const { bytesRead } = await handle.read(chunk, 0, want, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > cap) return await abandon(refuse("too-large", `the file is larger than ${cap} bytes`));
        await out.write(chunk, 0, bytesRead);
        hash.update(chunk.subarray(0, bytesRead));
        request.onProgress?.(total, size);
      }
      if (total !== size) return await abandon(refuse("changed", "the file changed while it was being copied"));
      await out.close();

      // What the importers get is what is judged: the staged copy's own start must still be this kind.
      const stagedHead = await readHead(part, Math.min(SNIFF_HEAD_BYTES, total));
      if (resolveMediaKind(request.kind, stagedHead) !== kind) {
        await rm(part, { force: true });
        return refuse("changed", "the file's start changed while it was being copied");
      }
      await rename(part, target);
      return {
        ok: true,
        staged: { stagingId, kind, bytes: total, sha256: hash.digest("hex"), path: target, head: stagedHead, dispose: () => rm(target, { force: true }) },
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
