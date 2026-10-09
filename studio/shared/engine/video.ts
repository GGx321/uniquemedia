import { z } from "zod";
import { Clip, MontageName } from "./montage";
import { Count, Id, LaunchId } from "./primitives";

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

/** The folder part of a video's path: ASCII `[A-Za-z0-9_-]`, 1-64 chars. The one definition; `RelativePath` is built from it. */
const SAFE_NAME_SOURCE = "[A-Za-z0-9_-]{1,64}";
const SAFE_NAME_PATTERN = new RegExp(`^${SAFE_NAME_SOURCE}$`);
const RELATIVE_PATH_PATTERN = new RegExp(`^${SAFE_NAME_SOURCE}/\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])_[a-z][a-z0-9]{0,15}_\\d{3,6}\\.mp4$`);

/** A Windows reserved device name (any case): CON, PRN, AUX, NUL, COM0-9, LPT0-9. Windows treats them as devices in every folder. */
export function isWindowsDeviceName(name: string): boolean {
  return /^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name);
}

/**
 * Whether `name` may be the folder of a `RelativePath`. The exact predicate
 * `RelativePath` applies to its first segment, exported so the engine's
 * `SafeName` builder can never produce a name that the contract then refuses.
 */
export function isSafeName(name: string): boolean {
  return SAFE_NAME_PATTERN.test(name) && !isWindowsDeviceName(name);
}

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
  .regex(RELATIVE_PATH_PATTERN, "must be <SafeName>/<date>_<kind>_<NNN>.mp4")
  .refine((p) => !isWindowsDeviceName(p.slice(0, p.indexOf("/"))), "the folder must not be a Windows device name");

/**
 * Where a record's file stands, derived on read and never stored:
 * - `present`: the root matches and the size matches;
 * - `missing`: the root matches but there is no file («файл удалён»);
 * - `changed`: the size or sha256 differs («файл изменён вне Studio»); still playable, still used;
 * - `elsewhere`: the record's root is not the current export root, or the export folder was looked at and refused («файл в другой папке»);
 * - `unchecked` (3e.2, K15): the look at this file failed or did not answer on this read, or the export folder itself did not answer, so
 *   no file could be judged against it («не удалось проверить файл»). It claims nothing about the file: it is neither gone nor in another
 *   folder, and the next read may know.
 * Every state keeps the video's photos used: only the record decides that.
 */
export const FileState = z.enum(["present", "missing", "changed", "elsewhere", "unchecked"]);

/**
 * What the tile says about the music: bounded text, never a URL. An own track drops its tags (3f.4), so it has a title and no
 * artist. `trackId` (K13) names a trending track, for its cover (`studio-media://cover/<trackId>`) and its «E» from `music.list`;
 * null for an own track.
 */
const VideoMusic = z.strictObject({ title: z.string().min(1).max(120), artist: z.string().min(1).max(120).nullable(), trackId: Id.nullable() });

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
  /** The draft's name when it was rendered, kept by the record (K12), so the tile keeps it after the draft is gone; null when it had none. */
  title: MontageName.nullable(),
  /**
   * The first clip as it was rendered (focus resolved): the tile draws it as its still where there is no poster frame
   * (3e.2). Null when the record's clip is not one this build can read.
   */
  firstClip: Clip.nullable(),
  /** Stage 4 (additive): `autopilot` for a video a batch launch made; absent for a manual one (a record from before Stage 4 has none). */
  origin: z.literal("autopilot").optional(),
  /** Stage 4 (additive): the launch that made it; only with `origin`. */
  launchId: LaunchId.optional(),
  /**
   * Stage 4 (additive): when the owner marked it «Опубликовано»; null or absent for a video not marked. The mark lives in `published.jsonl`, never in the
   * record, which is write-once. The list's `published` field says whether the marks could be read.
   */
  publishedAt: z.iso.datetime().nullable().optional(),
}).refine((v) => v.launchId === undefined || v.origin === "autopilot", { message: "a launch id belongs to an autopilot video", path: ["launchId"] });

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
