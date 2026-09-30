/** One kind of file the protocol serves: the type it is answered with, how big it may be, and a check on its first bytes. */
export interface MediaKind {
  /** Lowercase, no dot: also the file's extension in the library. */
  readonly ext: string;
  readonly contentType: string;
  readonly maxBytes: number;
  /** Whether the first bytes (at most 16) are what this kind starts with. A file that lies about its extension is not served. */
  sniff(header: Uint8Array): boolean;
}

const MIB = 1024 * 1024;

const startsWith = (header: Uint8Array, at: number, text: readonly number[]): boolean => text.every((value, i) => header[at + i] === value);
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const PNG_SIGNATURE = [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (header: Uint8Array): boolean => startsWith(header, 0, PNG_SIGNATURE);
const isIsoBmff = (header: Uint8Array): boolean => startsWith(header, 4, ascii("ftyp"));

/**
 * The kinds of invariant 28's routes, keyed by extension. The limits are ceilings for one file, well above what
 * the app makes (a photo, a 5 MB sticker, an MP4 of a 15 s montage); a route can lower them further.
 * `apng` is served as `image/apng` and checked as a PNG: that the file animates is the sticker catalogue's hash
 * (built-in) or the import's validation (own, 3f.5), not this check.
 */
export const KINDS = {
  jpg: { ext: "jpg", contentType: "image/jpeg", maxBytes: 64 * MIB, sniff: (h) => startsWith(h, 0, [0xff, 0xd8, 0xff]) },
  png: { ext: "png", contentType: "image/png", maxBytes: 64 * MIB, sniff: isPng },
  webp: { ext: "webp", contentType: "image/webp", maxBytes: 64 * MIB, sniff: (h) => startsWith(h, 0, ascii("RIFF")) && startsWith(h, 8, ascii("WEBP")) },
  gif: { ext: "gif", contentType: "image/gif", maxBytes: 16 * MIB, sniff: (h) => startsWith(h, 0, ascii("GIF87a")) || startsWith(h, 0, ascii("GIF89a")) },
  apng: { ext: "apng", contentType: "image/apng", maxBytes: 16 * MIB, sniff: isPng },
  mp4: { ext: "mp4", contentType: "video/mp4", maxBytes: 4 * 1024 * MIB, sniff: isIsoBmff },
  m4a: { ext: "m4a", contentType: "audio/mp4", maxBytes: 256 * MIB, sniff: isIsoBmff },
} as const satisfies Readonly<Record<string, MediaKind>>;

export type KindKey = keyof typeof KINDS;
