import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
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
import { isEligiblePhoto, type PhotoState } from "./eligibility";
import { LibraryError } from "./errors";
import { isLibraryId } from "./ids";
import { runExclusive } from "./keyedMutex";
import {
  AVATARS_DIR,
  HISTORY_FILE,
  JOURNAL_FILE,
  LIBRARY_FILE,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  PHOTOS_DIR,
  PLAN_FILE,
  REFUSED_IMPORTS_FILE,
  RUNS_DIR,
  THUMBS_DIR,
  REJECTED_FILE,
  isFromNewerVersion,
  LIBRARY_FILE_SCHEMA_VERSION,
  REFUSED_IMPORTS_SCHEMA_VERSION,
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
  RefusedImportsFileSchema,
  RejectedEntrySchema,
  type AvatarManifest,
  type AvatarStatus,
  type HistoryEntry,
  type PhotoQa,
  type PhotoSidecar,
  type PhotoSource,
} from "./schemas";
import { surveyLibrary, type LogIssue } from "./survey";
import { readVideoRecords, type VideoRecordUse } from "./videoRecords";

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
  /** Avatars with a file in videos/ that is not a usable record, with the reason: their usage cannot be trusted. */
  readonly #brokenVideoRecords = new Map<string, string>();
  /** T6c (H2): sha256 of every imported photo's raw bytes the mandatory one-time age check has already refused. */
  #refusedImportHashes = new Set<string>();

  private constructor(root: string, deps: LibraryDeps, createdAt: string) {
    this.root = root;
    this.createdAt = createdAt;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#beforeRename = deps.testHooks?.beforeRename;
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
      const broken = issue.file === REJECTED_FILE ? library.#brokenRejectLogs : library.#brokenVideoRecords;
      if (!broken.has(issue.avatarId)) broken.set(issue.avatarId, `${issue.file}: ${issue.detail}`);
    }
    library.#refusedImportHashes = await loadRefusedImports(root);

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

  /** T6c (H2): whether `sha256` (an imported photo's raw bytes) was already refused by the mandatory one-time age check — checked for free, before anything is downscaled or paid for, so re-picking the exact same bytes cannot re-roll it. */
  isRefusedImport(sha256: string): boolean {
    return this.#refusedImportHashes.has(sha256);
  }

  /** Records that the mandatory one-time age check refused this photo's exact raw bytes; written atomically (temp + fsync + rename), like every other library JSON file. A no-op if already recorded. */
  async recordRefusedImport(sha256: string): Promise<void> {
    if (this.#refusedImportHashes.has(sha256)) return;
    const next = new Set(this.#refusedImportHashes);
    next.add(sha256);
    const file = RefusedImportsFileSchema.parse({ schemaVersion: REFUSED_IMPORTS_SCHEMA_VERSION, sha256: [...next].sort() });
    await writeJsonAtomic(join(this.root, REFUSED_IMPORTS_FILE), file, { beforeRename: this.#beforeRename });
    this.#refusedImportHashes = next;
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

  getPhoto(photoId: string): PhotoSidecar | undefined {
    return this.#photos.get(photoId);
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
    const reserved = this.#reservedPhotos(avatarId);
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
   * Eligible photos in no video record and in no queued or running render,
   * oldest first; `category` keeps one scene category. Refuses with
   * `log-needs-repair` while a file in the avatar's `videos/` cannot be read:
   * the record may hold photos that would look free and get reused.
   */
  eligibleUnusedPhotos(avatarId: string, category?: string): PhotoSidecar[] {
    const detail = this.#brokenVideoRecords.get(avatarId);
    if (detail !== undefined) throw new LibraryError("log-needs-repair", `the video records of avatar ${avatarId} need repair: ${detail}`);
    const states = this.photoStates(avatarId);
    return this.photosByAvatar(avatarId).filter((p) => {
      const state = states.get(p.id);
      if (state === undefined || !state.eligible || state.reserved || state.usedIn.length > 0) return false;
      return category === undefined || (p.source.kind === "generated" && p.source.category === category);
    });
  }

  /** `eligibleUnusedPhotos().length` for a listing, where a refusal must not make the avatar vanish: 0 while its records cannot be trusted. */
  eligibleUnusedCount(avatarId: string): number {
    return this.#brokenVideoRecords.has(avatarId) ? 0 : this.eligibleUnusedPhotos(avatarId).length;
  }

  /** The avatar's video records, whatever state their files are in. */
  videoCount(avatarId: string): number {
    return this.#videosByAvatar.get(avatarId)?.length ?? 0;
  }

  /**
   * Re-reads the avatar's `videos/` folder into the used index: after a record
   * is added or deleted (task 3a.8b's commit and delete call this), and the
   * way a test changes the records under an open library.
   */
  async reloadVideoRecords(avatarId: string): Promise<void> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const { records, problems } = await readVideoRecords(this.#avatarDir(avatarId), avatarId);
    this.#videosByAvatar.set(avatarId, records);
    const first = problems[0];
    if (first === undefined) this.#brokenVideoRecords.delete(avatarId);
    else this.#brokenVideoRecords.set(avatarId, `${first.file}: ${first.detail}`);
  }

  /**
   * The owner's own mark: "do not use this photo" (`rejected`) or its restore,
   * appended to the avatar's rejected.jsonl. Only a scene photo of this avatar
   * can be marked: the master, a candidate and an import are never eligible, so
   * a mark on them would mean nothing. Marking a photo the way it already is
   * writes nothing.
   */
  async setRejected(avatarId: string, photoId: string, rejected: boolean): Promise<void> {
    if (!this.#avatars.has(avatarId)) throw new LibraryError("avatar-not-found", `no avatar ${avatarId}`);
    const photo = this.#photos.get(photoId);
    if (!photo || photo.avatarId !== avatarId || !looksLikeRunPhoto(photo)) {
      throw new LibraryError("photo-not-found", `avatar ${avatarId} has no scene photo ${photoId}`);
    }
    const path = join(this.#avatarDir(avatarId), REJECTED_FILE);
    await runExclusive(`rejected:${path}`, async () => {
      const detail = this.#brokenRejectLogs.get(avatarId);
      if (detail !== undefined) throw new LibraryError("log-needs-repair", `${REJECTED_FILE} of avatar ${avatarId} needs repair: ${detail}`);
      if (this.#rejected.has(photoId) === rejected) return;
      const entry = RejectedEntrySchema.parse({ photoId, op: rejected ? "reject" : "restore", at: this.#now().toISOString() });
      await appendJsonLine(path, entry);
      if (rejected) this.#rejected.add(photoId);
      else this.#rejected.delete(photoId);
    });
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

/**
 * T6c (H2): the sha256 of every imported photo the mandatory one-time image
 * age check has already refused, from `<root>/refused-imports.json`. Never
 * blocks or quarantines the library over it: it is a courtesy cache, not the
 * safety boundary itself (the mandatory age check always still runs on
 * import) — a missing or unreadable file is simply read as empty.
 */
async function loadRefusedImports(root: string): Promise<Set<string>> {
  const raw = await readJsonFile(join(root, REFUSED_IMPORTS_FILE));
  if (!raw.ok) return new Set();
  if (isFromNewerVersion(raw.value, REFUSED_IMPORTS_SCHEMA_VERSION)) return new Set();
  const parsed = RefusedImportsFileSchema.safeParse(raw.value);
  return parsed.success ? new Set(parsed.data.sha256) : new Set();
}

export function openLibrary(root: string, deps: LibraryDeps = {}): Promise<{ library: Library; report: OpenReport }> {
  return Library.open(root, deps);
}
