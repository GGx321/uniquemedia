import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { Id, MAX_LISTED_MEDIA, MediaFileName, MediaKind, MediaSummary } from "../../shared/engine";
import type { MediaFormat } from "../media/sniff";
import { fsyncDir, fsyncFile, hasErrorCode, isTempName, writeJsonAtomic } from "./durableFs";
import { isFromNewerVersion, MEDIA_DIR, MEDIA_RECORD_SCHEMA_VERSION, MEDIA_STAGING_DIR } from "./layout";
import { renameWithRetry } from "./renameRetry";
import { unlinkWithRetry } from "./unlinkRetry";

// The own-media records (Stage 3, 3f.1b; K28): `<library>/media/<mediaId>.json` beside the stored file `<mediaId>.<ext>`.
//
// WRITE-ONCE, ATOMIC. A record is written with the library's own helper (temp, fsync, rename, fsync of the folder), so a reader or a
// restart sees the whole record or none. The stored file is made durable and renamed into its name BEFORE the record is written, so
// a record never names a file that is not on disk; the crash windows are:
//   - before the file is stored: the staged copy is left to the staging cleanup;
//   - the file is stored, the record is not (an ORPHAN file): `recover` removes it at the next open;
//   - the record's temp file is left: `recover` sweeps it;
//   - the record is written: complete. A record whose file is gone (DANGLING) names nothing and is removed at the next open.
// An import interrupted by a crash is therefore CLEANED UP, never resumed: the source path is not kept anywhere (invariant 34), so
// there is nothing to resume from, and the owner picks the file again.
//
// NOTHING OUTSIDE `<library>/media/` IS EVER TOUCHED. The folder must be a real folder (an `lstat` refuses a link or a junction) that
// resolves inside the library root. A record's `file` must be exactly `<its id>.<the extension of its format>`: a record can never
// point a removal at another name. Only files of that shape, with no record at all, are removed as orphans; a record that cannot be
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
  readonly sha256?: string;
}

export type MediaCommitFailure = "invalid" | "unsafe" | "exists" | "cancelled" | "disk";

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

/** Test seam: a crash. A commit does not clean up after it, because a crash cannot: the disk is left as it is. */
export class SimulatedCrash extends Error {
  constructor() {
    super("simulated crash");
    this.name = "SimulatedCrash";
  }
}

export interface MediaRecordsOptions {
  /** The library's root: records live in `<root>/media`. */
  readonly root: string;
  readonly newId: () => string;
  readonly now: () => Date;
  /** Where a failure that stops nothing is told (never with a path). */
  readonly warn?: (text: string) => void;
  /** The disk calls of removal and the platform their retries are for, for a test that plays Windows' held handles. */
  readonly fs?: {
    readonly unlink?: (path: string) => Promise<void>;
    readonly rename?: (from: string, to: string) => Promise<void>;
    readonly platform?: string;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly delaysMs?: readonly number[];
  };
  /** Test seams: points in a commit where a crash can be played. */
  readonly hooks?: {
    /** After the file is in its place and before the record is written. */
    readonly afterFileStored?: () => void | Promise<void>;
    /** After the record's temp file is durable and before it is renamed into place (`writeFileAtomic`'s own seam). */
    readonly beforeRecordRename?: (finalPath: string) => void | Promise<void>;
  };
}

