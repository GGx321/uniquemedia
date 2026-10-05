import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { Id, MAX_LISTED_MEDIA, MediaFileName, MediaKind, MediaSummary } from "../../shared/engine";
import type { MediaFormat } from "../media/sniff";
import { MAX_ENVELOPE_STEPS } from "../music/trackRecord";
import { isNoSpaceError } from "../freeBytes";
import { fsyncDir, fsyncFile, hasErrorCode, isTempName, writeJsonAtomic } from "./durableFs";
import { isFromNewerVersion, MEDIA_DIR, MEDIA_RECORD_SCHEMA_VERSION, MEDIA_STAGING_DIR, QUARANTINE_DIR } from "./layout";
import { openRegularNoFollow, type OpenRegularOps } from "./openRegular";
import { Quarantine, QuarantineNotFlushed, type QuarantineDurability } from "./quarantine";
import { renameWithRetry } from "./renameRetry";
import { unlinkWithRetry } from "./unlinkRetry";

// The own-media records (Stage 3, 3f.1b; K28): `<library>/media/<mediaId>.json` beside the stored file `<mediaId>.<ext>`.
//
// WRITE-ONCE, ATOMIC. A record is written with the library's own helper (temp, fsync, rename, fsync of the folder), so a reader or a
// restart sees the whole record or none. The stored file is made durable and renamed into its name BEFORE the record is written, so
// a record never names a file that is not on disk; the crash windows are:
//   - before the file is stored: the staged copy is left to the staging cleanup;
//   - the file is stored, the record is not (an ORPHAN file): `recover` sets it aside in the library's quarantine at the next open;
//   - the record's temp file is left: `recover` sweeps it;
//   - the record is written: complete. A record whose file is gone (DANGLING) names nothing: it is not listed and is told as a `missing-file` problem, and it STAYS in
//     `media/`, so a file that arrives later (a sync that brings the record first; an iCloud placeholder) pairs with it at the next open.
// NOTHING IS DELETED BY AN OPEN. An orphan file may be the owner's own, or half of a pair a sync has not finished bringing: it goes to
// `<library>/quarantine/<stamp>/media/` (a rename on the same volume), with one log line. When the other half is found in the quarantine (the record of an orphan file,
// or the file of a dangling record), the pair is brought back to `media/` instead of anything being moved, so a library opened half-copied and again once the rest has
// arrived loses and hides nothing. Only a record's own temp file is swept.
//
// An import interrupted by a crash is therefore CLEANED UP, never resumed: the source path is not kept anywhere (invariant 34), so
// there is nothing to resume from, and the owner picks the file again.
//
// NOTHING OUTSIDE `<library>/media/` AND THE LIBRARY'S OWN `quarantine/` IS EVER TOUCHED. The folder must be a real folder (an `lstat` refuses a link or a junction) that
// resolves inside the library root. A record's `file` must be exactly `<its id>.<the extension of its format>`: a record can never
// point a removal at another name. Only files of that shape, with no record at all, are set aside as orphans; a record that cannot be
// read, or that a newer Studio wrote, keeps its file and is never removed.

/** The extension of the stored file, by container. Closed: an unknown format is not stored. */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaFormat, string>> = {
  jpeg: "jpg",
  png: "png",
  apng: "png",
  webp: "webp",
  gif: "gif",
  mp4: "mp4",
  mov: "mov",
  m4a: "m4a",
  wav: "wav",
  flac: "flac",
  ogg: "ogg",
  mp3: "mp3",
  aac: "aac",
};
const FORMATS = Object.keys(MEDIA_EXTENSIONS) as [MediaFormat, ...MediaFormat[]];
const EXTENSIONS = [...new Set(Object.values(MEDIA_EXTENSIONS))];

/** Which containers a STORED file of each kind may be (what the importers make, or the staged copy as it is). */
const FORMATS_OF_KIND: Readonly<Record<MediaKind, readonly MediaFormat[]>> = {
  photo: ["jpeg", "png", "webp"],
  video: ["mp4", "mov"],
  audio: ["m4a", "mp3", "aac", "wav", "flac", "ogg"],
  sticker: ["apng", "gif", "png"],
};

const ORPHAN_NAME = new RegExp(`^[a-z0-9-]{8,64}\\.(${EXTENSIONS.join("|")})$`);
const RECORD_NAME = /^([a-z0-9-]{8,64})\.json$/;
const RECORD_TEMP_NAME = /^\.[a-z0-9-]{8,64}\.json\.[0-9a-f]{12}\.tmp$/;

