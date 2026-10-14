import { join } from "node:path";
import { z } from "zod";
import { Id, LaunchId, LaunchVideoKey, MAX_CLIPS, MontageName, RelativePath, VideoKindToken } from "../../shared/engine";
import { AVATARS_DIR, VIDEOS_DIR, VIDEO_RECORD_SCHEMA_VERSION } from "../library/layout";
import { RecordSpecShape } from "../library/videoRecords";

// The video record and its commit intent (Stage 3 plan, "Outputs and export"
// and "Commit"). A record is `avatars/<avatarId>/videos/<videoId>.json`,
// written once. An intent is the SAME JSON, held at
// `avatars/<avatarId>/videos/.pending/<videoId>.json` while the file is being
// put in place, and renamed to the record as the commit's last step. The library's
// own reader (`library/videoRecords.ts`) needs only the clips of `spec`; every
// other field here is the writer's and the readers of `fileState` and delete.

/** Where the intents live, inside `videos/`. The library's reader skips it (a dot entry). */
export const PENDING_DIR = ".pending";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** What the tile says about the track baked in (`VideoSummary.music`); null for a silent video. */
const RecordMusic = z.strictObject({ title: z.string().min(1).max(120), artist: z.string().min(1).max(120).nullable() });

/**
 * What the render resolved for the music (3c.5): where in the track it started, the gain in dB the true-peak pass chose (never
 * above 0: invariant 21), and the sha256 of the track file it read. Absent for a silent video and for a record from before 3c.5.
 */
const RecordAudio = z.strictObject({ trackSha: Sha256Hex, startMs: z.int().nonnegative(), gainDb: z.number().min(-60).max(0) });

/**
 * The file a record names: the export root's identity plus a path RELATIVE to
 * it, never an absolute path (a moved folder keeps working), and what the file
 * was when it was committed. `mtimeMs` (whole milliseconds) is what lets a
 * listing tell "unchanged" from a stat alone; a record without it is checked
 * by hash instead.
 */
export const VideoFileRef = z.looseObject({
  rootId: Id,
  relPath: RelativePath,
  bytes: z.int().positive(),
  sha256: Sha256Hex,
  mtimeMs: z.int().nonnegative().optional(),
});
export type VideoFileRef = z.infer<typeof VideoFileRef>;

/** One clip frame of a record or an intent (`ClipFrame`). */
const ClipFrameSchema = z.strictObject({ mediaId: Id, clipId: Id, photoId: Id });

/**
 * A record, and an intent (the record-to-be). `spec` is the RESOLVED montage
 * shape: focus filled, the exact clips rendered. Loose, so a later build's extra
 * field does not make an older one refuse the file (a NEWER `schemaVersion` is
 * refused by version, before this schema).
 */
export const VideoRecordSchema = z.looseObject({
  schemaVersion: z.literal(VIDEO_RECORD_SCHEMA_VERSION),
  id: Id,
  avatarId: Id,
  /** The render job that made the file: names its `.studio-part-<jobId>.mp4` temp for recovery. */
  jobId: Id,
  createdAt: z.iso.datetime(),
  /** The kind token of the file name. */
  kind: VideoKindToken,
  durationMs: z.int().positive(),
  frames: z.int().positive(),
  /** The draft it was rendered from; null for a headless spec. */
  montageId: Id.nullable(),
  /**
   * The draft's name when it was rendered (3e.2, K12), so the tile keeps it after the draft is renamed or deleted; null for a
   * draft with no name or a headless spec. Absent from records written before titles; a value that is not a montage name reads
   * as null and never makes the record unreadable (it is only shown).
   */
  title: MontageName.nullable().optional().catch(null),
  music: RecordMusic.nullable(),
  audio: RecordAudio.optional(),
  file: VideoFileRef,
  spec: RecordSpecShape,
  /**
   * Stage 4 (additive, plan §8.3, D5: NO schema bump): who made the video. `autopilot` for a batch launch, absent for a manual one and for every record from before Stage 4.
   * The record is loose, so an older build ignores these fields. A value this build cannot read makes the record unreadable (the avatar's usage becomes unknown, the existing
   * safe path): dropping a bad `launchVideoKey` would let step 9 of the launch's crash recovery render a second video for the key. The intent carries them too.
   */
  origin: z.literal("autopilot").optional(),
  /** Stage 4 (additive): the launch that made it, and the video's key in it (`<avatar>-<n>`), the launch's idempotency key for a render submitted before a crash. */
  launchId: LaunchId.optional(),
  launchVideoKey: LaunchVideoKey.optional(),
  /**
   * 5b.2 (additive, S5.WA2; plan s5b2 I5.60, Q-F = 1): the clips whose montage copies this video holds, resolved ONCE at admission: the copy, the clip and the photo the clip was made from. A photo
   * and every clip made from it are one frame, so these photos are used as the spec's scene photos are, and nothing depends on the copy later (a deleted clip, copy or avatar never frees a used
   * frame). Absent from a video with no clip copy and from every record written before 5b.2. Strict when present: an entry that is not a frame makes the record unreadable.
   */
  clipFrames: z.array(ClipFrameSchema).max(MAX_CLIPS).optional(),
});
export type VideoRecord = z.infer<typeof VideoRecordSchema>;

/**
 * Who made a video and under which launch (Stage 4, plan §8.3): the three fields together, which is how `VideoRecordWriteSchema` accepts them. A manual render has none. The batch
 * autopilot gives one to its renders so that a crash between the intent and the record is resolved by what the record says, never by guessing from photo usage (§3.6 step 9).
 */
