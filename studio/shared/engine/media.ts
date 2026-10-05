import { z } from "zod";
import { Count, Id } from "./primitives";

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

/**
 * The largest STORED video (the importer's mezzanine) there is, in bytes. ONE number for every reader: the importer refuses a mezzanine over it (`too-large`, after the encode,
 * which is itself bounded to it), the render's streamed copy refuses a record over it, and a draft's verdict (`ownVideoFactsOf`) holds a library video to it, so a draft and a
 * render never disagree on what an own video is. It is the source cap: a mezzanine is bigger than its source only for a grainy one at CRF 16, and such a clip is
 * refused clearly rather than imported, listed, previewed and then never rendered.
 */
export const MAX_STORED_VIDEO_BYTES: number = MEDIA_BYTE_CAPS.video;

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
 * - `unreadable`: the disk refused to read it, or to take the copy;
 * - `no-space`: the library's disk has too little free room, or filled up, for the copy or for what an importer writes (a mezzanine, a work file);
 * - `too-many`: more than `MAX_PICKED_FILES` in one pick, or the engine already holds as many waiting imports as it takes (a larger number; the text does not state it);
 * - `failed`: the kind's importer failed, or the engine could not go on with this file (the rest of a pick that stopped there is `failed` too);
 * - `cancelled`: the import was stopped (the window closed, the engine's own time ran out, the app quit);
 * - `not-yet-supported`: the kind has no importer yet;
 * The codes below are SHARED by every kind: each kind's importer uses the ones that apply to it, and the text a window shows depends on the kind of
 * the file (`mediaReasonRu(reason, kind)`, errorMessagesRu.ts), so a code names the problem and not the kind.
 * - `too-small` (3f.2, 3f.3a): a picture with a side under 2 px (`coverCrop` cannot make a 1 px side even);
 * - `dimensions` (3f.2, 3f.3a): a picture larger than the kind allows (photo: more than 50 megapixels, judged from its header, so a 48 megapixel
 *   camera picture is taken; video: past 4K, 4096 on the long side or 2160 on the short one);
 * - `animated-webp` (3f.2): a WebP that animates; only still pictures are taken;
 * - `too-long` (3f.3a): the file runs longer than its kind allows (video: three minutes; music has its own limit);
 * - `codec` (3f.3a): the file is encoded with a codec the kind's importer does not take (video: H.264, HEVC with HDR and Dolby Vision 8.x
 *   included, and ProRes are taken; VP9, AV1 and the rest are not);
 * - `structure` (3f.3a): the file's parts are put together in a way the importer will not take (video: two video tracks, a track outside its
 *   container, a repeated box, an edit list it cannot follow, a mirrored or oddly turned picture, an unusual colour tag, non-square pixels, a
 *   fragmented file, two tables that disagree): not a wrong file TYPE, so not `format`.
 * - `not-animated` (3f.5): a sticker that does not animate: a still PNG, a GIF or an APNG of one frame, or one whose frames all fall into a single 30 fps slot;
 * - `loop-too-long` (3f.5): a sticker whose loop, on the 30 fps grid, is over 300 frames (10 s), or that has more than 300 source frames.
 *   (A sticker's side over 720 px is `dimensions`, under 2 px `too-small`, a file over 5 MB or an animation that re-encodes past 5 MB `too-large`,
 *   and a file that is not a GIF or an APNG the decoder reads the way the validator did is `format`.)
 * - `too-short` (3f.6): a clip or a track that no montage can use, judged from what the importer made and not from a header: a video under
 *   `MIN_CLIP_MS` (0.1 s, the shortest clip), a track under `MIN_TOTAL_MS` (4 s, the shortest montage, which a track must cover from its start).
 */
