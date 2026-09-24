import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasErrorCode, isTempName, readJsonFile, readJsonl, type Parsed } from "./durableFs";
import { LibraryError } from "./errors";
import { isLibraryId } from "./ids";
import {
  AVATARS_DIR,
  MANIFEST_FILE,
  PHOTOS_DIR,
  RUNS_DIR,
  THUMBS_DIR,
  USED_FILE,
  isFromNewerVersion,
  isLibraryFileTemp,
} from "./layout";
import { isImageExtension } from "./media";
import type { QuarantineReason } from "./quarantine";
import {
  AvatarManifestSchema,
  PhotoSidecarSchema,
  UsedEntrySchema,
  type AvatarManifest,
  type PhotoSidecar,
} from "./schemas";

/** A log with a bad complete line; the avatar's writes to it are blocked until it is repaired. */
export interface LogIssue {
  avatarId: string;
  file: string;
  detail: string;
}

export interface PendingMove {
  path: string;
  reason: QuarantineReason;
  detail?: string;
}

/** What is on disk, and what should move to quarantine — found without
 *  changing anything, so a refusal (e.g. a newer schema) leaves no trace. */
export interface Survey {
  moves: PendingMove[];
  avatars: AvatarManifest[];
  photos: PhotoSidecar[];
  usedPhotoIds: string[];
  logIssues: LogIssue[];
}

