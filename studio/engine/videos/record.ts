import { join } from "node:path";
import { z } from "zod";
import { Id, MontageName, RelativePath, VideoKindToken } from "../../shared/engine";
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
});
export type VideoRecord = z.infer<typeof VideoRecordSchema>;

/** A clip as far as "used" goes, structurally, so the contract's `Clip` and a record's loose clip both fit. */
interface ClipLike {
  readonly kind: string;
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
