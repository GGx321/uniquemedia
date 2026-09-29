import { z } from "zod";
import { Count, Id } from "./primitives";

// Rendered videos as the contract shows them (Stage 3 plan, "Outputs and
// export"). The MP4 lives only in the export folder («Готовые видео»); the
// library keeps a small record per video, and these are the parts of that
// record the windows see. Nothing here carries an absolute path: a record
// names its file by the export root's identity plus a path relative to it.

/** videos.list answers at most this many records, newest first: no cursor yet, like `MAX_LISTED_PHOTOS`. */
export const MAX_LISTED_VIDEOS = 500;

/**
 * The kind token of a video, the middle of its file name
 * (`<YYYY-MM-DD>_<kind>_<NNN>.mp4`): a short lowercase ASCII word such as
 * `photo`, `collage3` or `mix`.
 */
export const VideoKindToken = z.string().regex(/^[a-z][a-z0-9]{0,15}$/, "must be 1-16 chars of a-z or 0-9, starting with a letter");

/**
 * A video's place inside the export folder, exactly as the engine names it:
 * `<SafeName>/<YYYY-MM-DD>_<kind>_<NNN>.mp4`. An allow-list, not a deny-list:
 * the folder is ASCII `[A-Za-z0-9_-]` (1-64 chars, never a Windows device
 * name such as CON or COM1), the file a real date, a kind token and a counter
 * of 3 to 6 digits. So no separator, dot segment, drive, stream (`:`), control
 * character, trailing dot or space can be in it. The `video` media route checks
 * the real path again (invariant 28).
 */
export const RelativePath = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}\/\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_[a-z][a-z0-9]{0,15}_\d{3,6}\.mp4$/, "must be <SafeName>/<date>_<kind>_<NNN>.mp4")
  .refine((p) => !/^(?:con|prn|aux|nul|com\d|lpt\d)\//i.test(p), "the folder must not be a Windows device name");

/**
 * Where a record's file stands, derived on read and never stored:
 * - `present`: the root matches and the size matches;
 * - `missing`: the root matches but there is no file («файл удалён»);
 * - `changed`: the size or sha256 differs («файл изменён вне Studio»); still playable, still used;
 * - `elsewhere`: the record's root is not the current export root («файл в другой папке»).
 */
export const FileState = z.enum(["present", "missing", "changed", "elsewhere"]);

/** What the tile says about the music: bounded text, never a URL. An own track drops its tags (3f.4), so it has a title and no artist. */
const VideoMusic = z.strictObject({ title: z.string().min(1).max(120), artist: z.string().min(1).max(120).nullable() });

/** A video record as `videos.list` and `video.changed` show it. */
export const VideoSummary = z.strictObject({
  videoId: Id,
  avatarId: Id,
  kind: VideoKindToken,
  durationMs: z.number().int().positive(),
  bytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  relPath: RelativePath,
  fileState: FileState,
  /** The draft it was rendered from, for «Изменить»; null for a headless spec or a deleted draft. */
  montageId: Id.nullable(),
  /** How many photos the video shows. */
  photoCount: Count,
  /** The track baked in, as the tile shows it; null for a silent video. */
  music: VideoMusic.nullable(),
  /**
   * A poster frame is kept with the record in the library, so the tile can show
   * it even when the file is `missing`; served by `videoId`. False when none was made.
   */
  hasPoster: z.boolean(),
});

/**
 * A finished render, `job.done`'s result. `kind` is the job-result
 * discriminator (as in the other results), so the video's own kind token is
 * `videoKind`.
 */
export const RenderResult = z.strictObject({
  kind: z.literal("render"),
  videoId: Id,
  avatarId: Id,
  bytes: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  videoKind: VideoKindToken,
  relPath: RelativePath,
});

export type FileState = z.infer<typeof FileState>;
export type VideoSummary = z.infer<typeof VideoSummary>;
export type RenderResult = z.infer<typeof RenderResult>;
