import { MAX_SOURCE_PIXELS } from "../../node/downscale";
import { imageSize, isAnimatedImage, sniffImageMediaType, type ImageMediaType } from "../library/media";

// T6c, design constraint 2: the engine validates an imported photo (media
// checks, not animated, a readable size, no more than MAX_SOURCE_PIXELS)
// before anything is downscaled or paid for. Pure and synchronous — the
// actual downscale (ffmpeg) is the caller's own job (engine.ts), once these
// checks already passed. M4: the pixel cap is checked here, by the header's
// own declared size, so an oversized image is refused for free instead of
// only once ffmpeg's own -max_pixels (downscale.ts) refuses to decode it.

/** The describe call's own downscale side: enough detail for the vision call to read every trait of her. */
export const IMPORT_DESCRIBE_MAX_SIDE = 1024;

export type ImportPhotoRejection = "not-an-image" | "animated" | "unreadable-size" | "too-many-pixels";

export interface ImportPhotoInfo {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

export type ImportPhotoCheck = { ok: true; info: ImportPhotoInfo } | { ok: false; reason: ImportPhotoRejection };

/** Checks a picked photo's raw bytes: a known still image format, not animated, with a readable pixel size no larger than MAX_SOURCE_PIXELS. */
export function checkImportPhoto(bytes: Uint8Array): ImportPhotoCheck {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) return { ok: false, reason: "not-an-image" };
  if (isAnimatedImage(bytes)) return { ok: false, reason: "animated" };
  const size = imageSize(bytes);
  if (size === null) return { ok: false, reason: "unreadable-size" };
  if (size.width * size.height > MAX_SOURCE_PIXELS) return { ok: false, reason: "too-many-pixels" };
  return { ok: true, info: { mediaType, width: size.width, height: size.height } };
}
