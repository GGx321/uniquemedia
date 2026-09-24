import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { runFfmpeg } from "../../node/runFfmpeg";
import {
  appendJsonLine,
  fsyncDir,
  fsyncFile,
  hasErrorCode,
  readJsonFile,
  readJsonl,
  tempSiblingPath,
  writeFileAtomic,
  writeFileDurable,
  writeJsonAtomic,
} from "./durableFs";
import { LibraryError } from "./errors";
import { isLibraryId } from "./ids";
import { runExclusive } from "./keyedMutex";
import {
  AVATARS_DIR,
  HISTORY_FILE,
  JOURNAL_FILE,
  LIBRARY_FILE,
  MANIFEST_FILE,
  PHOTOS_DIR,
  PLAN_FILE,
  RUNS_DIR,
  THUMBS_DIR,
  USED_FILE,
  isFromNewerVersion,
  isLibraryFileTemp,
} from "./layout";
import { extensionFor, sniffImageMediaType, type ImageMediaType } from "./media";
import { Quarantine, type QuarantineEntry } from "./quarantine";
import { renameWithRetry } from "./renameRetry";
import {
  AvatarManifestSchema,
  HistoryEntrySchema,
  LibraryFileSchema,
  PhotoSidecarSchema,
  UsedEntrySchema,
  type AvatarManifest,
  type AvatarStatus,
  type HistoryEntry,
  type PhotoQa,
  type PhotoSidecar,
  type PhotoSource,
} from "./schemas";
import { surveyLibrary, type LogIssue } from "./survey";

export type { QuarantineEntry, QuarantineReason } from "./quarantine";
export type { LogIssue } from "./survey";

export interface LibraryDeps {
  now?: () => Date;
  newId?: () => string;
  /** Renders `input` as a WebP thumbnail at `output`; defaults to the bundled ffmpeg. */
  renderThumbnail?: (input: string, output: string) => Promise<void>;
  /** Test seam: called after each temp file or temp folder is durable and
   *  before it is renamed into place. Throwing simulates a crash there. */
  testHooks?: { beforeRename?: (finalPath: string) => void | Promise<void> };
}

/** An avatar whose manifest names a face reference the library cannot use. */
export interface MasterIssue {
  avatarId: string;
  masterPhotoId: string;
  reason: "missing" | "other-avatar";
}

export interface OpenReport {
  avatars: number;
  photos: number;
  quarantined: QuarantineEntry[];
  masterIssues: MasterIssue[];
  logIssues: LogIssue[];
}

export interface ReferencePhoto {
  photo: PhotoSidecar;
  path: string;
}

export type NewAvatar = Pick<AvatarManifest, "name" | "age" | "traits" | "descriptor">;
export type AvatarPatch = Partial<Pick<AvatarManifest, "name" | "status" | "masterPhotoId">>;

export interface JournalRead<T> {
  events: T[];
  /** Text after the last newline: an append a crash cut short. Not an event. */
  torn: string | null;
}

export interface NewPhotoMeta {
  mediaType: ImageMediaType;
  width: number;
  height: number;
  source: PhotoSource;
  qa?: PhotoQa;
}

const THUMB_WIDTH = 360;

