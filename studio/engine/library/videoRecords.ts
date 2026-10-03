import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hasErrorCode } from "./durableFs";
import { VIDEOS_DIR, VIDEO_RECORD_SCHEMA_VERSION, isFromNewerVersion } from "./layout";
import { LibraryIdSchema } from "./schemas";

// The library's view of a video record (Stage 3 plan, "Library, storage and
// contract additions"): `avatars/<avatarId>/videos/<videoId>.json`, written
// once by the commit of task 3a.8b. Nothing here writes; this is the small
// reader that "used" is derived from (invariant 24), so it asks a record for
// exactly the scene photos it lists and nothing else. Every other field
// (`file`, the resolved spec's layers and music, the encoder facts) is the
// record's own business and may grow without this reader noticing.
//
// It is strict about the parts it reads: a record whose clips do not have the
// shape their `kind` promises would read as "uses no photo" and free photos a
// video really shows, so it is refused as a whole instead.

/**
 * A cell as far as "used" is concerned: a scene photo names its id, an own
 * upload names nothing that counts. There is no empty cell: a record holds the
 * RESOLVED spec, which passed spec validation (`cell-empty` is a spec rule), so
 * a null photo can only come from a faulty writer or a hand edit, and would free
 * a photo the video shows.
 */
const CellUse = z.looseObject({
  photo: z.union([z.looseObject({ source: z.literal("scene"), photoId: LibraryIdSchema }), z.looseObject({ source: z.literal("own") })]),
});

/** A clip by its `kind`: a photo clip has one cell, a collage 2 to 4, an own video none. An unknown kind fails. */
const ClipUse = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("photo"), cell: CellUse }),
  z.looseObject({ kind: z.literal("collage"), cells: z.array(CellUse).min(2).max(4) }),
  z.looseObject({ kind: z.literal("video") }),
]);

/**
 * The part of a record's `spec` that "used" depends on: the clips, by `kind`. Loose at every level, so a
 * later build's extra field is kept and never makes a record (or a commit intent, which reuses this shape)
 * unreadable. The writer (`videos/record.ts`) parses the resolved spec with it.
 */
export const RecordSpecShape = z.looseObject({ clips: z.array(ClipUse).min(1) });

/** What the reader needs of a record; a record with no clip at all is not a rendered video. */
const VideoRecordShape = z.looseObject({
  schemaVersion: z.literal(VIDEO_RECORD_SCHEMA_VERSION),
  id: LibraryIdSchema,
  avatarId: LibraryIdSchema,
  spec: RecordSpecShape,
  /** Only the draft's name matters here; a value that is not an id reads as "no draft" and never makes the record unreadable. */
  montageId: LibraryIdSchema.nullable().optional().catch(null),
});

/** One record, reduced to what the index needs. */
export interface VideoRecordUse {
  videoId: string;
  /** The scene photos it lists, each once, in order of appearance. */
  photoIds: string[];
  /** The draft it was rendered from; null for a headless spec, or a record written before drafts existed. */
  montageId?: string | null;
}

/**
 * A file in `videos/` that is not a usable record.
 * - `unreadable`: broken, foreign or misfiled; needs repair.
 * - `too-new`: written by a newer Studio; the fix is to update the app, not to repair.
 * `file` is relative to the avatar folder. `otherAvatarId` is set when the record
 * names another avatar than the folder it lies in: that avatar's photos may be in it,
 * so that avatar's usage cannot be trusted either.
 */
export interface VideoRecordProblem {
  file: string;
  reason: "unreadable" | "too-new";
  detail: string;
  otherAvatarId?: string;
}

export interface VideoRecordsRead {
  records: VideoRecordUse[];
  problems: VideoRecordProblem[];
}

/** Test seam. */
export interface ReadVideoRecordsOptions {
  /** Called before each record file is read. */
  beforeRead?: (path: string) => void | Promise<void>;
}

/** Whether `name` is a record's file name: `<id>.json`, not a dot file (pending intents, temp files, OS metadata). */
function isRecordFileName(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(".json");
}

