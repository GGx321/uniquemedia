import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hasErrorCode, readJsonFile } from "./durableFs";
import { VIDEOS_DIR } from "./layout";
import { LibraryIdSchema } from "./schemas";

// The library's view of a video record (Stage 3 plan, "Library, storage and
// contract additions"): `avatars/<avatarId>/videos/<videoId>.json`, written
// once by the commit of task 3a.8b. Nothing here writes; this is the small
// reader that "used" is derived from (invariant 24), so it asks a record for
// exactly the scene photos it lists and nothing else. Every other field
// (`file`, the resolved spec's layers and music, the encoder facts) is the
// record's own business and may grow without this reader noticing.

/** A cell as far as "used" is concerned: a scene photo names its id, an own upload names nothing that counts. */
const CellUse = z.looseObject({
  photo: z.union([z.null(), z.looseObject({ source: z.literal("scene"), photoId: LibraryIdSchema }), z.looseObject({ source: z.literal("own") })]),
});

/** A photo clip has one `cell`, a collage `cells`; a video clip has neither. */
const ClipUse = z.looseObject({ cell: CellUse.optional(), cells: z.array(CellUse).optional() });

/**
 * What the reader needs of a record. A scene ref whose id does not fit is a
 * failure of the whole record, never a skipped cell: a record that cannot say
 * which photos it holds must not silently free them.
 */
const VideoRecordShape = z.looseObject({
  schemaVersion: z.literal(1),
  id: LibraryIdSchema,
  avatarId: LibraryIdSchema,
  spec: z.looseObject({ clips: z.array(ClipUse) }),
});

/** One record, reduced to what the index needs. */
export interface VideoRecordUse {
  videoId: string;
  /** The scene photos it lists, each once, in order of appearance. */
  photoIds: string[];
}

/** A file in `videos/` that is not a usable record, with why. `file` is relative to the avatar folder. */
export interface VideoRecordProblem {
  file: string;
  detail: string;
}

export interface VideoRecordsRead {
  records: VideoRecordUse[];
  problems: VideoRecordProblem[];
}

/** Whether `name` is a record's file name: `<id>.json`, not a dot file (pending intents, temp files, OS metadata). */
function isRecordFileName(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(".json");
}

/**
 * Reads every record of one avatar. An absent `videos/` folder is an avatar
 * with no videos. Anything unreadable, foreign or misfiled is a problem, not a
 * throw: it must never stop a library from opening, but it must be seen (the
 * caller reports it and stops treating the avatar's usage as reliable).
 * `videos/.pending/` (commit intents) and dot files are not records.
 */
export async function readVideoRecords(avatarDir: string, avatarId: string): Promise<VideoRecordsRead> {
  const read: VideoRecordsRead = { records: [], problems: [] };
  const dir = join(avatarDir, VIDEOS_DIR);
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && isRecordFileName(e.name)).map((e) => e.name).sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return read;
    if (hasErrorCode(error, "ENOTDIR")) return { records: [], problems: [{ file: VIDEOS_DIR, detail: `${VIDEOS_DIR} is not a folder` }] };
    throw error;
  }

  for (const name of names) {
    const file = `${VIDEOS_DIR}/${name}`;
    const raw = await readJsonFile(join(dir, name));
    if (!raw.ok) {
      read.problems.push({ file, detail: raw.detail });
      continue;
    }
    const parsed = VideoRecordShape.safeParse(raw.value);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      read.problems.push({ file, detail: `does not fit a video record at ${first?.path.join(".") ?? "the top"}: ${first?.message ?? "invalid"}` });
      continue;
    }
    const record = parsed.data;
    if (`${record.id}.json` !== name) {
      read.problems.push({ file, detail: `record id ${record.id} does not match its file name` });
      continue;
    }
    if (record.avatarId !== avatarId) {
      read.problems.push({ file, detail: `record belongs to avatar ${record.avatarId}, not ${avatarId}` });
      continue;
    }
    const photoIds = new Set<string>();
    for (const clip of record.spec.clips) {
      for (const cell of clip.cell === undefined ? [] : [clip.cell]) if (cell.photo?.source === "scene") photoIds.add(cell.photo.photoId);
      for (const cell of clip.cells ?? []) if (cell.photo?.source === "scene") photoIds.add(cell.photo.photoId);
    }
    read.records.push({ videoId: record.id, photoIds: [...photoIds] });
  }
  return read;
}