// Files an OS drops into any folder it has shown; they do not make a folder "used".
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function byCreation(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class Library {
  readonly root: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #beforeRename: ((finalPath: string) => void | Promise<void>) | undefined;
  readonly #renderThumbnail: (input: string, output: string) => Promise<void>;
  readonly #thumbRenders = new Map<string, Promise<string>>();
  readonly #avatars = new Map<string, AvatarManifest>();
  readonly #photos = new Map<string, PhotoSidecar>();
  readonly #used = new Set<string>();
  /** Avatars whose used.jsonl has a bad line, with the reason. */
  readonly #brokenUsedLogs = new Map<string, string>();

  private constructor(root: string, deps: LibraryDeps) {
    this.root = root;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#beforeRename = deps.testHooks?.beforeRename;
    this.#renderThumbnail = deps.renderThumbnail ?? renderWebpThumbnail;
  }

  /**
   * Opens (or initialises) a library in two phases: a read-only survey that
   * validates everything and plans what to quarantine, then the moves. A
   * library written by a newer version is refused in the first phase, so
   * refusing it leaves the folder exactly as it was.
   */
  static async open(root: string, deps: LibraryDeps): Promise<{ library: Library; report: OpenReport }> {
    const library = new Library(root, deps);
    await ensureLibraryFile(root, library.#now);
    const survey = await surveyLibrary(root);

    await mkdir(library.#avatarsDir(), { recursive: true });
    await mkdir(library.#runsDir(), { recursive: true });
    const quarantine = new Quarantine(root, library.#now);
    for (const move of survey.moves) await quarantine.move(move.path, move.reason, move.detail);

    for (const avatar of survey.avatars) library.#avatars.set(avatar.id, avatar);
    for (const photo of survey.photos) library.#photos.set(photo.id, photo);
    for (const photoId of survey.usedPhotoIds) library.#used.add(photoId);
    for (const issue of survey.logIssues) library.#brokenUsedLogs.set(issue.avatarId, issue.detail);

    // Reported, never "fixed" by rewriting the manifest: restoring the photo
    // from quarantine heals the avatar. Until then referencePhoto() is null.
    const masterIssues: MasterIssue[] = [];
    for (const avatar of library.listAvatars()) {
      if (avatar.masterPhotoId === null) continue;
      const reason = library.#referenceProblem(avatar.id, avatar.masterPhotoId);
      if (reason !== null) masterIssues.push({ avatarId: avatar.id, masterPhotoId: avatar.masterPhotoId, reason });
    }
    return {
      library,
      report: {
        avatars: library.#avatars.size,
        photos: library.#photos.size,
        quarantined: quarantine.entries,
        masterIssues,
        logIssues: survey.logIssues,
      },
    };
  }

  async createAvatar(input: NewAvatar): Promise<AvatarManifest> {
    const id = this.#takeId();
    const manifest = this.#validManifest({
      ...input,
      schemaVersion: 1,
      id,
      masterPhotoId: null,
      status: "draft",
      createdAt: this.#now().toISOString(),
    });

    // The avatar folder appears in one rename, manifest and all, so a crash
    // can never leave an avatar folder without its manifest.
    const finalDir = this.#avatarDir(id);
    const tempDir = tempSiblingPath(finalDir);
    await mkdir(join(tempDir, PHOTOS_DIR), { recursive: true });
    await writeFileDurable(join(tempDir, MANIFEST_FILE), toJson(manifest));
    await fsyncDir(tempDir);
    await this.#beforeRename?.(finalDir);
    await renameWithRetry(tempDir, finalDir);
    await fsyncDir(this.#avatarsDir());

    this.#avatars.set(id, manifest);
    return manifest;
  }

  getAvatar(avatarId: string): AvatarManifest | undefined {
    return this.#avatars.get(avatarId);
  }

  /** Oldest first; `status` keeps only avatars in one of the given states. */
  listAvatars(filter: { status?: readonly AvatarStatus[] } = {}): AvatarManifest[] {
    const { status } = filter;
    return [...this.#avatars.values()]
      .filter((a) => status === undefined || status.includes(a.status))
      .sort(byCreation);
  }

  async updateAvatar(avatarId: string, patch: AvatarPatch): Promise<AvatarManifest> {
    const path = join(this.#avatarDir(avatarId), MANIFEST_FILE);
    return runExclusive(`manifest:${path}`, async () => {
      const current = this.#avatars.get(avatarId);
      if (!current) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
      // Invariant 9: the face reference is always one of this avatar's
      // committed, generated photos — never a path or an outside file.
      if (patch.masterPhotoId != null && this.#referenceProblem(avatarId, patch.masterPhotoId) !== null) {
        throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${patch.masterPhotoId}`);
      }
      const next = this.#validManifest({ ...current, ...patch });
      await writeJsonAtomic(path, next, { beforeRename: this.#beforeRename });
      this.#avatars.set(avatarId, next);
      return next;
    });
  }

  /**
   * Stores one generated frame (invariant 11): the image is written to a temp
   * name, fsynced and renamed first; the sidecar follows the same way and is
   * the commit. A crash in between leaves an image without a sidecar, which
   * the next open quarantines.
   */
  async addPhoto(avatarId: string, bytes: Uint8Array, meta: NewPhotoMeta): Promise<PhotoSidecar> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const actual = sniffImageMediaType(bytes);
    if (actual !== meta.mediaType) {
      throw new LibraryError("media-type-mismatch", `bytes are ${actual ?? "not a known image"}, not ${meta.mediaType}`);
    }
    const id = this.#takeId();
    const candidate = {
      schemaVersion: 1,
      id,
      avatarId,
      file: `${id}.${extensionFor(meta.mediaType)}`,
      mediaType: meta.mediaType,
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: meta.source,
      qa: meta.qa ?? {},
      createdAt: this.#now().toISOString(),
    };
    const result = PhotoSidecarSchema.safeParse(candidate);
    if (!result.success) throw new LibraryError("invalid-record", `invalid photo record: ${result.error.message}`);
    const sidecar = result.data;

    const photosDir = this.#photosDir(avatarId);
    const options = { beforeRename: this.#beforeRename };
    await writeFileAtomic(join(photosDir, sidecar.file), bytes, options);
    await writeJsonAtomic(join(photosDir, `${id}.json`), sidecar, options);

    this.#photos.set(id, sidecar);
    return sidecar;
  }

  /**
   * The avatar's face reference: its master photo, only while that photo is
   * a committed record of this same avatar (invariant 9). Null otherwise —
   * callers must refuse to generate without one.
   */
  referencePhoto(avatarId: string): ReferencePhoto | null {
    const avatar = this.#avatars.get(avatarId);
    // A draft's master is still a candidate being chosen, not a reference.
    if (!avatar || avatar.status === "draft" || avatar.masterPhotoId === null) return null;
    const masterPhotoId = avatar.masterPhotoId;
    const photo = this.#photos.get(masterPhotoId);
    if (!photo || photo.avatarId !== avatarId) return null;
    return { photo, path: join(this.#photosDir(avatarId), photo.file) };
  }

  getPhoto(photoId: string): PhotoSidecar | undefined {
    return this.#photos.get(photoId);
  }

  /** One avatar's photos, oldest first. */
  photosByAvatar(avatarId: string): PhotoSidecar[] {
    return [...this.#photos.values()].filter((p) => p.avatarId === avatarId).sort(byCreation);
  }

  photosByCategory(avatarId: string, category: string): PhotoSidecar[] {
    return this.photosByAvatar(avatarId).filter((p) => p.source.category === category);
  }

  /** Photos with no entry in the avatar's used.jsonl. */
  unusedPhotos(avatarId: string): PhotoSidecar[] {
    // Unreadable usage would make used photos look unused and get them reused.
    this.#assertUsedLogReadable(avatarId);
    return this.photosByAvatar(avatarId).filter((p) => !this.#used.has(p.id));
  }

  photoCount(avatarId: string): number {
    return this.photosByAvatar(avatarId).length;
  }

  /** Records that a video used a photo; the log is append-only. */
  async markUsed(photoId: string, videoId: string): Promise<void> {
    const photo = this.#photos.get(photoId);
    if (!photo) throw new LibraryError("photo-not-found", `no photo ${photoId}`);
    if (!isLibraryId(videoId)) throw new LibraryError("invalid-id", `video id ${JSON.stringify(videoId)} breaks the id pattern`);
    this.#assertUsedLogReadable(photo.avatarId);
    const entry = UsedEntrySchema.parse({ photoId, videoId, at: this.#now().toISOString() });
    await appendJsonLine(join(this.#avatarDir(photo.avatarId), USED_FILE), entry);
    this.#used.add(photoId);
  }

  /** Records the location + outfit pair a scene used, so the planner can avoid repeating it. */
  async appendHistory(avatarId: string, entry: HistoryEntry): Promise<void> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const result = HistoryEntrySchema.safeParse(entry);
    if (!result.success) throw new LibraryError("invalid-record", `invalid history entry: ${result.error.message}`);
    await appendJsonLine(join(this.#avatarDir(avatarId), HISTORY_FILE), result.data);
  }

  /** The last `n` history entries, most recent first (by append order). */
  async recentPairs(avatarId: string, n: number): Promise<HistoryEntry[]> {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer, got ${n}`);
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    if (n === 0) return [];
    const { entries } = await readJsonl(join(this.#avatarDir(avatarId), HISTORY_FILE), HistoryEntrySchema);
    return entries.slice(-n).reverse();
  }

  /**
   * Creates `runs/<runId>/plan.json`. The folder is built under a temp name
   * and renamed into place, so a run folder never exists without its plan.
   * The plan is validated by the caller's schema before anything is written.
   */
  async createRun<T>(runId: string, plan: T, schema: z.ZodType<T>): Promise<void> {
    const finalDir = this.#runDir(runId);
    const result = schema.safeParse(plan);
    if (!result.success) throw new LibraryError("invalid-record", `invalid run plan: ${result.error.message}`);

    await runExclusive(`run:${finalDir}`, async () => {
      if (await this.#runExists(runId)) throw new LibraryError("run-exists", `run ${runId} already exists`);
      const tempDir = tempSiblingPath(finalDir);
      await mkdir(tempDir);
      await writeFileDurable(join(tempDir, PLAN_FILE), toJson(result.data));
      await fsyncDir(tempDir);
      await this.#beforeRename?.(finalDir);
      await renameWithRetry(tempDir, finalDir);
      await fsyncDir(this.#runsDir());
    });
  }

  async readRun<T>(runId: string, schema: z.ZodType<T>): Promise<T> {
    const path = join(this.#runDir(runId), PLAN_FILE);
    const raw = await readJsonFile(path);
    if (!raw.ok) {
      if (!(await this.#runExists(runId))) throw new LibraryError("run-not-found", `no run ${runId}`);
      throw new LibraryError("invalid-run-plan", raw.detail);
    }
    const result = schema.safeParse(raw.value);
    if (!result.success) throw new LibraryError("invalid-run-plan", `${path}: ${result.error.message}`);
    return result.data;
  }

  /** Appends one event to `runs/<runId>/journal.jsonl` and fsyncs it before returning. */
  async appendJournal<T>(runId: string, event: T, schema: z.ZodType<T>): Promise<void> {
    const result = schema.safeParse(event);
    if (!result.success) throw new LibraryError("invalid-record", `invalid journal event: ${result.error.message}`);
    // Everything up to appendJsonLine is synchronous, so the append queues in
    // call order; the run check runs inside the log's lock.
    await appendJsonLine(join(this.#runDir(runId), JOURNAL_FILE), result.data, { guard: () => this.#assertRun(runId) });
  }

  /** All committed events in order, including every append issued before
   *  this call. A torn last line (a crash mid-append) is reported in `torn`
   *  and not returned; any other bad line throws. */
  async readJournal<T>(runId: string, schema: z.ZodType<T>): Promise<JournalRead<T>> {
    const path = join(this.#runDir(runId), JOURNAL_FILE);
    const { entries, torn } = await readJsonl(path, schema, { guard: () => this.#assertRun(runId) });
    return { events: entries, torn };
  }

  /**
   * A 360 px wide WebP of the photo at `thumbs/<photoId>.webp`, rendered once
   * and then served from disk. Rendered to a temp name, fsynced and renamed,
   * so a non-empty file at the final path is complete. Concurrent requests
   * for one thumbnail share a single render.
   */
  thumbnail(avatarId: string, photoId: string): Promise<string> {
    const photo = this.#photos.get(photoId);
    if (!photo || photo.avatarId !== avatarId) {
      return Promise.reject(new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${photoId}`));
    }
    const output = join(this.#avatarDir(avatarId), THUMBS_DIR, `${photoId}.webp`);
    const inFlight = this.#thumbRenders.get(output);
    if (inFlight) return inFlight;

    const task = this.#ensureThumbnail(join(this.#photosDir(avatarId), photo.file), output);
    const forget = () => void this.#thumbRenders.delete(output);
    task.then(forget, forget);
    this.#thumbRenders.set(output, task);
    return task;
  }

  async #ensureThumbnail(image: string, output: string): Promise<string> {
    if (await isNonEmptyFile(output)) return output;
    const thumbsDir = dirname(output);
    await mkdir(thumbsDir, { recursive: true });
    const temp = tempSiblingPath(output);
    await this.#renderThumbnail(image, temp);
    await fsyncFile(temp);
    await this.#beforeRename?.(output);
    await renameWithRetry(temp, output);
    await fsyncDir(thumbsDir);
    return output;
  }

  #assertUsedLogReadable(avatarId: string): void {
    const detail = this.#brokenUsedLogs.get(avatarId);
    if (detail !== undefined) {
      throw new LibraryError("log-needs-repair", `${USED_FILE} of avatar ${avatarId} needs repair: ${detail}`);
    }
  }

  #referenceProblem(avatarId: string, photoId: string): MasterIssue["reason"] | null {
    const photo = this.#photos.get(photoId);
    if (!photo) return "missing";
    return photo.avatarId === avatarId ? null : "other-avatar";
  }

  #takeId(): string {
    const id = this.#newId();
    if (!isLibraryId(id)) throw new LibraryError("invalid-id", `generated id ${JSON.stringify(id)} breaks the id pattern`);
    return id;
  }

  #validManifest(candidate: unknown): AvatarManifest {
    const result = AvatarManifestSchema.safeParse(candidate);
    if (!result.success) throw new LibraryError("invalid-record", `invalid avatar manifest: ${result.error.message}`);
    return result.data;
  }

  #avatarsDir(): string {
    return join(this.root, AVATARS_DIR);
  }

  #avatarDir(avatarId: string): string {
    return join(this.#avatarsDir(), avatarId);
  }

  #photosDir(avatarId: string): string {
    return join(this.#avatarDir(avatarId), PHOTOS_DIR);
  }

  #runsDir(): string {
    return join(this.root, RUNS_DIR);
  }

  /** Validates the id before it becomes a path segment. */
  #runDir(runId: string): string {
    if (!isLibraryId(runId)) throw new LibraryError("invalid-id", `run id ${JSON.stringify(runId)} breaks the id pattern`);
    return join(this.#runsDir(), runId);
  }

  async #assertRun(runId: string): Promise<void> {
    if (!(await this.#runExists(runId))) throw new LibraryError("run-not-found", `no run ${runId}`);
  }

  async #runExists(runId: string): Promise<boolean> {
    try {
      await stat(this.#runDir(runId));
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }
}

/** The bundled ffmpeg's libwebp encoder. `-f webp` because `output` is a
 *  `.tmp` name that says nothing about the format. */
async function renderWebpThumbnail(input: string, output: string): Promise<void> {
  await runFfmpeg({
    inputs: [{ path: input }],
    args: ["-vf", `scale=${THUMB_WIDTH}:-1`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-f", "webp"],
    output,
    durationSec: 1,
  });
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Validates library.json, or creates it in an empty folder. A folder is
 *  empty when it holds only OS metadata and the temp of a crashed attempt
 *  to write library.json itself. */
async function ensureLibraryFile(root: string, now: () => Date): Promise<void> {
  const path = join(root, LIBRARY_FILE);
  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  if (text === null) {
    const entries = await readdir(root);
    if (entries.some((name) => !OS_METADATA.has(name) && !isLibraryFileTemp(name))) {
      throw new LibraryError(
        "not-a-library",
        `${root} is not empty and has no ${LIBRARY_FILE}; choose an empty folder or an existing library`
      );
    }
    await writeJsonAtomic(path, LibraryFileSchema.parse({ schemaVersion: 1, createdAt: now().toISOString() }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LibraryError("invalid-library-file", `${path} is not valid JSON`);
  }
  if (isFromNewerVersion(parsed)) {
    throw new LibraryError("library-too-new", `${path} was written by a newer version of Studio; update the app`);
  }
  const result = LibraryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LibraryError("invalid-library-file", `${path} is not a supported library file: ${result.error.message}`);
  }
}

export function openLibrary(root: string, deps: LibraryDeps = {}): Promise<{ library: Library; report: OpenReport }> {
  return Library.open(root, deps);
}