export const MediaUnsupportedReason = z.enum([
  "not-a-file",
  "empty",
  "too-large",
  "format",
  "heic",
  "changed",
  "unreadable",
  "no-space",
  "too-many",
  "failed",
  "cancelled",
  "not-yet-supported",
  // 3f.2, one per line and at the END: the codes are neutral and shared by the kinds (the video import adds its own beside them);
  // the texts are per kind (`MEDIA_REASONS_BY_KIND_RU`, with the neutral ones in `MEDIA_REASONS_RU`).
  "too-small",
  "dimensions",
  "animated-webp",
  // 3f.3a (video), after the photo's:
  "too-long",
  "codec",
  "structure",
  // 3f.5, one per line and at the END.
  "not-animated",
  "loop-too-long",
  // 3f.6, one per line and at the END.
  "too-short",
]);
export type MediaUnsupportedReason = z.infer<typeof MediaUnsupportedReason>;

/** The constant rate a stored video runs at (the mezzanine's), in frames per second. */
export const MEZZANINE_FPS = 30;

/** How far a source's rate may be from `MEZZANINE_FPS` and still be told as no conversion: the rounding of a 30 000 / 1001 camera (29.97) and of a `stts` table. */
export const SAME_RATE_TOLERANCE = 0.05;

/**
 * What an import's `prepare.fromFps` says (3f.6): the source's rate when it differs from the mezzanine's 30, else null. «60 → 30 fps» is worth saying; «29.97 → 30 fps»
 * is not, so a rate within `SAME_RATE_TOLERANCE` of 30 is null.
 */
export function fromFpsOf(sourceFps: number): number | null {
  return Math.abs(sourceFps - MEZZANINE_FPS) <= SAME_RATE_TOLERANCE ? null : sourceFps;
}

/** A file name as a person reads it (no folder): at most 120 characters, and no control or bidi characters. */
export const MediaFileName = z
  .string()
  .min(1)
  .max(120)
  // C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates that make a name read as another («photo\u202Egpj.exe»).
  // eslint-disable-next-line no-control-regex
  .refine((name) => !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name), "must not contain control or bidi characters");
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
    /** Picked files beyond what one answer can list (`MAX_REFUSED_FILES`): never looked at, all of them `too-many`. Never dropped silently. */
    skipped: Count,
  }),
  z.strictObject({ picked: z.literal(false) }),
]);
export type MediaPickResult = z.infer<typeof MediaPickResult>;

const Decimal64 = z.string().regex(/^\d{1,20}$/, "must be an unsigned decimal number");

/**
 * Which file a name led to at some moment, as main's look saw it (`media.import`'s `expected`) and as the engine's open sees it again.
 * Every field is an exact decimal string of the UNSIGNED 64-bit value: Node reads a bigint stat out of a signed array, so a number
 * with its top bit set must be reinterpreted before it is written (`pickedIdentityOf`, engine/media/identity.ts). The size and the two
 * times are in it so that a file system that reports one inode for every file (exFAT) still tells two files apart.
 */
export const PickedFileIdentity = z.strictObject({ dev: Decimal64, ino: Decimal64, size: Decimal64, mtimeNs: Decimal64, birthtimeNs: Decimal64 });
export type PickedFileIdentity = z.infer<typeof PickedFileIdentity>;

// ---------- the records (3f.1b, K28) ----------

/** A sticker's loop is quantised to the 30 fps grid and held to the built-in set's own cap (3b.6's memory rule), in frames. */
export const MAX_STICKER_LOOP_FRAMES = 300;

/** `media.list` answers at most this many records (newest first); `total` says how many there are. */
export const MAX_LISTED_MEDIA = 500;

/** `media.list` by id (3f.5): at most this many ids (a draft has at most 10 sticker layers, and 20 files are picked at a time). */
export const MAX_LISTED_BY_ID = 50;

const PositiveInt = z.number().int().positive();

/**
 * One own file as the window sees it (K28): what it is and what the editor needs to place it. There is NO path and no hash here: the file
 * lives in the library's `media/` folder under a name the engine made, and is reached by its id only (`studio-media://`, 3f.3b). Which
 * fields a kind has is part of the contract, so a window never has to guess:
 * - `photo`, `video`, `sticker`: `width` and `height` in pixels (of the STORED file, after the importer's normalisation); a track has none;
 * - `video`, `audio`: `durationMs`; a photo has none (a sticker's length is its `loopFrames`);
 * - `video` only: `sourceFps` (what the owner's file had, before the 30 fps constant rate) and `hdrToSdr` (it was tone-mapped);
 * - `sticker` only: `loopFrames` (≤ 300 frames at 30 fps) and `delayFrames` (each frame's delay in 30 fps frames; they add up to `loopFrames`).
 */