export type MediaProblemReason = "unreadable" | "too-new" | "damaged";
export interface MediaRecoveryReport {
  /** Records read and listed. */
  readonly listed: number;
  /** Stored files with no record at all, removed. */
  readonly removedOrphans: number;
  /** Records whose file is gone, removed. */
  readonly removedDangling: number;
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
   * Reads the folder at an open: removes what a crash left (a record's temp file, a stored file with no record, a record whose file is
   * gone) and lists the sound records. Additive: records already committed by this instance stay. A record that cannot be read, was
   * written by a newer Studio, or whose file is not the size it names is neither listed nor removed. Never throws for a file.
   */
  async recover(): Promise<MediaRecoveryReport> {
    const empty: MediaRecoveryReport = { listed: 0, removedOrphans: 0, removedDangling: 0, problems: [], unusable: false };
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
    let removedDangling = 0;
    let removedOrphans = 0;
    for (const entry of entries) {
      if (entry.isFile() && (isTempName(entry.name) && RECORD_TEMP_NAME.test(entry.name))) await this.#removeQuietly(join(this.#dir, entry.name));
    }
    for (const entry of entries) {
      const match = RECORD_NAME.exec(entry.name);
      if (match === null || !entry.isFile()) continue;
      const judged = await this.#judge(entry.name);
      if (judged.kind === "problem") problems.push({ file: entry.name, reason: judged.reason });
      else if (judged.kind === "dangling") {
        if (await this.#removeQuietly(join(this.#dir, entry.name))) removedDangling++;
      } else if (!this.#inFlight.has(judged.record.id)) this.#index.set(judged.record.id, judged.record);
    }
    for (const entry of entries) {
      if (!entry.isFile() || !ORPHAN_NAME.test(entry.name)) continue;
      const id = entry.name.slice(0, entry.name.lastIndexOf("."));
      if (recordIds.has(id) || this.#inFlight.has(id)) continue;
      if (await this.#removeQuietly(join(this.#dir, entry.name))) removedOrphans++;
    }
    return { listed: this.#index.size, removedOrphans, removedDangling, problems, unusable: false };
  }

  async #judge(name: string): Promise<{ kind: "record"; record: RecordShape } | { kind: "dangling" } | { kind: "problem"; reason: MediaProblemReason }> {
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
      info = await lstat(join(this.#dir, record.file));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { kind: "dangling" };
      return { kind: "problem", reason: "damaged" };
    }
    if (!info.isFile() || info.size !== record.bytes) return { kind: "problem", reason: "damaged" };
    return { kind: "record", record };
  }

  /** Newest first (then by id), cut at `MAX_LISTED_MEDIA`; `total` counts every match. */
  list(kind?: MediaKind): { media: MediaSummary[]; total: number } {
    const all = [...this.#index.values()].filter((r) => kind === undefined || r.kind === kind);
    all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
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
    if (this.#index.has(id) || this.#inFlight.has(id) || (await exists(target)) || (await exists(recordPath))) throw new MediaCommitError("exists", "that media id is already taken");

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
      };
      const hook = this.#options.hooks?.beforeRecordRename;
      await writeJsonAtomic(recordPath, record, hook === undefined ? {} : { beforeRename: hook });
      this.#index.set(id, record);
      return this.#summaryOf(record);
    } catch (error) {
      // A crash cannot clean up after itself: the disk is left as the crash left it, and the next open settles it.
      if (!(error instanceof SimulatedCrash)) await this.#takeBack(id, stored ? target : null);
      if (error instanceof MediaCommitError) throw error;
      if (error instanceof SimulatedCrash) throw error;
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
   * cannot be removed is an orphan the next open removes. False for an id the library does not hold. A record that cannot be removed
   * leaves everything as it was and throws. The file removed is the one the record's id and format name, inside the media folder, by
   * its name: `unlink` never follows a link.
   */
  async remove(mediaId: string): Promise<boolean> {
    if (!Id.safeParse(mediaId).success) return false;
    const record = this.#index.get(mediaId);
    if (record === undefined) return false;
    if ((await this.#dirState()) !== "ok") throw new MediaDiskError("the media folder is not usable", "EUNSAFE");
    try {
      await this.#unlink(join(this.#dir, `${record.id}.json`));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw new MediaDiskError("the media record could not be removed", errorCodeOf(error) ?? "error");
    }
    this.#index.delete(mediaId);
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Used by the engine to make the media folder before the first import (the staging makes it too; this is for a library with neither). */
export async function ensureMediaDir(root: string): Promise<void> {
  await mkdir(join(root, MEDIA_DIR), { recursive: true });
}