/** What `<id>.json` holds. Loose, so a field a later build adds does not make a record of this version unreadable. */
const RecordShape = z.looseObject({
  schemaVersion: z.literal(MEDIA_RECORD_SCHEMA_VERSION),
  id: Id,
  kind: MediaKind,
  name: MediaFileName,
  createdAt: z.iso.datetime(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.enum(FORMATS),
  file: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
  sourceFps: z.number().positive().max(1000).nullable(),
  hdrToSdr: z.boolean(),
  loopFrames: z.number().int().positive().max(300).nullable(),
  delayFrames: z.array(z.number().int().positive().max(300)).min(1).max(300).nullable(),
});
type RecordShape = z.infer<typeof RecordShape>;

/**
 * A track's waveform (3f.4), as its record keeps it: the 50 ms envelope the track store keeps for a trending track (`EnvelopeSchema`), one integer 0 to
 * 1000 per step, at least one step (a track that decoded has one) and no more than the store's own limit. Kept in the record, not in the index: a
 * ten minute track has 12000 values, and a library of tracks must not hold them all in memory (`waveformOf` reads the one that is asked for).
 */
const Waveform = z.array(z.number().int().min(0).max(1000)).min(1).max(MAX_ENVELOPE_STEPS);

/** The largest record file `waveformOf` reads: a record is a few KiB of JSON, plus a waveform of up to 20000 values (about 100 KiB). */
export const MAX_RECORD_FILE_BYTES = 1024 * 1024;

/** The most bytes one `recover()` hashes to pair quarantined copies with their records; past it the rest stay `missing-file` and the next open carries on. */
export const RECOVER_HASH_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;

/** What `waveformOf` needs of a record on disk: whose it is, what it is, and the waveform. */
const RecordWaveform = z.looseObject({ id: Id, kind: z.literal("audio"), waveform: Waveform });

/** A record as the index keeps it: without the waveform (see `Waveform`). */
function inIndex(record: RecordShape): RecordShape {
  const { waveform: _waveform, ...rest } = record;
  return rest;
}

/** What main's `studio-media://media/<mediaId>` route reads of a record: which stored file to open, and what it must be. */
export interface ServedMediaRecord {
  readonly id: string;
  readonly kind: MediaKind;
  readonly format: MediaFormat;
  /** The stored file's size: a file of another size is not the one this record was written for. */
  readonly bytes: number;
  /** `<id>.<extension of the format>`, inside `<library>/media/`: the only name the route may open. */
  readonly file: string;
  /** The sha256 of the stored file's bytes: `media.stickerBytes` checks the exact bytes it sends against it (3f.5). */
  readonly sha256: string;
  /** The stored canvas, and a sticker's loop in 30 fps frames (null for what has none): what the bytes of a sticker must say they are (3f.5). */
  readonly width: number | null;
  readonly height: number | null;
  readonly loopFrames: number | null;
}

/**
 * A record's JSON, judged for SERVING (the preview route, 3f.2): the record's schema (a newer Studio's, or a damaged one, is not served), a
 * container the kind may be, and a `file` that is exactly `<its id>.<the extension of its format>`, so a record can never make the route open
 * another name. Null for anything else. It is the same shape check the records' own recovery applies; a file with no record is never served.
 */
export function servedMediaRecord(json: unknown): ServedMediaRecord | null {
  const parsed = RecordShape.safeParse(json);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (!FORMATS_OF_KIND[record.kind].includes(record.format)) return null;
  if (record.file !== `${record.id}.${MEDIA_EXTENSIONS[record.format]}`) return null;
  return { id: record.id, kind: record.kind, format: record.format, bytes: record.bytes, file: record.file, sha256: record.sha256, width: record.width, height: record.height, loopFrames: record.loopFrames };
}

/** What an importer learned of the file it made; which fields a kind has is the contract's (`MediaSummary`). */
export interface MediaFacts {
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly sourceFps: number | null;
  readonly hdrToSdr: boolean;
  readonly loopFrames: number | null;
  readonly delayFrames: readonly number[] | null;
}

export interface MediaCommitInput {
  /** The file to store: a plain file directly inside `<library>/media/.staging`. It is MOVED, and is gone from there when the commit is done. */
  readonly sourcePath: string;
  readonly kind: MediaKind;
  /** The container of the file as it will be stored. */
  readonly format: MediaFormat;
  /** The picked file's display name. */
  readonly name: string;
  readonly facts: MediaFacts;
  /** The sha256 of the file's bytes when the caller has it (the staged copy's is known); computed from the file otherwise. */
  readonly sha256?: string | undefined;
  /** A track's waveform (3f.4): one value per 50 ms, each an integer 0 to 1000. Only an audio record has one; `waveformOf` reads it back. */
  readonly waveform?: readonly number[] | undefined;
}

export type MediaCommitFailure = "invalid" | "unsafe" | "exists" | "cancelled" | "disk" | "no-space";

/** A commit that did not happen, and nothing of it is left. `code` says why; the message names no path. */
export class MediaCommitError extends Error {
  readonly code: MediaCommitFailure;
  constructor(code: MediaCommitFailure, message: string) {
    super(message);
    this.name = "MediaCommitError";
    this.code = code;
  }
}

/** A disk call failed; `code` is the disk's, and the message names no path. */
export class MediaDiskError extends Error {
  readonly code: string;
  constructor(what: string, code: string) {
    super(`${what} (${code})`);
    this.name = "MediaDiskError";
    this.code = code;
  }
}

export interface MediaRecordsOptions {
  /** The library's root: records live in `<root>/media`. */
  readonly root: string;
  readonly newId: () => string;
  readonly now: () => Date;
  /** The most bytes one `recover()` hashes; `RECOVER_HASH_BUDGET_BYTES` by default. */
  readonly hashBudgetBytes?: number;
  /** How the quarantine flushes a folder; its own by default. A test plays a flush that fails. */
  readonly quarantineDurability?: QuarantineDurability;
  /** Where a failure that stops nothing is told (never with a path). */
  readonly warn?: (text: string) => void;
  /** The disk calls a record is opened with when its waveform is read (`openRegularNoFollow`); the real ones by default. A test plays a swap or a handle that lies. */
  readonly ops?: OpenRegularOps;
  /** The disk calls of removal and the platform their retries are for, for a test that plays Windows' held handles. */
  readonly fs?: {
    readonly unlink?: (path: string) => Promise<void>;
    /** How a record's file is looked at when a library opens; `lstat` by default. */
    readonly lstat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
    readonly rename?: (from: string, to: string) => Promise<void>;
    /** A hard link, which fails when the name is taken (how a piece is brought back from the quarantine without ever overwriting); `link` by default. */
    readonly link?: (from: string, to: string) => Promise<void>;
    /** The sha256 of a file, read under a signal; the real one by default. A test plays a slow or stopped read. */
    readonly hash?: (path: string, signal?: AbortSignal) => Promise<string>;
    readonly platform?: string;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly delaysMs?: readonly number[];
  };
  /** Test seams: points in a commit where a crash can be played. */
  readonly hooks?: {
    /** After the file is in its place and before the record is written. */
    readonly afterFileStored?: () => void | Promise<void>;
    /** Before the quarantine's stamps are listed for a piece to bring back (a test stops the recover here). */
    readonly beforeQuarantineScan?: () => void | Promise<void>;
    /** After the record's temp file is durable and before it is renamed into place (`writeFileAtomic`'s own seam). */
    readonly beforeRecordRename?: (finalPath: string) => void | Promise<void>;
    /** Says that an error is a crash: the commit then does not clean up after it, because a crash cannot (the disk is left as it is). Never set in the app. */
    readonly treatAsCrash?: (error: unknown) => boolean;
  };
}

export type MediaProblemReason = "unreadable" | "too-new" | "damaged" | "missing-file";
export interface MediaRecoveryReport {
  /** Records read and listed. */
  readonly listed: number;
  /** Stored files with no record at all, moved to the library's quarantine. */
  readonly quarantinedOrphans: number;
  /** Pieces (a record, or a file) brought back from the library's quarantine to pair with the other half that is in `media/`. */
  readonly restored: number;
  /** Records that were not listed and not touched, by file name (never a path). */
  readonly problems: readonly { file: string; reason: MediaProblemReason }[];
  /** The media folder is not a plain folder of the library's: nothing was read or removed. */
  readonly unusable: boolean;
}

type DirState = "ok" | "absent" | "unsafe";

export class MediaRecords {
  readonly #options: MediaRecordsOptions;
  readonly #dir: string;
  readonly #staging: string;
  readonly #index = new Map<string, RecordShape>();
  /** The order records came into the index: the tie-break of a listing when two were made in the same instant. */
  readonly #order = new Map<string, number>();
  #entered = 0;
  /** Records being removed: out of the index from the first moment of the removal (nobody finds them), back in if it fails. */
  readonly #deleting = new Map<string, RecordShape>();
  /** Ids between the file's rename and the record's write: a cleanup must not take their file for an orphan. */
  readonly #inFlight = new Set<string>();

  constructor(options: MediaRecordsOptions) {
    this.#options = options;
    this.#dir = join(options.root, MEDIA_DIR);
    this.#staging = join(this.#dir, MEDIA_STAGING_DIR);
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

  #unlink(path: string): Promise<void> {
    const unlink = this.#options.fs?.unlink;
    return unlinkWithRetry(path, { ...this.#retry(), ...(unlink === undefined ? {} : { unlink }) });
  }

  #rename(from: string, to: string): Promise<void> {
    const rename = this.#options.fs?.rename;
    return renameWithRetry(from, to, { ...this.#retry(), ...(rename === undefined ? {} : { rename }) });
  }

  async #removeQuietly(path: string): Promise<boolean> {
    try {
      await this.#unlink(path);
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) this.#warn("a stored media file could not be removed; it stays for the next cleanup");
      return false;
    }
  }

  /** Moves a file to the library's quarantine. `failed` when it could not (it stays where it is; the caller tells it once), `gone` when it was no longer there. */
  async #setAside(quarantine: Quarantine, path: string): Promise<"moved" | "gone" | "failed"> {
    try {
      await quarantine.move(path, "orphan-media");
      return "moved";
    } catch (error) {
      // The file is in the quarantine and only a flush of a folder failed: it was set aside.
      if (error instanceof QuarantineNotFlushed) return "moved";
      return hasErrorCode(error, "ENOENT") ? "gone" : "failed";
    }
  }

  /** Whether `path` is a real folder (not a link or a junction) whose real path is inside the library root. */
  async #plainFolderInRoot(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
      const [root, real] = await Promise.all([realpath(this.#options.root), realpath(path)]);
      const inside = relative(root, real);
      return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
    } catch {
      return false;
    }
  }

  /**
   * The files the library's quarantine holds from `media/`, by name: every copy, NEWEST stamp first, as paths. What an open may bring back. Only plain folders inside the library
   * are read (`quarantine/` and each `<stamp>/media`: a link or a junction is refused, as `media/` is), and only plain files in them. Empty when there is none or it cannot be read.
   */
  async #quarantinedMedia(): Promise<Map<string, string[]>> {
    await this.#options.hooks?.beforeQuarantineScan?.();
    const found = new Map<string, string[]>();
    const parent = join(this.#options.root, QUARANTINE_DIR);
    if (!(await this.#plainFolderInRoot(parent))) return found;
    let stamps;
    try {
      stamps = (await readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareStamps).reverse();
    } catch {
      return found;
    }
    for (const stamp of stamps) {
      const folder = join(parent, stamp, MEDIA_DIR);
      if (!(await this.#plainFolderInRoot(folder))) continue;
      let files;
      try {
        files = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) if (file.isFile()) found.set(file.name, [...(found.get(file.name) ?? []), join(folder, file.name)]);
    }
    return found;
  }

  /** Whether a quarantined copy of a record's FILE is that file: the size the record names, and the hash it names (a same-size copy a sync zero-filled is not it). */
  async #fitsFile(from: string, bytes: number, sha256: string, budget: { left: number }, signal: AbortSignal | undefined): Promise<boolean> {
    if ((await lstat(from).then((info) => info.size, () => -1)) !== bytes) return false;
    // A copy is hashed only while the budget lasts and the recover is not stopped: a slow disk must not hold every open (and every listing behind it) for minutes.
    if (signal?.aborted === true || bytes > budget.left) return false;
    // Charged before the read: a copy that cannot be read is charged on every open (accepted; see the plan's backlog).
    budget.left -= bytes;
    let found: string;
    let identity: BigIntStats | undefined;
    try {
      const seam = this.#options.fs?.hash;
      if (seam === undefined) {
        // Read from an opened handle, so that what was hashed and what is named later are one file or are known to differ.
        const read = await hashCopy(from, signal, this.#options.ops);
        found = read.sha256;
        identity = read.identity;
      } else {
        identity = await lstat(from, { bigint: true }).catch(() => undefined);
        found = await seam(from, signal);
      }
    } catch {
      return false;
    }
    if (found === sha256) return true;
    await this.#setMismatchAside(from, identity);
    return false;
  }

  /**
   * A copy that was read to the end and is not the record's file is set aside under a free `.mismatch` name (never deleted, never over another: the name is one no scan looks
   * up), so that no later open hashes it again and spends its budget on it. Only if it is still the file that was read: a sync client may have renamed another over it meanwhile,
   * and that one is left for the next open to judge.
   */
  async #setMismatchAside(from: string, read: BigIntStats | undefined): Promise<void> {
    if (read === undefined) return;
    const now = await lstat(from, { bigint: true }).catch(() => null);
    if (now === null || now.dev !== read.dev || now.ino !== read.ino || now.size !== read.size || now.mtimeNs !== read.mtimeNs) return;
    for (let n = 0; n < 1000; n++) {
      const target = n === 0 ? `${from}.mismatch` : `${from}.mismatch-${n}`;
      try {
        await (this.#options.fs?.link ?? link)(from, target);
        await this.#unlink(from).catch(() => undefined);
        return;
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) continue;
        // No hard links here: a look, then a rename, only to a name that is free.
        const taken = await lstat(target).then(
          () => true,
          () => false,
        );
        if (taken) continue;
        await this.#rename(from, target).catch(() => undefined);
        return;
      }
    }
  }

  /**
   * The text of a quarantined record copy, or undefined: opened as the staging opens a file (a link, a folder or a FIFO is refused, and the handle must be the file the
   * name led to) and read FROM THE HANDLE, at most the record bound plus one byte, so that a file that grows after a look at its size cannot be read whole.
   */
  async #readRecordCopy(path: string): Promise<string | undefined> {
    const handle = await openRegularNoFollow(path, this.#options.ops === undefined ? {} : { ops: this.#options.ops });
    try {
      if ((await handle.stat()).size > MAX_RECORD_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_RECORD_FILE_BYTES + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return filled > MAX_RECORD_FILE_BYTES ? undefined : buffer.subarray(0, filled).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  /**
   * Whether a quarantined copy of a RECORD can be brought back to `recordName`: it is no larger than a record may be, reads as a record of this version, is trusted under that
   * name, and the file in `media/` that it names is the size it says (a truncated or altered copy is not the record of the file that is there). Only the SIZE of that file is
   * checked here: its sha256 is checked by every reader (`integrityOf`) when the file is read, and hashing up to 2 GiB for each record would be the cost the hashing budget bounds.
   */
  async #fitsRecord(from: string, recordName: string): Promise<boolean> {
    try {
      const text = await this.#readRecordCopy(from);
      if (text === undefined) return false;
      const parsed = RecordShape.safeParse(JSON.parse(text));
      if (!parsed.success || !this.#trusted(parsed.data, recordName)) return false;
      const size = await lstat(join(this.#dir, parsed.data.file)).then((info) => (info.isFile() ? info.size : -1), () => -1);
      return size === parsed.data.bytes;
    } catch {
      return false;
    }
  }

  /**
   * Brings a piece from the quarantine to `media/` under its own name, NEVER over a file that is there: a hard link fails when the name is taken (no look-then-move gap),
   * and the quarantine's own name is removed after. A volume that cannot make a hard link falls back to a look and a rename. False when the name is taken or the move failed.
   */
  async #restore(from: string, name: string): Promise<boolean> {
    const target = join(this.#dir, name);
    try {
      try {
        await (this.#options.fs?.link ?? link)(from, target);
        await this.#unlink(from).catch(() => undefined);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) return false;
        // No hard links here (exFAT, some network shares): a look, then a rename.
        const taken = await (this.#options.fs?.lstat ?? lstat)(target).then(
          () => true,
          () => false,
        );
        if (taken) return false;
        await this.#rename(from, target);
      }
      await fsyncDir(this.#dir).catch(() => undefined);
      await fsyncDir(dirname(from)).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether `<root>/media` is a real folder inside the library root: a link or a junction is not one. */
  async #dirState(): Promise<DirState> {
    let info;
    try {
      info = await lstat(this.#dir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return "absent";
      return "unsafe";
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return "unsafe";
    try {
      const [root, real] = await Promise.all([realpath(this.#options.root), realpath(this.#dir)]);
      const inside = relative(root, real);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return "unsafe";
    } catch {
      return "unsafe";
    }
    return "ok";
  }

  #expectedFile(id: string, format: MediaFormat): string {
    return `${id}.${MEDIA_EXTENSIONS[format]}`;
  }

  /** The record's fields that the contract's `MediaSummary` has, before they are judged. */
  #summaryFieldsOf(record: RecordShape): Record<string, unknown> {
    return {
      mediaId: record.id,
      kind: record.kind,
      name: record.name,
      bytes: record.bytes,
      createdAt: record.createdAt,
      width: record.width,
      height: record.height,
      durationMs: record.durationMs,
      sourceFps: record.sourceFps,
      hdrToSdr: record.hdrToSdr,
      loopFrames: record.loopFrames,
      delayFrames: record.delayFrames,
    };
  }

  #summaryOf(record: RecordShape): MediaSummary {
    return MediaSummary.parse(this.#summaryFieldsOf(record));
  }

  /** Whether a record read from disk is one this build trusts: its own id and file name, a format its kind may have, facts that fit. */
  #trusted(record: RecordShape, name: string): boolean {
    if (`${record.id}.json` !== name) return false;
    if (record.file !== this.#expectedFile(record.id, record.format)) return false;
    if (!FORMATS_OF_KIND[record.kind].includes(record.format)) return false;
    return MediaSummary.safeParse(this.#summaryFieldsOf(record)).success;
  }

  /**
   * Reads the folder at an open: removes a record's temp file a crash left, sets aside (never deletes) a stored file with no record, brings a piece back
   * from the quarantine when its other half is in `media/`, and lists the sound records. A record whose file is gone stays and is a `missing-file` problem. Additive: records already committed by this instance stay. A record that cannot be read, was
   * written by a newer Studio, or whose file is not the size it names is neither listed nor removed. Never throws for a file.
   */
  async recover(options: { readonly signal?: AbortSignal } = {}): Promise<MediaRecoveryReport> {
    const signal = options.signal;
    // A function, so that TypeScript does not read the first answer as the answer for the whole recover.
    const stopped = (): boolean => signal?.aborted === true;
    const budget = { left: this.#options.hashBudgetBytes ?? RECOVER_HASH_BUDGET_BYTES };
    const empty: MediaRecoveryReport = { listed: 0, quarantinedOrphans: 0, restored: 0, problems: [], unusable: false };
    const state = await this.#dirState();
    if (state === "absent") return empty;
    if (state === "unsafe") {
      this.#warn("the library's media folder is not a plain folder; own media are not read");
      return { ...empty, unusable: true };
    }
    let entries;
    try {
      entries = await readdir(this.#dir, { withFileTypes: true });
    } catch {
      this.#warn("the library's media folder could not be read; own media are not listed");
      return { ...empty, unusable: true };
    }
    const recordIds = new Set<string>();
    for (const entry of entries) {
      const match = RECORD_NAME.exec(entry.name);
      if (match?.[1] !== undefined && !entry.isDirectory()) recordIds.add(match[1]);
    }

    const problems: { file: string; reason: MediaProblemReason }[] = [];
    let quarantinedOrphans = 0;
    let notSetAside = 0;
    let restored = 0;
    const quarantine = new Quarantine(this.#options.root, this.#options.now, this.#options.quarantineDurability);
    let held: Map<string, string[]> | undefined;
    const dangling: { recordName: string; file: string; bytes: number; sha256: string }[] = [];
    // Brings a piece back from the quarantine: the newest copy that `fits` (see `#fitsRecord` and `#fitsFile`). A partial copy a sync left in a newer or older stamp, a copy of the
    // right size with the wrong content, and a record that cannot be trusted are each skipped, and the next copy is tried.
    // `stopped` is not `none`: a recover that was stopped did not find that there is no copy, and must not act as if it had (an orphan file would be set aside while its record
    // sits in the quarantine, and the pair never meet again).
    // `kept` is not `none` either: a copy EXISTS but was not brought back (it did not fit, could not be read for a moment, or the move was refused by a lock or a sync client, or the
    // name is taken already). Only «no copy at all» lets an orphan file be set aside; with a copy in the quarantine the file stays in `media/` and the next open tries again.
    const bringBack = async (name: string, fits: (from: string) => Promise<boolean>): Promise<"restored" | "none" | "kept" | "stopped"> => {
      const copies = (held ??= await this.#quarantinedMedia());
      for (const from of copies.get(name) ?? []) {
        if (stopped()) return "stopped";
        const fitted = await fits(from);
        if (stopped()) return "stopped";
        if (!fitted) continue;
        if (!(await this.#restore(from, name))) return "kept";
        copies.set(name, (copies.get(name) ?? []).filter((path) => path !== from));
        restored++;
        return "restored";
      }
      if (stopped()) return "stopped";
      return (copies.get(name)?.length ?? 0) > 0 ? "kept" : "none";
    };
    const enterJudged = async (recordName: string): Promise<void> => {
      const again = await this.#judge(recordName);
      if (again.kind === "record") {
        if (!this.#inFlight.has(again.record.id)) this.#enter(again.record);
      } else problems.push({ file: recordName, reason: again.kind === "problem" ? again.reason : "missing-file" });
    };
    for (const entry of entries) {
      if (entry.isFile() && (isTempName(entry.name) && RECORD_TEMP_NAME.test(entry.name))) await this.#removeQuietly(join(this.#dir, entry.name));
    }
    // In the order of their names, so that what a restart lists never depends on the disk's own listing order.
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (stopped()) break;
      const match = RECORD_NAME.exec(entry.name);
      if (match === null || !entry.isFile()) continue;
      const judged = await this.#judge(entry.name);
      if (judged.kind === "problem") problems.push({ file: entry.name, reason: judged.reason });
      else if (judged.kind === "dangling") dangling.push({ recordName: entry.name, file: judged.file, bytes: judged.bytes, sha256: judged.sha256 });
      else if (!this.#inFlight.has(judged.record.id)) this.#enter(judged.record);
    }
    // Told, not moved: a dangling record's file may be on its way. A file the quarantine holds under its name (an older open set it aside) is brought back to it. The smallest
    // go first, so that the hashing budget is spent on the most records; a record the budget did not reach stays `missing-file` and the next open carries on.
    dangling.sort((a, b) => a.bytes - b.bytes || (a.recordName < b.recordName ? -1 : a.recordName > b.recordName ? 1 : 0));
    for (const item of dangling) {
      if (stopped()) break;
      const outcome = await bringBack(item.file, (from) => this.#fitsFile(from, item.bytes, item.sha256, budget, signal));
      if (outcome === "stopped") break;
      if (outcome === "restored") await enterJudged(item.recordName);
      else problems.push({ file: item.recordName, reason: "missing-file" });
    }
    for (const entry of entries) {
      if (stopped()) break;
      if (!entry.isFile() || !ORPHAN_NAME.test(entry.name)) continue;
      const id = entry.name.slice(0, entry.name.lastIndexOf("."));
      // Judged AFTER the listing: a commit that ended since has its record in the index now, and its file is no orphan.
      if (recordIds.has(id) || this.#inFlight.has(id) || this.#index.has(id) || this.#deleting.has(id)) continue;
      // Its record may be in the quarantine (an older open set it aside): the pair is brought back together, and the file stays.
      const found = await bringBack(`${id}.json`, (from) => this.#fitsRecord(from, `${id}.json`));
      // A stop is not «no record found»: the file stays where it is, whatever else happens, and the next open looks again.
      if (found === "stopped" || stopped()) break;
      if (found === "restored") {
        await enterJudged(`${id}.json`);
        continue;
      }
      // A copy of its record exists and was not brought back (a lock, a name taken, a read that failed): the file stays beside the record it will meet.
      if (found === "kept") continue;
      const outcome = await this.#setAside(quarantine, join(this.#dir, entry.name));
      if (outcome === "moved") quarantinedOrphans++;
      else if (outcome === "failed") notSetAside++;
    }
    // One line each, with counts and never a path.
    if (problems.length > 0) {
      const byReason = new Map<MediaProblemReason, number>();
      for (const problem of problems) byReason.set(problem.reason, (byReason.get(problem.reason) ?? 0) + 1);
      this.#warn(`${problems.length} own-media record(s) not listed: ${[...byReason].map(([reason, count]) => `${count} ${reason}`).join(", ")}`);
    }
    if (quarantinedOrphans > 0) this.#warn(`${quarantinedOrphans} stored file(s) without a record were set aside in the library's quarantine folder`);
    if (notSetAside > 0) this.#warn(`${notSetAside} stored file(s) without a record could not be set aside; they stay where they are`);
    if (restored > 0) this.#warn(`${restored} piece(s) of own media were brought back from the library's quarantine folder`);
    return { listed: this.#index.size, quarantinedOrphans, restored, problems, unusable: false };
  }

  async #judge(name: string): Promise<{ kind: "record"; record: RecordShape } | { kind: "dangling"; file: string; bytes: number; sha256: string } | { kind: "problem"; reason: MediaProblemReason }> {
    let text: string;
    try {
      text = await readFile(join(this.#dir, name), "utf8");
    } catch {
      return { kind: "problem", reason: "unreadable" };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: "problem", reason: "unreadable" };
    }
    if (isFromNewerVersion(value, MEDIA_RECORD_SCHEMA_VERSION)) return { kind: "problem", reason: "too-new" };
    const parsed = RecordShape.safeParse(value);
    if (!parsed.success || !this.#trusted(parsed.data, name)) return { kind: "problem", reason: "unreadable" };
    const record = parsed.data;
    let info;
    try {
      info = await (this.#options.fs?.lstat ?? lstat)(join(this.#dir, record.file));
    } catch (error) {
      // Only a file that is NOT THERE makes a record dangling; any other error says nothing about the file (a cloud placeholder, a drive).
      if (hasErrorCode(error, "ENOENT")) return { kind: "dangling", file: record.file, bytes: record.bytes, sha256: record.sha256 };
      return { kind: "problem", reason: "damaged" };
    }
    if (!info.isFile() || info.size !== record.bytes) return { kind: "problem", reason: "damaged" };
    return { kind: "record", record };
  }

  #enter(record: RecordShape): void {
    if (this.#deleting.has(record.id)) return;
    if (!this.#index.has(record.id)) this.#order.set(record.id, ++this.#entered);
    this.#index.set(record.id, inIndex(record));
  }

  /** Newest first (the later one first when two share an instant), cut at `MAX_LISTED_MEDIA`; `total` counts every match. */
  list(kind?: MediaKind, mediaIds?: readonly string[]): { media: MediaSummary[]; total: number } {
    const named = mediaIds === undefined ? undefined : new Set(mediaIds);
    const all = [...this.#index.values()].filter((r) => (kind === undefined || r.kind === kind) && (named === undefined || named.has(r.id)));
    const orderOf = (record: RecordShape): number => this.#order.get(record.id) ?? 0;
    all.sort((a, b) => (a.createdAt === b.createdAt ? orderOf(b) - orderOf(a) : a.createdAt < b.createdAt ? 1 : -1));
    return { media: all.slice(0, MAX_LISTED_MEDIA).map((r) => this.#summaryOf(r)), total: all.length };
  }

  get(mediaId: string): MediaSummary | undefined {
    const record = this.#index.get(mediaId);
    return record === undefined ? undefined : this.#summaryOf(record);
  }

  /** Whether the library holds this media, of this kind when one is asked for. */
  has(mediaId: string, kind?: MediaKind): boolean {
    const record = this.#index.get(mediaId);
    return record !== undefined && (kind === undefined || record.kind === kind);
  }

  /** The stored file's path, for the engine's own reads (a render copies it, 3f.3b); never sent to a window. */
  filePath(mediaId: string): string | undefined {
    const record = this.#index.get(mediaId);
    return record === undefined ? undefined : join(this.#dir, record.file);
  }

  /** The sha256 and format the record holds, for a reader that checks the file again before it uses it. */
  integrityOf(mediaId: string): { sha256: string; bytes: number; format: MediaFormat } | undefined {
    const record = this.#index.get(mediaId);
    return record === undefined ? undefined : { sha256: record.sha256, bytes: record.bytes, format: record.format };
  }

  count(): number {
    return this.#index.size;
  }

  /**
   * A track's waveform, read from its record on disk, or undefined: an id the library does not hold, a media that is not a track, a record
   * with none, one that is gone, a link, one too large to be a record, one that names another media, or a waveform that is not what the commit wrote
   * (a list of integers 0 to 1000). The record is opened as the staging opens a file (`openRegularNoFollow`: a link, a folder or a FIFO is refused by the
   * name, and the handle must be the file the name led to) and read FROM THE HANDLE, at most its bound plus one byte (3f.4 review L1: a check by path and a
   * read by path have a gap between them and no bound); nothing here throws for a file.
   */
  async waveformOf(mediaId: string): Promise<number[] | undefined> {
    const held = this.#index.get(mediaId);
    if (held === undefined || held.kind !== "audio") return undefined;
    const path = join(this.#dir, `${held.id}.json`);
    try {
      if ((await this.#dirState()) !== "ok") return undefined;
      const text = await this.#readRecordCopy(path);
      if (text === undefined) return undefined;
      const parsed = RecordWaveform.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.id === held.id ? parsed.data.waveform : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Stores the file and writes its record. Refused (`MediaCommitError`, nothing moved) for facts that do not fit the kind, a source that
   * is not a plain file directly in the staging folder, an id already taken, or a signal that already fired. A failure after the file
   * was moved takes it back out. A cancel before the record is durable removes the stored file; once the record is durable the
   * commit has happened and a later cancel changes nothing.
   */
  async commit(input: MediaCommitInput, signal?: AbortSignal): Promise<MediaSummary> {
    const aborted = (): boolean => signal?.aborted === true;
    const cancelled = (): MediaCommitError => new MediaCommitError("cancelled", "the import was cancelled");
    if (aborted()) throw cancelled();

    const candidate = {
      mediaId: "media-00000000",
      kind: input.kind,
      name: input.name,
      bytes: 1,
      createdAt: this.#options.now().toISOString(),
      width: input.facts.width,
      height: input.facts.height,
      durationMs: input.facts.durationMs,
      sourceFps: input.facts.sourceFps,
      hdrToSdr: input.facts.hdrToSdr,
      loopFrames: input.facts.loopFrames,
      delayFrames: input.facts.delayFrames === null ? null : [...input.facts.delayFrames],
    };
    if (!MediaSummary.safeParse(candidate).success) throw new MediaCommitError("invalid", "the file's facts do not fit its kind");
    if (!FORMATS_OF_KIND[input.kind].includes(input.format)) throw new MediaCommitError("invalid", `a ${input.kind} is not stored as ${input.format}`);
    if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) throw new MediaCommitError("invalid", "the hash is not a sha256");
    // Only a track has a waveform, and it is what the envelope is: judged before anything moves.
    if (input.waveform !== undefined && (input.kind !== "audio" || !Waveform.safeParse(input.waveform).success)) throw new MediaCommitError("invalid", "the waveform does not fit a track");

    if ((await this.#dirState()) !== "ok") throw new MediaCommitError("unsafe", "the library's media folder is not a plain folder");
    const source = resolve(input.sourcePath);
    if (dirname(source) !== this.#staging || source.endsWith("..")) throw new MediaCommitError("unsafe", "the file is not in the staging folder");
    let stagingInfo;
    try {
      stagingInfo = await lstat(this.#staging);
    } catch {
      throw new MediaCommitError("unsafe", "the staging folder is not there");
    }
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) throw new MediaCommitError("unsafe", "the staging folder is not a plain folder");
    let info;
    try {
      info = await lstat(source);
    } catch {
      throw new MediaCommitError("unsafe", "the staged file is not there");
    }
    if (!info.isFile()) throw new MediaCommitError("unsafe", "the staged file is not a plain file");
    if (info.size === 0) throw new MediaCommitError("invalid", "the file has no bytes");

    const id = this.#options.newId();
    if (!Id.safeParse(id).success) throw new MediaCommitError("invalid", "no media id could be made");
    const file = this.#expectedFile(id, input.format);
    const target = join(this.#dir, file);
    const recordPath = join(this.#dir, `${id}.json`);
    if (this.#index.has(id) || this.#deleting.has(id) || this.#inFlight.has(id) || (await exists(target)) || (await exists(recordPath))) throw new MediaCommitError("exists", "that media id is already taken");

    this.#inFlight.add(id);
    let stored = false;
    try {
      const sha256 = input.sha256 ?? (await hashFile(source));
      if (aborted()) throw cancelled();
      // Durable before it is renamed into its name: a record must never name a file the disk may not have.
      await fsyncFile(source);
      await this.#rename(source, target);
      stored = true;
      await fsyncDir(this.#dir);
      await this.#options.hooks?.afterFileStored?.();
      if (aborted()) throw cancelled();

      const record: RecordShape = {
        schemaVersion: MEDIA_RECORD_SCHEMA_VERSION,
        id,
        kind: input.kind,
        name: input.name,
        createdAt: candidate.createdAt,
        bytes: info.size,
        sha256,
        format: input.format,
        file,
        width: input.facts.width,
        height: input.facts.height,
        durationMs: input.facts.durationMs,
        sourceFps: input.facts.sourceFps,
        hdrToSdr: input.facts.hdrToSdr,
        loopFrames: input.facts.loopFrames,
        delayFrames: candidate.delayFrames,
        ...(input.waveform === undefined ? {} : { waveform: [...input.waveform] }),
      };
      const hook = this.#options.hooks?.beforeRecordRename;
      await writeJsonAtomic(recordPath, record, hook === undefined ? {} : { beforeRename: hook });
      this.#enter(record);
      return this.#summaryOf(record);
    } catch (error) {
      // A crash cannot clean up after itself: the disk is left as the crash left it, and the next open settles it.
      if (this.#options.hooks?.treatAsCrash?.(error) === true) throw error;
      await this.#takeBack(id, stored ? target : null);
      if (error instanceof MediaCommitError) throw error;
      if (isNoSpaceError(error)) throw new MediaCommitError("no-space", "the library's disk is full; the media could not be stored");
      throw new MediaCommitError("disk", `the media could not be stored (${errorCodeOf(error) ?? "error"})`);
    } finally {
      this.#inFlight.delete(id);
    }
  }

  /** Puts a commit that did not finish back as it was: the stored file and the record's temp files go. Quiet; the next open settles what is left. */
  async #takeBack(id: string, target: string | null): Promise<void> {
    if (target !== null) await this.#removeQuietly(target);
    const temp = new RegExp(`^\\.${id}\\.json\\.[0-9a-f]{12}\\.tmp$`);
    for (const name of await readdir(this.#dir).catch(() => [] as string[])) {
      if (temp.test(name)) await this.#removeQuietly(join(this.#dir, name));
    }
  }

  /**
   * Removes the record, then its file. The record goes FIRST: from that moment the media is gone for every reader, and a file that then
   * cannot be removed is an orphan the next open sets aside in the quarantine. False for an id the library does not hold. A record that cannot be removed
   * leaves everything as it was and throws. The file removed is the one the record's id and format name, inside the media folder, by
   * its name: `unlink` never follows a link.
   */
  async remove(mediaId: string): Promise<boolean> {
    if (!Id.safeParse(mediaId).success) return false;
    const record = this.#index.get(mediaId);
    if (record === undefined) return false;
    // Taken out of the index BEFORE the first await: from this tick nobody finds it (a render that looks the media up and reserves it
    // with no await between the two cannot take a media whose delete has begun), and a second removal finds nothing to remove.
    this.#index.delete(mediaId);
    this.#deleting.set(mediaId, record);
    try {
      if ((await this.#dirState()) !== "ok") throw new MediaDiskError("the media folder is not usable", "EUNSAFE");
      try {
        await this.#unlink(join(this.#dir, `${record.id}.json`));
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw new MediaDiskError("the media record could not be removed", errorCodeOf(error) ?? "error");
      }
    } catch (error) {
      // Nothing was removed: the media is back as it was, in the same place of the listing (its order was never dropped).
      this.#deleting.delete(mediaId);
      this.#index.set(mediaId, record);
      throw error;
    }
    this.#deleting.delete(mediaId);
    this.#order.delete(mediaId);
    await fsyncDir(this.#dir).catch(() => undefined);
    // The name is rebuilt from the id and format, never taken from the record's own `file` text.
    await this.#removeQuietly(join(this.#dir, basename(this.#expectedFile(record.id, record.format))));
    return true;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Quarantine stamps by their time: `<iso>Z`, then `<iso>Z-<n>` for a folder made in the same millisecond, ordered by `n` as a number (`-10` is after `-2`). */
function compareStamps(a: string, b: string): number {
  const split = (stamp: string): { base: string; n: number } | null => {
    const match = /^(.*Z)(?:-(\d+))?$/.exec(stamp);
    return match?.[1] === undefined ? null : { base: match[1], n: match[2] === undefined ? 0 : Number(match[2]) };
  };
  const left = split(a);
  const right = split(b);
  // Total: every real stamp is after every name that is not one, and the names that are not stamps are ordered among themselves as text.
  if (left === null && right === null) return a < b ? -1 : a > b ? 1 : 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left.base !== right.base) return left.base < right.base ? -1 : 1;
  return left.n - right.n;
}

/**
 * The sha256 of a file read from an OPENED handle (a link, a folder or a FIFO is refused, and the handle must be the file the name led to), with that handle's identity, under
 * `signal` (checked between chunks; an abort rejects with an AbortError).
 */
async function hashCopy(path: string, signal: AbortSignal | undefined, ops: OpenRegularOps | undefined): Promise<{ sha256: string; identity: BigIntStats }> {
  const handle = await openRegularNoFollow(path, ops === undefined ? {} : { ops });
  try {
    const identity = await handle.stat({ bigint: true });
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (let at = 0; ; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      at += bytesRead;
    }
    return { sha256: hash.digest("hex"), identity };
  } finally {
    await handle.close();
  }
}

/** The sha256 of a file, read as a stream under `signal` (an abort rejects the read with an AbortError). */
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, signal === undefined ? {} : { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