export const MediaSummary = z
  .strictObject({
    mediaId: Id,
    kind: MediaKind,
    /** The picked file's base name, for display only. */
    name: MediaFileName,
    /** The size of the STORED file. */
    bytes: PositiveInt,
    createdAt: z.iso.datetime(),
    width: PositiveInt.nullable(),
    height: PositiveInt.nullable(),
    durationMs: PositiveInt.nullable(),
    sourceFps: z.number().positive().max(1000).nullable(),
    hdrToSdr: z.boolean(),
    loopFrames: PositiveInt.max(MAX_STICKER_LOOP_FRAMES).nullable(),
    delayFrames: z.array(PositiveInt.max(MAX_STICKER_LOOP_FRAMES)).min(1).max(MAX_STICKER_LOOP_FRAMES).nullable(),
  })
  .superRefine((media, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    const pixels = media.kind !== "audio";
    if (pixels !== (media.width !== null)) fail("width", pixels ? `a ${media.kind} has a width` : "a track has no width");
    if (pixels !== (media.height !== null)) fail("height", pixels ? `a ${media.kind} has a height` : "a track has no height");
    const timed = media.kind === "video" || media.kind === "audio";
    if (timed && media.durationMs === null) fail("durationMs", `a ${media.kind} has a length`);
    if (media.kind === "photo" && media.durationMs !== null) fail("durationMs", "a photo has no length");
    if ((media.kind === "video") !== (media.sourceFps !== null)) fail("sourceFps", "only a video has a source frame rate, and every video has one");
    if (media.kind !== "video" && media.hdrToSdr) fail("hdrToSdr", "only a video is tone-mapped");
    if ((media.kind === "sticker") !== (media.loopFrames !== null)) fail("loopFrames", "only a sticker has a loop, and every sticker has one");
    if ((media.kind === "sticker") !== (media.delayFrames !== null)) fail("delayFrames", "only a sticker has frame delays, and every sticker has them");
    if (media.loopFrames !== null && media.delayFrames !== null && media.delayFrames.reduce((sum, d) => sum + d, 0) !== media.loopFrames) {
      fail("delayFrames", "the frame delays must add up to the loop's length");
    }
  });
export type MediaSummary = z.infer<typeof MediaSummary>;

/** `media.list`: every own file, or those of one kind. */
export const MediaListPayload = z.strictObject({
  kind: MediaKind.optional(),
  /**
   * Only the records with these ids (the `kind` still filters them): for a window that needs the few files a draft names, however old they are, since the
   * plain listing is cut at `MAX_LISTED_MEDIA` newest. `total` then counts the matches. An id nobody holds matches nothing.
   */
  mediaIds: z.array(Id).max(MAX_LISTED_BY_ID).optional(),
});
export const MediaListResult = z
  .strictObject({
    /** Newest first, at most `MAX_LISTED_MEDIA`. */
    media: z.array(MediaSummary).max(MAX_LISTED_MEDIA),
    /** How many records match in all: more than `media.length` when the listing was cut. */
    total: Count,
  })
  .refine((r) => r.total >= r.media.length, { message: "total must not be below what is listed", path: ["total"] });
export type MediaListResult = z.infer<typeof MediaListResult>;

/** `media.delete`: removes the file and its record. A draft that names it keeps the reference and reads it as `media-unavailable`. */
export const MediaDeletePayload = z.strictObject({ mediaId: Id });
export const MediaDeleteResult = z.strictObject({ mediaId: Id });

/** `media.cancelImport`: stops a running import job (the copy, the importer or the record), leaving nothing behind. */
export const MediaCancelImportPayload = z.strictObject({ jobId: Id });
export const MediaCancelImportResult = z.strictObject({ jobId: Id });