/** What one name in `videos/` holds: a record, a problem, or nothing any more (deleted between the listing and the read). */
export type RecordFileRead = { kind: "record"; record: VideoRecordUse } | { kind: "problem"; problem: VideoRecordProblem } | { kind: "gone" };

/**
 * Reads ONE record file of the avatar, by its name in `videos/`: the same judgement `readVideoRecords` passes on every file,
 * for a caller that must look at one file again right before it acts on it (3e.2's quarantine never moves a file that reads
 * as sound by then). `name` must be a record's file name (`<id>.json`, not a dot file).
 */
export async function readVideoRecordFile(avatarDir: string, avatarId: string, name: string, options: ReadVideoRecordsOptions = {}): Promise<RecordFileRead> {
  if (!isRecordFileName(name)) throw new TypeError("readVideoRecordFile: not a record's file name");
  const file = `${VIDEOS_DIR}/${name}`;
  const path = join(avatarDir, VIDEOS_DIR, name);
  await options.beforeRead?.(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { kind: "gone" };
    // Anything else (EACCES, EISDIR, a network volume's error) is this file's problem, never the library's: it must still open.
    return { kind: "problem", problem: { file, reason: "unreadable", detail: "could not be read" } };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "problem", problem: { file, reason: "unreadable", detail: "is not valid JSON" } };
  }
  if (isFromNewerVersion(value, VIDEO_RECORD_SCHEMA_VERSION)) return { kind: "problem", problem: { file, reason: "too-new", detail: "was written by a newer version of Studio" } };
  const parsed = VideoRecordShape.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { kind: "problem", problem: { file, reason: "unreadable", detail: `does not fit a video record at ${first?.path.join(".") ?? "the top"}: ${first?.message ?? "invalid"}` } };
  }
  const record = parsed.data;
  if (`${record.id}.json` !== name) return { kind: "problem", problem: { file, reason: "unreadable", detail: `record id ${record.id} does not match its file name` } };
  if (record.avatarId !== avatarId) {
    return { kind: "problem", problem: { file, reason: "unreadable", detail: `record belongs to avatar ${record.avatarId}, not ${avatarId}`, otherAvatarId: record.avatarId } };
  }
  const photoIds = new Set<string>();
  for (const clip of record.spec.clips) {
    const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
    for (const cell of cells) if (cell.photo.source === "scene") photoIds.add(cell.photo.photoId);
  }
  return { kind: "record", record: { videoId: record.id, photoIds: [...photoIds], montageId: record.montageId ?? null } };
}

/** The problem `videos/` itself is when it is not a folder (a file where the folder goes). */
export const VIDEOS_NOT_A_FOLDER: VideoRecordProblem = { file: VIDEOS_DIR, reason: "unreadable", detail: `${VIDEOS_DIR} is not a folder` };

/**
 * Reads every record of one avatar. An absent `videos/` folder is an avatar
 * with no videos. Anything unreadable, foreign or misfiled is a problem, not a
 * throw: it must never stop a library from opening, but it must be seen (the
 * caller reports it and stops treating the avatar's usage as reliable).
 * `videos/.pending/` (commit intents) and dot files are not records. A file
 * that vanishes between the listing and the read was deleted meanwhile (a
 * record's delete): it is gone, not corrupt.
 */
export async function readVideoRecords(avatarDir: string, avatarId: string, options: ReadVideoRecordsOptions = {}): Promise<VideoRecordsRead> {
  const read: VideoRecordsRead = { records: [], problems: [] };
  const dir = join(avatarDir, VIDEOS_DIR);
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && isRecordFileName(e.name)).map((e) => e.name).sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return read;
    if (hasErrorCode(error, "ENOTDIR")) return { records: [], problems: [{ ...VIDEOS_NOT_A_FOLDER }] };
    throw error;
  }

  for (const name of names) {
    const one = await readVideoRecordFile(avatarDir, avatarId, name, options);
    if (one.kind === "record") read.records.push(one.record);
    else if (one.kind === "problem") read.problems.push(one.problem);
  }
  return read;
}
