import { z } from "zod";
import { Id } from "./primitives";

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

const MAX_RELATIVE_PATH = 512;

/**
 * A path inside the export folder, `/`-separated: `<SafeName>/<file>.mp4`.
 * Never absolute, never a drive, never a `..` or `.` segment, no empty
 * segment, no backslash, no NUL. The `video` media route checks it again
 * against the real folder (invariant 28); this only rejects the obviously wrong.
 */
export const RelativePath = z
  .string()
  .min(1)
  .max(MAX_RELATIVE_PATH)
  .refine((p) => !p.includes("\0") && !p.includes("\\"), "must not contain a NUL byte or a backslash")
  .refine((p) => !/^[A-Za-z]:/.test(p), "must not start with a drive")
  .refine((p) => p.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), "must be made of plain segments only");

/**
 * Where a record's file stands, derived on read and never stored:
 * - `present`: the root matches and the size matches;
 * - `missing`: the root matches but there is no file («файл удалён»);
 * - `changed`: the size or sha256 differs («файл изменён вне Studio»); still playable, still used;
 * - `elsewhere`: the record's root is not the current export root («файл в другой папке»).
 */
export const FileState = z.enum(["present", "missing", "changed", "elsewhere"]);

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
