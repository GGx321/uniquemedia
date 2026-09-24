import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isLibraryId } from "./ids";
import { IMAGE_EXTENSIONS, sniffImageMediaType, type ImageExtension, type ImageMediaType } from "./media";

export type MediaPathErrorCode = "invalid-id" | "not-found" | "outside-root" | "not-an-image";

export type MediaPathResult =
  | { ok: true; path: string; mediaType: ImageMediaType }
  | { ok: false; code: MediaPathErrorCode; message: string };

// Tried in this order; nothing else is ever looked up.
const EXTENSIONS: readonly ImageExtension[] = ["jpg", "png", "webp"];

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

// Codes that mean "no such file here" rather than a real I/O failure.
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && ABSENT.has(code)) return null;
    throw error;
  }
}

/** The first bytes of a file, enough for every magic number we check. */
async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const header = new Uint8Array(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isInside(realRoot: string, realPath: string): boolean {
  const rel = relative(realRoot, realPath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Maps `studio-media://photo/<avatarId>/<photoId>` to a file (invariant 12).
 * The path is never taken from the request: both ids must match the id
 * pattern, the path is built by the library's naming convention with only
 * allowlisted image extensions, and its realpath must lie inside the
 * realpath of the root — so neither `..` nor a symlink can escape it. The
 * file must be a regular file whose magic bytes match the extension, so a
 * symlink to e.g. avatar.json is never served as an image. The handler in
 * main should still send `X-Content-Type-Options: nosniff`.
 */
export async function resolveMediaPath(root: string, avatarId: string, photoId: string): Promise<MediaPathResult> {
  if (!isLibraryId(avatarId) || !isLibraryId(photoId)) {
    return { ok: false, code: "invalid-id", message: "avatar and photo ids must match ^[a-z0-9-]{8,64}$" };
  }
  const realRoot = await realpathIfPresent(root);
  if (realRoot === null) return { ok: false, code: "not-found", message: `library root ${root} does not exist` };

  const photosDir = join(root, "avatars", avatarId, "photos");
  for (const ext of EXTENSIONS) {
    const realPath = await realpathIfPresent(join(photosDir, `${photoId}.${ext}`));
    if (realPath === null) continue;
    if (!isInside(realRoot, realPath)) {
      return { ok: false, code: "outside-root", message: `photo ${avatarId}/${photoId} resolves outside the library` };
    }
    // Regular files only — checked before opening, since opening a FIFO blocks.
    if (!(await stat(realPath)).isFile()) continue;
    const mediaType = IMAGE_EXTENSIONS[ext];
    if (sniffImageMediaType(await readHeader(realPath)) !== mediaType) {
      return { ok: false, code: "not-an-image", message: `photo ${avatarId}/${photoId} is not a ${mediaType} file` };
    }
    return { ok: true, path: realPath, mediaType };
  }
  return { ok: false, code: "not-found", message: `no photo ${avatarId}/${photoId}` };
}