export interface VideoProvenance {
  readonly origin: "autopilot";
  readonly launchId: string;
  readonly launchVideoKey: string;
}

/** A clip as far as "used" goes, structurally, so the contract's `Clip` and a record's loose clip both fit. */
interface ClipLike {
  readonly kind: string;
  /** An own video clip's media (a clip's montage copy is one). */
  readonly mediaId?: string;
  readonly cell?: CellLike;
  readonly cells?: readonly CellLike[];
}
interface CellLike {
  readonly photo: { readonly source: string; readonly photoId?: string } | null;
}

/** The scene photos a spec's clips show, each once, in order of appearance: what "used" counts. Own uploads never count. */
export function scenePhotoIds(clips: readonly ClipLike[]): string[] {
  const seen = new Set<string>();
  for (const clip of clips) {
    const cells = clip.kind === "photo" && clip.cell !== undefined ? [clip.cell] : clip.kind === "collage" ? (clip.cells ?? []) : [];
    for (const cell of cells) if (cell.photo?.source === "scene" && cell.photo.photoId !== undefined) seen.add(cell.photo.photoId);
  }
  return [...seen];
}

/** A resolved spec as a record keeps it: validated loosely (a spec with an empty cell is a caller's bug and throws), and nothing in it dropped. */
export function parseRecordSpec(spec: unknown): VideoRecord["spec"] {
  return RecordSpecShape.parse(spec);
}

// ---------- where things live in a library ----------

export interface VideoPaths {
  /** `avatars/<avatarId>/videos` */
  readonly videosDir: string;
  /** `avatars/<avatarId>/videos/.pending` */
  readonly pendingDir: string;
  /** `avatars/<avatarId>/videos/<videoId>.json` */
  record(videoId: string): string;
  /** `avatars/<avatarId>/videos/.pending/<videoId>.json` */
  intent(videoId: string): string;
}

/** The record and intent paths of one avatar. Ids are library ids (no separators), so nothing here can leave the folder. */
export function videoPaths(libraryRoot: string, avatarId: string): VideoPaths {
  if (!Id.safeParse(avatarId).success) throw new TypeError("videoPaths: not an avatar id");
  const videosDir = join(libraryRoot, AVATARS_DIR, avatarId, VIDEOS_DIR);
  const pendingDir = join(videosDir, PENDING_DIR);
  const safe = (videoId: string): string => {
    if (!Id.safeParse(videoId).success) throw new TypeError("videoPaths: not a video id");
    return `${videoId}.json`;
  };
  return { videosDir, pendingDir, record: (videoId) => join(videosDir, safe(videoId)), intent: (videoId) => join(pendingDir, safe(videoId)) };
}

/** The temp a render writes next to its final file: `.studio-part-<jobId>.mp4`. */
export const partNameOf = (jobId: string): string => `.studio-part-${jobId}.mp4`;

/**
 * What may be WRITTEN (intents and records): the same schema, and provenance is all three fields or none. Used by `writeIntent`, so a malformed or half-given key never
 * reaches the disk.
 */
export const VideoRecordWriteSchema = VideoRecordSchema.refine(
  (r) => [r.origin, r.launchId, r.launchVideoKey].every((v) => v === undefined) || [r.origin, r.launchId, r.launchVideoKey].every((v) => v !== undefined),
  { message: "provenance is origin, launchId and launchVideoKey together, or none of them", path: ["origin"] },
);

// ---------- frames (5b.2, S5.WA2; plan s5b2 I5.60, Q-F = 1): a photo and every clip made from it are ONE frame ----------

/** What a spec says of a clip's montage copy, once, at admission: the copy, the clip, and the photo the clip was made from. A record and an intent keep it, so nothing depends on the copy later. */
export type ClipFrame = z.infer<typeof ClipFrameSchema>;

/** Where a copy comes from, as far as frames go: `MediaSummary.origin` has this shape and more. Undefined for a media that is no clip's copy. */
export type FrameOrigin = (mediaId: string) => { readonly clipId: string; readonly photoId: string } | undefined;

/** The snapshot of a spec's clip frames: one per own video clip whose media is a clip's copy, in clip order, each media once. */
export function clipFramesOf(clips: readonly ClipLike[], originOf: FrameOrigin): ClipFrame[] {
  const seen = new Set<string>();
  const frames: ClipFrame[] = [];
  for (const clip of clips) {
    if (clip.kind !== "video" || clip.mediaId === undefined || seen.has(clip.mediaId)) continue;
    const origin = originOf(clip.mediaId);
    if (origin === undefined) continue;
    seen.add(clip.mediaId);
    frames.push({ mediaId: clip.mediaId, clipId: origin.clipId, photoId: origin.photoId });
  }
  return frames;
}

/** A spec's frames: its scene photos, then the photo of every clip copy it holds, each once. What "used" means for a spec that is being rendered or drafted. */
export function framePhotoIds(clips: readonly ClipLike[], originOf: FrameOrigin): string[] {
  return [...new Set([...scenePhotoIds(clips), ...clipFramesOf(clips, originOf).map((frame) => frame.photoId)])];
}

/** The frames of a record or an intent: the spec's scene photos, then its `clipFrames`' photos (an old record has none), each once. Never reads the media. */
export function recordFramePhotoIds(record: { readonly spec: { readonly clips: readonly ClipLike[] }; readonly clipFrames?: readonly { readonly photoId: string }[] | undefined }): string[] {
  return [...new Set([...scenePhotoIds(record.spec.clips), ...(record.clipFrames ?? []).map((frame) => frame.photoId)])];
}
