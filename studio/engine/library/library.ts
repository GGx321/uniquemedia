import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { downscaleToJpeg } from "../../node/downscale";
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
import { isEligiblePhoto, replayRejected, type PhotoState } from "./eligibility";
import { LibraryError } from "./errors";
import { isLibraryId } from "./ids";
import { runExclusive } from "./keyedMutex";
import {
  AVATARS_DIR,
  FOCUS_FILE,
  HISTORY_FILE,
  JOURNAL_FILE,
  LIBRARY_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  MONTAGES_DIR,
  PHOTOS_DIR,
  PLAN_FILE,
  RUNS_DIR,
  THUMBS_DIR,
  REJECTED_FILE,
  VIDEOS_DIR,
  isFromNewerVersion,
  LIBRARY_FILE_SCHEMA_VERSION,
  SIDECAR_SCHEMA_VERSION,
  isLibraryFileTemp,
} from "./layout";
import { extensionFor, sniffImageMediaType, type ImageMediaType, type LibraryReference } from "./media";
import { Quarantine, type QuarantineEntry } from "./quarantine";
import { looksLikeRunPhoto } from "./photoRecords";
import { renameWithRetry } from "./renameRetry";
import {
  AvatarManifestSchema,
  HistoryEntrySchema,
  LibraryFileSchema,
  PhotoSidecarSchema,
  RejectedEntrySchema,
  type AvatarManifest,
  type AvatarStatus,
  type HistoryEntry,
  type PhotoQa,
  type PhotoSidecar,
  type PhotoSource,
  type RejectedEntry,
} from "./schemas";
import { surveyLibrary, type LogIssue } from "./survey";
import { readVideoRecordFile, readVideoRecords, VIDEOS_NOT_A_FOLDER, type ReadVideoRecordsOptions, type VideoRecordProblem, type VideoRecordUse } from "./videoRecords";

export type { QuarantineEntry, QuarantineReason } from "./quarantine";
export type { LogIssue } from "./survey";

export interface LibraryDeps {
  now?: () => Date;
  newId?: () => string;
  /** Renders `input` as a WebP thumbnail at `output`; defaults to the bundled ffmpeg. */
  renderThumbnail?: (input: string, output: string) => Promise<void>;
  /** Test seam: called after each temp file or temp folder is durable and
   *  before it is renamed into place. Throwing simulates a crash there. */
  testHooks?: {
    beforeRename?: (finalPath: string) => void | Promise<void>;
    /** Called before each video record file is read by `reloadVideoRecords` and the quarantine, as part of the read: what it
     *  throws is what the read threw. */
    beforeReadVideoRecord?: (path: string) => void | Promise<void>;
  };
  /**
   * Downscales a face reference's raw bytes to the JPEG `ImageParams.references`
   * expects; defaults to `studio/node/downscale.ts`'s real one at
   * `REFERENCE_MAX_SIDE`. Only `loadReference()` calls this and brands its
   * result (invariant 9) — the size/quality 2b settles on is this
   * dependency's business, not `loadReference()`'s.
   */
  downscaleReference?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
  /**
   * The photos of `avatarId` that queued or running renders hold (S16), asked
   * afresh on every use. The real render queue provides it in task 3a.6; until
   * then, and in a library opened without one, nothing is reserved.
   *
   * ORDER, for the queue and 3a.8b: a render lets go of its reservation only
   * AFTER its record is in the used index (`addVideoRecordToIndex`), so there is
   * never a moment when its photos are neither reserved nor used. A failed or
   * cancelled render (no record) simply releases.
   */
  reservedPhotos?: (avatarId: string) => ReadonlySet<string>;
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
export type AvatarPatch = Partial<Pick<AvatarManifest, "name" | "status" | "masterPhotoId" | "descriptor">>;

/** T6c (M3): a whole imported avatar — the manifest fields and her one photo, published together in one atomic write. */
export type NewImportedAvatar = NewAvatar & {
  photoBytes: Uint8Array;
  photoMeta: NewPhotoMeta;
};

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

/**
 * The default `downscaleReference`'s longest side: the fixed decisions'
 * candidate portraits are already 1K (3:4), so this never upscales a real
 * master; 2b owns the final call on the size/quality an image model actually
 * wants for a reference and may inject its own `downscaleReference` instead.
 */
const REFERENCE_MAX_SIDE = 1024;

// Files an OS drops into any folder it has shown; they do not make a folder "used".
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Why an avatar's usage cannot be trusted (the contract's `UsageUnknownReason`, K16), in the order `usageReasons` names them. */
export type UsageReason = "library-too-new" | "index-stale" | "record-unreadable" | "record-inaccessible" | "rejects-unreadable";

/**
 * Whether the file behind `problem` still cannot be read as a record of `avatarId`, looked at once more right before it is moved
 * aside: a file that reads as sound now (fixed by hand, or replaced) stays, and so does one that is gone or was written by a
 * newer Studio meanwhile. A file the disk would not open now (`io`: no access, held, a cloud placeholder) stays too: its bytes
 * may be a sound record, and moving it would free its photos for a second video. `videos/` that is not a folder is checked as
 * that.
 */
