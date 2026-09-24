/** The only image formats the library stores or serves, keyed by file extension. */
export const IMAGE_EXTENSIONS = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export type ImageExtension = keyof typeof IMAGE_EXTENSIONS;
export type ImageMediaType = (typeof IMAGE_EXTENSIONS)[ImageExtension];

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function isImageExtension(ext: string): ext is ImageExtension {
  return Object.hasOwn(IMAGE_EXTENSIONS, ext);
}

/** The image format a byte buffer really is, from its magic number. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

export function extensionFor(mediaType: ImageMediaType): ImageExtension {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}
