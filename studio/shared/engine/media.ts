import { z } from "zod";
import { Id } from "./primitives";

// Own media (Stage 3, 3f.1; K28, K29, K30). The import boundary's contract: what the window may ask and what it may be told.
// Invariant 34: the window sends a KIND and nothing else. Main opens its own native dialog and hands the picked path to the
// engine over the control channel; the answer carries file NAMES (a display text, never a path) and job ids.

/** What an own file is: a photo, a video, an audio track or a sticker (K28). */
export const MediaKind = z.enum(["photo", "video", "audio", "sticker"]);
export type MediaKind = z.infer<typeof MediaKind>;

/** What the window may ask to import: one kind, or `any` for the one drop zone (the kind is then read from the bytes). */
export const MediaPickKind = z.enum(["photo", "video", "audio", "sticker", "any"]);
export type MediaPickKind = z.infer<typeof MediaPickKind>;

/**
 * The largest file each kind takes, in bytes. The boundary refuses a bigger one (`too-large`) before it copies a byte and stops a
 * copy at this size even when the file grows meanwhile. The sticker cap equals the built-in set's (`STICKER_LIMITS.maxBytes`).
 */
export const MEDIA_BYTE_CAPS: Readonly<Record<MediaKind, number>> = {
  photo: 30 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  sticker: 5 * 1024 * 1024,
};

/** The cap a pick of `kind` is held to before its bytes are read; `any` is held to the largest until the bytes name the kind. */
export function mediaByteCap(kind: MediaPickKind): number {
  return kind === "any" ? Math.max(...Object.values(MEDIA_BYTE_CAPS)) : MEDIA_BYTE_CAPS[kind];
}

/** At most this many files of one pick are taken; the rest are refused as `too-many`. */
export const MAX_PICKED_FILES = 20;

/**
 * Why one picked file was refused (K30's `mediaReason`). The boundary's own reasons come first; the per-kind tasks (3f.2 to 3f.5)
 * append theirs (`too-long`, `dimensions`, `too-small`, `animated-webp`, `codec`, `not-animated`, `loop-too-long`).
 * - `not-a-file`: not an absolute path, a symlink, a folder, a device or a pipe, or a path that is gone;
 * - `empty`: zero bytes;
 * - `too-large`: over the kind's cap;
 * - `format`: the BYTES are not what the kind takes (the extension is never trusted);
 * - `heic`: the bytes are a HEIC or HEIF picture, which Studio does not read; the window says «сохраните как JPEG» (V3);
 * - `changed`: the file was replaced or was still changing between the dialog and the copy;
 * - `unreadable`: the disk refused to read it;
 * - `too-many`: more than `MAX_PICKED_FILES` in one pick;
 * - `not-yet-supported`: the kind has no importer yet.
 */
export const MediaUnsupportedReason = z.enum(["not-a-file", "empty", "too-large", "format", "heic", "changed", "unreadable", "too-many", "not-yet-supported"]);
export type MediaUnsupportedReason = z.infer<typeof MediaUnsupportedReason>;

/** A file name as a person reads it (no folder): at most 120 characters, and no control characters. */
export const MediaFileName = z
  .string()
  .min(1)
  .max(120)
  // eslint-disable-next-line no-control-regex
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "must not contain control characters");
export type MediaFileName = z.infer<typeof MediaFileName>;

export const MAX_REFUSED_FILES = 100;

/** One picked file the boundary or an importer turned away. `name` is the base name only. */
export const MediaRefusal = z.strictObject({ name: MediaFileName, reason: MediaUnsupportedReason });
export type MediaRefusal = z.infer<typeof MediaRefusal>;

/**
 * `media.pickImport`'s payload: the kind and NOTHING else (a `path` or `bytes` field is refused by the schema itself).
 * Its result is a plain cancel, or one job per accepted file and a refusal per turned-away one.
 */
export const MediaPickImportPayload = z.strictObject({ kind: MediaPickKind });
export const MediaPickResult = z.discriminatedUnion("picked", [
  z.strictObject({
    picked: z.literal(true),
    jobIds: z.array(Id).max(MAX_PICKED_FILES),
    refused: z.array(MediaRefusal).max(MAX_REFUSED_FILES),
  }),
  z.strictObject({ picked: z.literal(false) }),
]);
export type MediaPickResult = z.infer<typeof MediaPickResult>;