async function stillUnreadable(avatarDir: string, avatarId: string, problem: VideoRecordProblem, options: ReadVideoRecordsOptions): Promise<boolean> {
  if (problem.file === VIDEOS_NOT_A_FOLDER.file) {
    try {
      return !(await lstat(join(avatarDir, VIDEOS_DIR))).isDirectory();
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  const name = problem.file.slice(`${VIDEOS_DIR}/`.length);
  const again = await readVideoRecordFile(avatarDir, avatarId, name, options);
  return again.kind === "problem" && again.problem.reason === "unreadable" && again.problem.io !== true;
}

/** One complete line of rejected.jsonl as a mark, or null when it is not one (the reader's own rule: JSON, then the schema). */
function parseRejectedLine(raw: string): RejectedEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RejectedEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function byCreation(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class Library {
  readonly root: string;
  /**
   * The folder's own `library.json` `createdAt` (review, real bug: canary
   * run 36272376999). A folder's canonical path plus its dev:ino
   * (folderIdentity) cannot tell a deleted-and-recreated folder from the
   * original on Linux, where a just-freed inode number is routinely reused
   * for the very next directory created — so `Engine#liveLibrary` checks
   * this too, read fresh from the live root before a paid write. Captured
   * once, at open, from whatever the folder's own library.json says (never
   * this run's own clock re-stamping it).
   */
  readonly createdAt: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #beforeRename: ((finalPath: string) => void | Promise<void>) | undefined;
  readonly #renderThumbnail: (input: string, output: string) => Promise<void>;
  readonly #downscaleReference: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly #thumbRenders = new Map<string, Promise<string>>();
  readonly #avatars = new Map<string, AvatarManifest>();
  readonly #photos = new Map<string, PhotoSidecar>();
  readonly #reservedPhotos: (avatarId: string) => ReadonlySet<string>;
  /** Photos the owner's marks leave rejected (rejected.jsonl replayed at open, then kept in step by setRejected). */
  readonly #rejected = new Set<string>();
  /** Avatars whose rejected.jsonl has a bad line, with the reason: none of their photos is eligible until it is repaired. */
  readonly #brokenRejectLogs = new Map<string, string>();
  /** Each avatar's readable video records: what "used" is derived from. */
  readonly #videosByAvatar = new Map<string, VideoRecordUse[]>();
  /** The photos of commit intents that are still pending (a crash's leftover recovery has not settled, or deferred), by video id: held like a reservation until the intent is adopted or dropped. */
  readonly #pendingHolds = new Map<string, { readonly avatarId: string; readonly photoIds: readonly string[] }>();
  /** Avatars with a file in videos/ that is not a usable record, with the reason: their usage cannot be trusted. */
  readonly #videoProblems = new Map<string, VideoRecordProblem[]>();
  /** Avatars whose used index missed a video that IS committed on disk (the commit's index update and its reload both failed), with those videos. */
  readonly #videoIndexStale = new Map<string, Set<string>>();
  /** Bumped by every incremental index change, so a reload that read the folder before it knows to read again. */
  readonly #videoGeneration = new Map<string, number>();
  readonly #beforeReadVideoRecord: ((path: string) => void | Promise<void>) | undefined;

  private constructor(root: string, deps: LibraryDeps, createdAt: string) {
    this.root = root;
    this.createdAt = createdAt;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#beforeRename = deps.testHooks?.beforeRename;
    this.#beforeReadVideoRecord = deps.testHooks?.beforeReadVideoRecord;
    this.#reservedPhotos = deps.reservedPhotos ?? (() => new Set<string>());
    this.#renderThumbnail = deps.renderThumbnail ?? renderWebpThumbnail;
    this.#downscaleReference = deps.downscaleReference ?? ((bytes, signal) => downscaleToJpeg(bytes, { maxSide: REFERENCE_MAX_SIDE, signal }));
  }

  /**
   * Opens (or initialises) a library in two phases: a read-only survey that
   * validates everything and plans what to quarantine, then the moves. A
   * library written by a newer version is refused in the first phase, so
   * refusing it leaves the folder exactly as it was.
   */
  static async open(root: string, deps: LibraryDeps): Promise<{ library: Library; report: OpenReport }> {
    const now = deps.now ?? (() => new Date());
    const createdAt = await ensureLibraryFile(root, now);
    const library = new Library(root, deps, createdAt);
    const survey = await surveyLibrary(root);

    await mkdir(library.#avatarsDir(), { recursive: true });
    await mkdir(library.#runsDir(), { recursive: true });
    const quarantine = new Quarantine(root, library.#now);
    for (const move of survey.moves) await quarantine.move(move.path, move.reason, move.detail);

    for (const avatar of survey.avatars) library.#avatars.set(avatar.id, avatar);
    for (const photo of survey.photos) library.#photos.set(photo.id, photo);
    for (const photoId of survey.rejectedPhotoIds) library.#rejected.add(photoId);
    for (const { avatarId, record } of survey.videoRecords) library.#videosByAvatar.set(avatarId, [...(library.#videosByAvatar.get(avatarId) ?? []), record]);
    for (const issue of survey.logIssues) {
      if (issue.file === REJECTED_FILE) {
        if (!library.#brokenRejectLogs.has(issue.avatarId)) library.#brokenRejectLogs.set(issue.avatarId, `${issue.file}: ${issue.detail}`);
      } else {
        const { avatarId, ...problem } = issue;
        library.#videoProblems.set(avatarId, [...(library.#videoProblems.get(avatarId) ?? []), problem]);
      }
    }

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
      schemaVersion: MANIFEST_SCHEMA_VERSION,
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

  /**
   * T6c (M3): imports an existing avatar atomically. The manifest (status
   * "active", her master already set), the photo file and its sidecar are
   * all written into one temp avatar folder, then published with ONE
   * rename — mirrors `createAvatar`'s own temp-dir-then-rename shape, so a
   * crash or a kill between the writes and the rename leaves nothing
   * published: no dangling avatar, no half-written manifest, no orphaned
   * draft with no photo. The crashed temp folder is left for the next
   * open's quarantine, exactly like `createAvatar`'s own.
   */
  async createImportedAvatar(input: NewImportedAvatar): Promise<{ avatar: AvatarManifest; photo: PhotoSidecar }> {
    const actual = sniffImageMediaType(input.photoBytes);
    if (actual !== input.photoMeta.mediaType) {
      throw new LibraryError("media-type-mismatch", `bytes are ${actual ?? "not a known image"}, not ${input.photoMeta.mediaType}`);
    }
    const avatarId = this.#takeId();
    const photoId = this.#takeId();
    const now = this.#now().toISOString();
    const manifest = this.#validManifest({
      name: input.name,
      age: input.age,
      traits: input.traits,
      descriptor: input.descriptor,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id: avatarId,
      masterPhotoId: photoId,
      status: "active",
      createdAt: now,
    });
    const sidecarCandidate = {
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      id: photoId,
      avatarId,
      file: `${photoId}.${extensionFor(input.photoMeta.mediaType)}`,
      mediaType: input.photoMeta.mediaType,
      width: input.photoMeta.width,
      height: input.photoMeta.height,
      bytes: input.photoBytes.length,
      sha256: createHash("sha256").update(input.photoBytes).digest("hex"),
      source: input.photoMeta.source,
      qa: input.photoMeta.qa ?? {},
      createdAt: now,
    };
    const sidecarResult = PhotoSidecarSchema.safeParse(sidecarCandidate);
    if (!sidecarResult.success) throw new LibraryError("invalid-record", `invalid photo record: ${sidecarResult.error.message}`);
    const sidecar = sidecarResult.data;

    // Everything lands in one temp folder — manifest, image, sidecar — so a
    // crash before the rename below leaves no avatar folder at all, not a
    // partial one.
    const finalDir = this.#avatarDir(avatarId);
    const tempDir = tempSiblingPath(finalDir);
    const tempPhotosDir = join(tempDir, PHOTOS_DIR);
    await mkdir(tempPhotosDir, { recursive: true });
    await writeFileDurable(join(tempDir, MANIFEST_FILE), toJson(manifest));
    await writeFileDurable(join(tempPhotosDir, sidecar.file), input.photoBytes);
    await writeFileDurable(join(tempPhotosDir, `${photoId}.json`), toJson(sidecar));
    await fsyncDir(tempPhotosDir);
    await fsyncDir(tempDir);
    await this.#beforeRename?.(finalDir);
    await renameWithRetry(tempDir, finalDir);
    await fsyncDir(this.#avatarsDir());

    this.#avatars.set(avatarId, manifest);
    this.#photos.set(photoId, sidecar);
    return { avatar: manifest, photo: sidecar };
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
      schemaVersion: SIDECAR_SCHEMA_VERSION,
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
   * Removes one of an avatar's photos: the sidecar first — it is the commit
   * (invariant 11), so a crash after it leaves an uncommitted image that the
   * next open quarantines — then the image and its thumbnail. The master
   * cannot be deleted: a manifest never names a missing master. Runs under
   * the manifest's lock, so a concurrent master change cannot pick it.
   */
  async deletePhoto(avatarId: string, photoId: string): Promise<void> {
    const manifestPath = join(this.#avatarDir(avatarId), MANIFEST_FILE);
    await runExclusive(`manifest:${manifestPath}`, async () => {
      const photo = this.#photos.get(photoId);
      if (!photo || photo.avatarId !== avatarId) throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${photoId}`);
      if (this.#avatars.get(avatarId)?.masterPhotoId === photoId) {
        throw new LibraryError("photo-is-master", `photo ${photoId} is the master of avatar ${avatarId}`);
      }
      await this.#removePhoto(photo);
    });
  }

  /** The sidecar (the commit) first, then the image and its thumbnail; the caller holds the manifest's lock. */
  async #removePhoto(photo: PhotoSidecar): Promise<void> {
    const photosDir = this.#photosDir(photo.avatarId);
    await rm(join(photosDir, `${photo.id}.json`), { force: true });
    await fsyncDir(photosDir);
    this.#photos.delete(photo.id);
    await rm(join(photosDir, photo.file), { force: true });
    await rm(join(this.#avatarDir(photo.avatarId), THUMBS_DIR, `${photo.id}.webp`), { force: true });
    await fsyncDir(photosDir);
  }

  /**
   * A draft becomes an active avatar: `masterPhotoId` (one of its photos) is
   * her master, and every other photo of the draft is deleted — other people
   * from the same descriptor, who must never become photos or references of
   * her (invariant 9). The new manifest is checked and written durably under
   * a temp name first, so a manifest that cannot be written is found before
   * any photo is gone; its rename is the commit. A crash before the rename
   * leaves a draft with fewer photos (the temp is quarantined on open), which
   * can be promoted again.
   */
  async promoteDraft(avatarId: string, patch: { masterPhotoId: string; name: string }): Promise<AvatarManifest> {
    const avatarDir = this.#avatarDir(avatarId);
    const manifestPath = join(avatarDir, MANIFEST_FILE);
    return runExclusive(`manifest:${manifestPath}`, async () => {
      const current = this.#avatars.get(avatarId);
      if (!current) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
      if (current.status !== "draft") throw new LibraryError("not-a-draft", `avatar ${avatarId} is ${current.status}, not a draft`);
      if (this.#referenceProblem(avatarId, patch.masterPhotoId) !== null) {
        throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${patch.masterPhotoId}`);
      }
      const next = this.#validManifest({ ...current, status: "active", masterPhotoId: patch.masterPhotoId, name: patch.name });
      const temp = tempSiblingPath(manifestPath);
      try {
        await writeFileDurable(temp, toJson(next));
        for (const photo of this.photosByAvatar(avatarId)) {
          if (photo.id !== patch.masterPhotoId) await this.#removePhoto(photo);
        }
        await this.#beforeRename?.(manifestPath);
        await renameWithRetry(temp, manifestPath);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await fsyncDir(avatarDir);
      this.#avatars.set(avatarId, next);
      return next;
    });
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

  /**
   * The avatar's face reference, ready to send: `referencePhoto()`'s image,
   * read from disk, checked against its own sidecar (size and sha256 —
   * survey.ts's own check, re-run here since the file can rot on disk any
   * time after that survey), downscaled to the JPEG `ImageParams.references`
   * expects (`#downscaleReference`, 2b's own choice of size/quality), and
   * only THAT result branded `LibraryReference` (invariant 9). This is the
   * only place that mints one — no other code can pass arbitrary bytes as a
   * reference (see `LibraryReference`'s own comment, media.ts), and no
   * caller can re-downscale loadReference's own output and re-brand it,
   * since the one mint point is the downscale's own result, not the raw
   * bytes. Null in exactly the cases `referencePhoto()` is; throws
   * `LibraryError("reference-corrupt", ...)` for a master that fails its own
   * sidecar's check, before ever reaching the downscale step.
   */
  async loadReference(avatarId: string, signal?: AbortSignal): Promise<LibraryReference | null> {
    const ref = this.referencePhoto(avatarId);
    if (ref === null) return null;
    const raw = await readFile(ref.path);
    if (raw.length !== ref.photo.bytes) {
      throw new LibraryError("reference-corrupt", `${ref.photo.file} has ${raw.length} bytes, the sidecar recorded ${ref.photo.bytes}`);
    }
    const sha256 = createHash("sha256").update(raw).digest("hex");
    if (sha256 !== ref.photo.sha256) {
      throw new LibraryError("reference-corrupt", `${ref.photo.file} does not match the sha256 in its sidecar`);
    }
    const jpeg = await this.#downscaleReference(new Uint8Array(raw), signal);
    return jpeg as LibraryReference;
  }

  /**
   * Money review M1/N1: the avatar's ORIGINAL master file bytes — the same
   * sha256/size check `loadReference()` runs (the sidecar's own record,
   * re-verified here since the file can rot on disk any time after the
   * startup survey), but skipping the downscale step entirely. Never
   * branded `LibraryReference`: these bytes are never sent to OpenRouter
   * (loadReference()'s own downscaled copy is), so `LibraryReference`'s own
   * "the only bytes ImageParams.references may carry" contract does not
   * apply. The face gate's master embedding (T7b, runs/faceGate.ts) must be
   * computed from THESE bytes, not loadReference()'s — the ≤1024px
   * downscale measurably drifted the embedding past the gate's own 0.001
   * parity budget (cos 0.9388 vs calibration, candidate shifts up to
   * +0.029). Null in exactly the cases `referencePhoto()` is; throws
   * `LibraryError("reference-corrupt", ...)` for a master that fails its
   * own sidecar's check, exactly like `loadReference()`.
   */
  async loadMasterOriginal(avatarId: string): Promise<Uint8Array | null> {
    const ref = this.referencePhoto(avatarId);
    if (ref === null) return null;
    const raw = await readFile(ref.path);
    if (raw.length !== ref.photo.bytes) {
      throw new LibraryError("reference-corrupt", `${ref.photo.file} has ${raw.length} bytes, the sidecar recorded ${ref.photo.bytes}`);
    }
    const sha256 = createHash("sha256").update(raw).digest("hex");
    if (sha256 !== ref.photo.sha256) {
      throw new LibraryError("reference-corrupt", `${ref.photo.file} does not match the sha256 in its sidecar`);
    }
    return new Uint8Array(raw);
  }

  /**
   * A photo's file bytes, checked against its own sidecar (size and sha256 —
   * survey.ts's check, re-run since the file can rot after the survey), for
   * local readers such as the focus resolver. `photo-not-found` for an unknown
   * photo, `reference-corrupt` for a file that fails the check; a missing or
   * unreadable file rejects with the fs error. The bytes are the read's own
   * buffer, not a copy.
   */
  async readPhotoVerified(photoId: string): Promise<Uint8Array> {
    const photo = this.#photos.get(photoId);
    if (photo === undefined) throw new LibraryError("photo-not-found", `no photo ${photoId}`);
    const raw = await readFile(join(this.#photosDir(photo.avatarId), photo.file));
    if (raw.length !== photo.bytes) {
      throw new LibraryError("reference-corrupt", `${photo.file} has ${raw.length} bytes, the sidecar recorded ${photo.bytes}`);
    }
    if (createHash("sha256").update(raw).digest("hex") !== photo.sha256) {
      throw new LibraryError("reference-corrupt", `${photo.file} does not match the sha256 in its sidecar`);
    }
    return raw;
  }

  /** Where the avatar's focus cache lives (S8); the id becomes a path segment, so it is validated. */
  focusCachePath(avatarId: string): string {
    if (!isLibraryId(avatarId)) throw new LibraryError("invalid-id", `avatar id ${JSON.stringify(avatarId)} breaks the id pattern`);
    return join(this.#avatarDir(avatarId), FOCUS_FILE);
  }

  /** Where the avatar's montage drafts live (`avatars/<avatarId>/montages`); the id becomes a path segment, so it is validated. */
  montagesDir(avatarId: string): string {
    if (!isLibraryId(avatarId)) throw new LibraryError("invalid-id", `avatar id ${JSON.stringify(avatarId)} breaks the id pattern`);
    return join(this.#avatarDir(avatarId), MONTAGES_DIR);
  }

  /** One draft's file, by the library's own naming; both ids are validated because both become path segments. */
  montageFilePath(avatarId: string, montageId: string): string {
    if (!isLibraryId(montageId)) throw new LibraryError("invalid-id", `montage id ${JSON.stringify(montageId)} breaks the id pattern`);
    return join(this.montagesDir(avatarId), `${montageId}.json`);
  }

  getPhoto(photoId: string): PhotoSidecar | undefined {
    return this.#photos.get(photoId);
  }

  /**
   * Where a photo's image file is, by the library's own naming (`avatars/<avatarId>/photos/<file>`); undefined for a
   * photo the library does not have. A render's resolver hands it to ffmpeg, so nothing here comes from a caller's string.
   */
  photoFilePath(photoId: string): string | undefined {
    const photo = this.#photos.get(photoId);
    return photo === undefined ? undefined : join(this.#photosDir(photo.avatarId), photo.file);
  }

  /** One avatar's photos, oldest first. */
  photosByAvatar(avatarId: string): PhotoSidecar[] {
    return [...this.#photos.values()].filter((p) => p.avatarId === avatarId).sort(byCreation);
  }

  photosByCategory(avatarId: string, category: string): PhotoSidecar[] {
    // An imported photo (T6c) has no category: it never matches a category filter.
    return this.photosByAvatar(avatarId).filter((p) => p.source.kind === "generated" && p.source.category === category);
  }

  photoCount(avatarId: string): number {
    return this.photosByAvatar(avatarId).length;
  }

  /**
   * The ONE eligibility rule's answer for every photo of the avatar, with where
   * each stands on the other axes (see eligibility.ts). Everything that lists,
   * counts or picks photos reads this and nothing else, so no caller can
   * disagree with another. `reserved` is asked of the injected provider afresh
   * on every call. Fails closed: an avatar whose rejected.jsonl cannot be read
   * has no eligible photo, since a mark may hide in the unreadable part.
   */
  photoStates(avatarId: string): Map<string, PhotoState> {
    const masterPhotoId = this.#avatars.get(avatarId)?.masterPhotoId ?? null;
    const reserved = new Set(this.#reservedPhotos(avatarId));
    // A pending commit intent's photos are held as a reservation is (fail closed): its file may be adopted any time, and one photo goes into one video.
    for (const hold of this.#pendingHolds.values()) if (hold.avatarId === avatarId) for (const photoId of hold.photoIds) reserved.add(photoId);
    const marksReadable = !this.#brokenRejectLogs.has(avatarId);
    const usedIn = new Map<string, string[]>();
    for (const { videoId, photoIds } of this.#videosByAvatar.get(avatarId) ?? []) {
      for (const photoId of photoIds) usedIn.set(photoId, [...(usedIn.get(photoId) ?? []), videoId]);
    }
    const states = new Map<string, PhotoState>();
    for (const photo of this.photosByAvatar(avatarId)) {
      const rejected = this.#rejected.has(photo.id);
      states.set(photo.id, {
        eligible: marksReadable && isEligiblePhoto(photo, { masterPhotoId, rejected }),
        rejected,
        reserved: reserved.has(photo.id),
        usedIn: (usedIn.get(photo.id) ?? []).sort(),
      });
    }
    return states;
  }

  /** The photos that may go into a video, oldest first (the rule in eligibility.ts). */
  eligiblePhotos(avatarId: string): PhotoSidecar[] {
    const states = this.photoStates(avatarId);
    return this.photosByAvatar(avatarId).filter((p) => states.get(p.id)?.eligible === true);
  }

  /**
   * Whether ONE photo of this avatar may go into a video: the same rule as
   * `photoStates`, for a caller that holds a photo id (a render's cells, a pick).
   * False for a missing photo, another avatar's, and every photo the rule refuses.
   * Used and reserved are other axes and play no part.
   */
  isEligible(avatarId: string, photoId: string): boolean {
    const photo = this.#photos.get(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) return false;
    if (this.#brokenRejectLogs.has(avatarId)) return false;
    const masterPhotoId = this.#avatars.get(avatarId)?.masterPhotoId ?? null;
    return isEligiblePhoto(photo, { masterPhotoId, rejected: this.#rejected.has(photoId) });
  }

  /** `isEligible`, throwing: `photo-not-found` for a missing photo or another avatar's, `photo-not-eligible` for one the rule refuses. */
  assertEligible(avatarId: string, photoId: string): void {
    const photo = this.#photos.get(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) throw new LibraryError("photo-not-found", `avatar ${avatarId} has no photo ${photoId}`);
    if (!this.isEligible(avatarId, photoId)) throw new LibraryError("photo-not-eligible", `photo ${photoId} may not go into a video`);
  }

  /** The problems of the video records that close `avatarId`: those in its own folder, and records misfiled elsewhere that name it. */
  #recordProblemsOf(avatarId: string): VideoRecordProblem[] {
    const found: VideoRecordProblem[] = [];
    for (const [source, problems] of this.#videoProblems) {
      for (const problem of problems) if (source === avatarId || problem.otherAvatarId === avatarId) found.push(problem);
    }
    return found;
  }

  /**
   * Why the avatar's usage cannot be trusted (3e.2, K16), the decisive first; empty when it can. Exactly when this is not
   * empty, `eligibleUnusedPhotos` refuses and the count is 0 (the same facts as `#usageProblem`). The window shows the
   * reasons instead of the counts, with each one's way out.
   */
  usageReasons(avatarId: string): UsageReason[] {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const found = this.#recordProblemsOf(avatarId);
    const reasons: UsageReason[] = [];
    if (found.some((p) => p.reason === "too-new")) reasons.push("library-too-new");
    if ((this.#videoIndexStale.get(avatarId)?.size ?? 0) > 0) reasons.push("index-stale");
    if (found.some((p) => p.reason === "unreadable" && p.io !== true)) reasons.push("record-unreadable");
    if (found.some((p) => p.reason === "unreadable" && p.io === true)) reasons.push("record-inaccessible");
    if (this.#brokenRejectLogs.has(avatarId)) reasons.push("rejects-unreadable");
    return reasons;
  }

  /**
   * Why the avatar's usage cannot be trusted, or null when it can: an unreadable
   * rejected.jsonl or video record (`log-needs-repair`), or a record from a newer
   * Studio (`library-too-new`, which wins: updating the app may fix the rest). A
   * record misfiled under another avatar closes the avatar it names too.
   */
  #usageProblem(avatarId: string): LibraryError | null {
    const found = this.#recordProblemsOf(avatarId);
    const newer = found.find((p) => p.reason === "too-new");
    if (newer !== undefined) return new LibraryError("library-too-new", `a video record of avatar ${avatarId} was written by a newer version of Studio (${newer.file}); update the app`);
    const stale = this.#videoIndexStale.get(avatarId);
    if (stale !== undefined && stale.size > 0) return new LibraryError("index-stale", `the used index of avatar ${avatarId} is behind its committed videos (${[...stale].sort().join(", ")}); it is rebuilt when the records are read again`);
    const first = found[0];
    if (first !== undefined) return new LibraryError("log-needs-repair", `the video records of avatar ${avatarId} need repair: ${first.file}: ${first.detail}`);
    const marks = this.#brokenRejectLogs.get(avatarId);
    if (marks !== undefined) return new LibraryError("log-needs-repair", `${REJECTED_FILE} of avatar ${avatarId} needs repair: ${marks}`);
    return null;
  }

  /**
   * Eligible photos in no video record and in no queued or running render,
   * oldest first; `category` keeps one scene category. Refuses while the
   * avatar's usage cannot be trusted (`#usageProblem`: `log-needs-repair` or
   * `library-too-new`): a record or a mark may hide in what cannot be read, and
   * its photos would look free and get reused.
   */
  eligibleUnusedPhotos(avatarId: string, category?: string): PhotoSidecar[] {
    const problem = this.#usageProblem(avatarId);
    if (problem !== null) throw problem;
    const states = this.photoStates(avatarId);
    return this.photosByAvatar(avatarId).filter((p) => {
      const state = states.get(p.id);
      if (state === undefined || !state.eligible || state.reserved || state.usedIn.length > 0) return false;
      return category === undefined || (p.source.kind === "generated" && p.source.category === category);
    });
  }

  /** `eligibleUnusedPhotos().length` for a listing, where a refusal must not make the avatar vanish: 0 while its usage cannot be trusted. */
  eligibleUnusedCount(avatarId: string): number {
    return this.#usageProblem(avatarId) === null ? this.eligibleUnusedPhotos(avatarId).length : 0;
  }

  /** The avatar's video records, whatever state their files are in. */
  videoCount(avatarId: string): number {
    return this.#videosByAvatar.get(avatarId)?.length ?? 0;
  }

  /**
   * The export files that the video records of EVERY avatar name (root id and path inside the root), from the used index. Two avatars may share an
   * export folder, so the numbering of file names must look at all of them. Records that do not say where their file is are left out.
   */
  namedVideoFiles(): Array<{ rootId: string; relPath: string }> {
    const named: Array<{ rootId: string; relPath: string }> = [];
    for (const records of this.#videosByAvatar.values()) for (const record of records) if (record.file !== undefined) named.push(record.file);
    return named;
  }

  /** How many of the avatar's video records were rendered from this draft (whatever state their files are in). */
  videoCountForMontage(avatarId: string, montageId: string): number {
    return (this.#videosByAvatar.get(avatarId) ?? []).filter((record) => record.montageId === montageId).length;
  }

  /**
   * Re-reads the avatar's `videos/` folder into the used index: after records
   * are changed on disk by something other than this process's own commit, and
   * the way a test changes them under an open library. One reload runs at a
   * time per avatar; an incremental change made while it was reading makes it
   * read again, so a stale read never overwrites a newer index. A file that
   * vanishes mid-read is a delete, not corruption.
   */
  async reloadVideoRecords(avatarId: string): Promise<void> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    await runExclusive(`videos:${avatarId}`, async () => {
      for (;;) {
        const generation = this.#videoGeneration.get(avatarId) ?? 0;
        const read = await readVideoRecords(this.#avatarDir(avatarId), avatarId, { beforeRead: this.#beforeReadVideoRecord });
        if ((this.#videoGeneration.get(avatarId) ?? 0) !== generation) continue;
        this.#videosByAvatar.set(avatarId, read.records);
        this.#videoIndexStale.delete(avatarId); // the disk has just been read: the index is in step again
        if (read.problems.length === 0) this.#videoProblems.delete(avatarId);
        else this.#videoProblems.set(avatarId, read.problems);
        return;
      }
    });
  }

  /**
   * Task 3a.8b's commit: tells the used index about a record it has just made
   * durable, so its photos are used at once, with no folder read. Adding a
   * record twice keeps one. The render's reservation must end only after this
   * (see `LibraryDeps.reservedPhotos`).
   */
  addVideoRecordToIndex(avatarId: string, record: VideoRecordUse): void {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const others = (this.#videosByAvatar.get(avatarId) ?? []).filter((r) => r.videoId !== record.videoId);
    this.#videosByAvatar.set(avatarId, [...others, record].sort((a, b) => (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0)));
    this.#videoGeneration.set(avatarId, (this.#videoGeneration.get(avatarId) ?? 0) + 1);
  }

  /**
   * Task 3a.8b.1: a video's record is committed on disk but the in-memory index could not take it and
   * could not be rebuilt either. The avatar's usage can no longer be trusted: its photos might look
   * free while a video shows them, so it closes like any other unreadable record
   * (`eligibleUnusedPhotos` throws `index-stale`, the count is 0) until a reload or the next open
   * reads the record from disk, which clears it. It has a reason of its own (not `log-needs-repair`):
   * no record is broken, so nothing may be quarantined or "repaired" because of it. Never throws.
   */
  flagVideoIndexStale(avatarId: string, videoId: string): void {
    this.#videoIndexStale.set(avatarId, new Set([...(this.#videoIndexStale.get(avatarId) ?? []), videoId]));
  }

  /** The committed videos the used index of `avatarId` is known to have missed (empty when it is in step). Not a broken record: nothing on disk needs repair, the index only needs to read it. */
  videoIndexStale(avatarId: string): string[] {
    return [...(this.#videoIndexStale.get(avatarId) ?? [])].sort();
  }

  /**
   * A commit intent is pending (written, not yet a record): its photos count as reserved until `releasePendingPhotos`, which recovery calls when it
   * adopts the intent (the record then makes them used) or drops it. Without this the photos of an intent that recovery DEFERRED (the export folder
   * absent at start) would look free all session, a new render would take them, and the intent adopted later would put one photo in two videos.
   * Holding the same video id again replaces its photos.
   */
  holdPendingPhotos(avatarId: string, videoId: string, photoIds: readonly string[]): void {
    this.#pendingHolds.set(videoId, { avatarId, photoIds: [...photoIds] });
  }

  /** Ends the hold of one pending intent (adopted or dropped); one that was never held changes nothing. */
  releasePendingPhotos(videoId: string): void {
    this.#pendingHolds.delete(videoId);
  }

  /** Task 3a.8b's delete: the record is gone from disk, so its photos are freed. An unknown record changes nothing. */
  removeVideoRecordFromIndex(avatarId: string, videoId: string): void {
    // The generation moves even when the index never knew the record: a reload that already read it must not bring it back.
    this.#videosByAvatar.set(avatarId, (this.#videosByAvatar.get(avatarId) ?? []).filter((r) => r.videoId !== videoId));
    this.#videoGeneration.set(avatarId, (this.#videoGeneration.get(avatarId) ?? 0) + 1);
    // A delete also removes a leftover intent of the same video (delete.ts), so a hold made for it ends with it.
    this.#pendingHolds.delete(videoId);
  }

  /**
   * The owner's own mark: "do not use this photo" (`rejected`) or its restore,
   * appended to the avatar's rejected.jsonl. Only a scene photo of this avatar
   * can be marked: the master (even one carrying a category), a candidate and an
   * import are never eligible, so a mark on them would mean nothing. Resolves
   * true when the mark changed, false when the photo already was that way
   * (nothing is written then).
   */
  async setRejected(avatarId: string, photoId: string, rejected: boolean): Promise<boolean> {
    const manifest = this.#avatars.get(avatarId);
    if (manifest === undefined) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const photo = this.#photos.get(photoId);
    if (!photo || photo.avatarId !== avatarId || !looksLikeRunPhoto(photo) || photo.id === manifest.masterPhotoId) {
      throw new LibraryError("photo-not-found", `avatar ${avatarId} has no scene photo ${photoId}`);
    }
    const path = join(this.#avatarDir(avatarId), REJECTED_FILE);
    return runExclusive(`rejected:${path}`, async () => {
      const detail = this.#brokenRejectLogs.get(avatarId);
      if (detail !== undefined) throw new LibraryError("log-needs-repair", `${REJECTED_FILE} of avatar ${avatarId} needs repair: ${detail}`);
      if (this.#rejected.has(photoId) === rejected) return false;
      const entry = RejectedEntrySchema.parse({ photoId, op: rejected ? "reject" : "restore", at: this.#now().toISOString() });
      await appendJsonLine(path, entry);
      if (rejected) this.#rejected.add(photoId);
      else this.#rejected.delete(photoId);
      return true;
    });
  }

  /**
   * «Убрать повреждённую запись» (3e.2, K16): MOVES every file among the avatar's video records that cannot be read as a record
   * into `quarantine/<time>/…` (nothing is ever deleted), then reads the records again, so the avatar's usage is trusted once
   * nothing broken is left. The disk decides, as it is NOW, not as it was at open:
   * - a file that reads as a sound record is never moved, and each file is looked at once more right before its move;
   * - a record from a newer Studio is never moved: updating the app is its fix, and the avatar stays closed until then;
   * - a stale used index is no broken file: it moves nothing (the read that follows is what brings the index in step);
   * - another avatar's own broken record is that avatar's business; a record misfiled under another avatar that NAMES this one
   *   (it may hold this avatar's photos) is moved from where it lies, which frees both.
   * Safe to repeat: with nothing broken it moves nothing. A move that fails throws, and what was moved before it stays moved
   * (the next call goes on from there). Answers how many files moved, and the avatars whose usage may have changed.
   */
  async quarantineBrokenRecords(avatarId: string): Promise<{ quarantined: number; avatarIds: string[] }> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    // Where a file that closes this avatar can lie: its own folder, and the folders whose last read found a record naming it.
    const folders = new Set<string>([avatarId]);
    for (const [source, problems] of this.#videoProblems) if (problems.some((p) => p.otherAvatarId === avatarId)) folders.add(source);
    const quarantine = new Quarantine(this.root, this.#now);
    const touched = new Set<string>([avatarId]);
    let moved = 0;
    for (const folder of [...folders].sort()) {
      if (!this.#avatars.has(folder)) continue;
      const avatarDir = this.#avatarDir(folder);
      const reading = { beforeRead: this.#beforeReadVideoRecord };
      // `videos:<folder>` is the RELOAD's lock (`reloadVideoRecords`): it keeps the index's re-read and these moves apart. The
      // writers do not take it, and need not: a record is written once (its commit intent is renamed to a new `<id>.json`) and
      // never rewritten, so no writer turns a file read as broken here into a sound one, and `videos.delete` refuses a record it
      // cannot read, so nothing else moves or removes these files. Only a hand edit can change one, and the look right before
      // each move (`stillUnreadable`) catches that.
      await runExclusive(`videos:${folder}`, async () => {
        const read = await readVideoRecords(avatarDir, folder, reading);
        for (const problem of read.problems) {
          if (problem.reason !== "unreadable") continue;
          if (folder !== avatarId && problem.otherAvatarId !== avatarId) continue;
          if (!(await stillUnreadable(avatarDir, folder, problem, reading))) continue;
          await quarantine.move(join(avatarDir, problem.file), "invalid-video-record", problem.detail);
          moved++;
          touched.add(folder);
          if (problem.otherAvatarId !== undefined && this.#avatars.has(problem.otherAvatarId)) touched.add(problem.otherAvatarId);
        }
      });
      // Outside the folder's lock: the reload takes the same one.
      await this.reloadVideoRecords(folder);
    }
    return { quarantined: moved, avatarIds: [...touched].sort() };
  }

  /**
   * «Восстановить отметки» (3e.2, K16): the avatar's rejected.jsonl with a complete line that cannot be read. The file is COPIED
   * into `quarantine/<time>/…` first (durably), and only then replaced, atomically, by the lines that do read, in their order (a
   * torn last line goes too: an append a crash cut short). So every mark that can be read is kept, the dropped lines survive
   * in the copy, and a crash between the two steps leaves the old file and a copy (a repeat makes another copy and goes on).
   * A log with no bad line is not written: it is read again (a log the owner fixed by hand opens the avatar), `rebuilt: false`.
   * Under the same lock as `setRejected`, so no mark lands in the middle. A copy or a write that fails throws, and the log is
   * as it was. `kept` and `dropped` count LINES of the log (a restore is a line too), not the photos left rejected.
   */
  async rebuildRejectLog(avatarId: string): Promise<{ rebuilt: boolean; kept: number; dropped: number }> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const path = join(this.#avatarDir(avatarId), REJECTED_FILE);
    return runExclusive(`rejected:${path}`, async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        this.#replaceRejectMarks(avatarId, []);
        return { rebuilt: false, kept: 0, dropped: 0 };
      }
      const lines = text.split("\n");
      const tail = lines.pop() ?? "";
      const kept: string[] = [];
      const entries: RejectedEntry[] = [];
      let bad = 0;
      for (const raw of lines) {
        if (raw.trim() === "") continue;
        const entry = parseRejectedLine(raw);
        if (entry === null) bad++;
        else {
          kept.push(raw);
          entries.push(entry);
        }
      }
      if (bad === 0) {
        this.#replaceRejectMarks(avatarId, entries);
        return { rebuilt: false, kept: entries.length, dropped: 0 };
      }
      await new Quarantine(this.root, this.#now).copy(path, "invalid-reject-log", `${bad} line(s) could not be read`);
      await writeFileAtomic(path, kept.map((line) => `${line}\n`).join(""), { beforeRename: this.#beforeRename });
      this.#replaceRejectMarks(avatarId, entries);
      return { rebuilt: true, kept: entries.length, dropped: bad + (tail === "" ? 0 : 1) };
    });
  }

  /** The avatar's marks as `entries` replay them (the last op per photo wins), and its log readable again. Other avatars' marks are not touched. */
  #replaceRejectMarks(avatarId: string, entries: readonly RejectedEntry[]): void {
    for (const photo of this.photosByAvatar(avatarId)) this.#rejected.delete(photo.id);
    for (const photoId of replayRejected(entries)) if (this.#photos.get(photoId)?.avatarId === avatarId) this.#rejected.add(photoId);
    this.#brokenRejectLogs.delete(avatarId);
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

  /**
   * Every run folder's id, sorted (T6: the runs a window can offer for a
   * resume after a restart). Only folders whose name is a valid id: a
   * crashed createRun's temp folder, a stray file or a foreign name is not a
   * run. Whether its plan still reads is the caller's business (readRun).
   */
  async listRuns(): Promise<string[]> {
    const entries = await readdir(this.#runsDir(), { withFileTypes: true }).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    });
    return entries
      .filter((e) => e.isDirectory() && isLibraryId(e.name))
      .map((e) => e.name)
      .sort();
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

/**
 * Validates library.json, or creates it in an empty folder, and answers its
 * `createdAt` either way (`Library.createdAt`'s own source). A folder is
 * empty when it holds only OS metadata and the temp of a crashed attempt
 * to write library.json itself.
 */
async function ensureLibraryFile(root: string, now: () => Date): Promise<string> {
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
    const createdAt = now().toISOString();
    await writeJsonAtomic(path, LibraryFileSchema.parse({ schemaVersion: 1, createdAt }));
    return createdAt;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LibraryError("invalid-library-file", `${path} is not valid JSON`);
  }
  if (isFromNewerVersion(parsed, LIBRARY_FILE_SCHEMA_VERSION)) {
    throw new LibraryError("library-too-new", `${path} was written by a newer version of Studio; update the app`);
  }
  const result = LibraryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LibraryError("invalid-library-file", `${path} is not a supported library file: ${result.error.message}`);
  }
  return result.data.createdAt;
}

export function openLibrary(root: string, deps: LibraryDeps = {}): Promise<{ library: Library; report: OpenReport }> {
  return Library.open(root, deps);
}