function tooNew(path: string): LibraryError {
  return new LibraryError(
    "library-too-new",
    `${path} was written by a newer version of Studio; update the app to open this library`
  );
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function readManifest(avatarDir: string, folderName: string): Promise<Parsed<AvatarManifest>> {
  const path = join(avatarDir, MANIFEST_FILE);
  const raw = await readJsonFile(path);
  if (!raw.ok) return raw;
  if (isFromNewerVersion(raw.value)) throw tooNew(path);
  const result = AvatarManifestSchema.safeParse(raw.value);
  if (!result.success) return { ok: false, detail: result.error.message };
  if (result.data.id !== folderName) {
    return { ok: false, detail: `manifest id ${result.data.id} does not match folder ${folderName}` };
  }
  return { ok: true, value: result.data };
}

async function readSidecar(path: string, stem: string, avatarId: string): Promise<Parsed<PhotoSidecar>> {
  const raw = await readJsonFile(path);
  if (!raw.ok) return raw;
  if (isFromNewerVersion(raw.value)) throw tooNew(path);
  const result = PhotoSidecarSchema.safeParse(raw.value);
  if (!result.success) return { ok: false, detail: result.error.message };
  const { id, avatarId: recorded } = result.data;
  if (id !== stem || recorded !== avatarId) {
    return { ok: false, detail: `sidecar says ${recorded}/${id} but is filed under ${avatarId}/${stem}` };
  }
  return { ok: true, value: result.data };
}

/**
 * The sidecar is written only after the image is fsynced, but a disk or a
 * power cut can still lose the image's data while keeping the sidecar. Size
 * and sha256 must match what the sidecar recorded.
 */
async function imageProblem(imagePath: string, sidecar: PhotoSidecar): Promise<string | null> {
  let content: Buffer;
  try {
    content = await readFile(imagePath);
  } catch (error) {
    // One unreadable file must not stop the whole library from opening; it
    // is reported and moved to quarantine like any other bad image.
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    if (code === undefined) throw error;
    return `${sidecar.file} cannot be read (${code})`;
  }
  if (content.length !== sidecar.bytes) {
    return `${sidecar.file} has ${content.length} bytes, the sidecar recorded ${sidecar.bytes}`;
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return sha256 === sidecar.sha256 ? null : `${sidecar.file} does not match the sha256 in its sidecar`;
}

/** Pairs every image with its sidecar. Only a valid sidecar next to the
 *  image it names is a committed photo; everything else of ours is planned
 *  for quarantine. Files that are not library records are left alone. */
async function surveyPhotos(dir: string, avatarId: string, survey: Survey): Promise<void> {
  /** Image-named entries → whether each is a regular file. Dirent does not
   *  follow symlinks, so a link (to anywhere) or a folder is never an image. */
  const images = new Map<string, boolean>();
  const sidecars: string[] = [];
  for (const entry of await entriesOf(dir)) {
    const { name } = entry;
    if (isTempName(name)) {
      survey.moves.push({ path: join(dir, name), reason: "temp-file" });
      continue;
    }
    const dot = name.lastIndexOf(".");
    const stem = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    if (dot <= 0 || !isLibraryId(stem)) continue;
    if (ext === "json") sidecars.push(name);
    else if (isImageExtension(ext)) images.set(name, entry.isFile());
  }

  for (const name of sidecars) {
    const path = join(dir, name);
    const sidecar = await readSidecar(path, name.slice(0, -".json".length), avatarId);
    if (!sidecar.ok) {
      survey.moves.push({ path, reason: "invalid-sidecar", detail: sidecar.detail });
      continue;
    }
    if (!images.has(sidecar.value.file)) {
      survey.moves.push({ path, reason: "orphan-sidecar", detail: `${sidecar.value.file} is missing` });
      continue;
    }
    const isRegular = images.get(sidecar.value.file);
    images.delete(sidecar.value.file);
    const imagePath = join(dir, sidecar.value.file);
    const problem = isRegular
      ? await imageProblem(imagePath, sidecar.value)
      : `${sidecar.value.file} is not a regular file`;
    if (problem !== null) {
      survey.moves.push({ path, reason: "invalid-image", detail: problem });
      survey.moves.push({ path: imagePath, reason: "invalid-image", detail: problem });
      continue;
    }
    survey.photos.push(sidecar.value);
  }

  for (const name of images.keys()) survey.moves.push({ path: join(dir, name), reason: "orphan-image" });
}

export async function surveyLibrary(root: string): Promise<Survey> {
  const survey: Survey = { moves: [], avatars: [], photos: [], usedPhotoIds: [], logIssues: [] };

  for (const { name } of await entriesOf(root)) {
    if (isLibraryFileTemp(name)) survey.moves.push({ path: join(root, name), reason: "temp-file" });
  }

  const avatarsDir = join(root, AVATARS_DIR);
  for (const entry of await entriesOf(avatarsDir)) {
    const path = join(avatarsDir, entry.name);
    if (isTempName(entry.name)) {
      survey.moves.push({ path, reason: "temp-file" });
      continue;
    }
    if (!entry.isDirectory() || !isLibraryId(entry.name)) continue;

    const manifest = await readManifest(path, entry.name);
    if (!manifest.ok) {
      survey.moves.push({ path, reason: "invalid-manifest", detail: manifest.detail });
      continue;
    }
    survey.avatars.push(manifest.value);
    for (const { name } of await entriesOf(path)) {
      if (isTempName(name)) survey.moves.push({ path: join(path, name), reason: "temp-file" });
    }
    await surveyPhotos(join(path, PHOTOS_DIR), manifest.value.id, survey);
    // Thumbnails are rendered to temp names (ours, and ffmpeg's `.part-`).
    const thumbsDir = join(path, THUMBS_DIR);
    for (const { name } of await entriesOf(thumbsDir)) {
      if (isTempName(name) || name.includes(".part-")) survey.moves.push({ path: join(thumbsDir, name), reason: "temp-file" });
    }
    // A torn last line is an interrupted append; the next append moves it to
    // used.jsonl.torn, so it is only skipped here. A bad complete line is not
    // a crash: it blocks this avatar's usage tracking, not the whole library.
    try {
      const used = await readJsonl(join(path, USED_FILE), UsedEntrySchema);
      for (const entry of used.entries) survey.usedPhotoIds.push(entry.photoId);
    } catch (error) {
      if (!(error instanceof LibraryError && error.code === "corrupt-log")) throw error;
      survey.logIssues.push({ avatarId: manifest.value.id, file: USED_FILE, detail: error.message });
    }
  }

  // A temp folder in runs/ is a createRun that crashed before its rename.
  const runsDir = join(root, RUNS_DIR);
  for (const { name } of await entriesOf(runsDir)) {
    if (isTempName(name)) survey.moves.push({ path: join(runsDir, name), reason: "temp-file" });
  }
  return survey;
}
