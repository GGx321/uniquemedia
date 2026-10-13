import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Library } from "../library";
import { fsyncDir, hasErrorCode, readRecordFile, tempSiblingPath, writeJsonAtomic } from "../library/durableFs";
import { CLIPS_DIR } from "../library/layout";
import { clipJournalPath, openClipJournal, type ClipJournal } from "./journal";
import { ClipRecord } from "./schemas";

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.3, I5.53): the clip's files on disk. `<library>/avatars/<avatarId>/clips/` holds, per clip, its journal while it is in flight, the provider's mp4, the
// poster and the record. The record is the commit: it is checked by the strict schema BEFORE it is written (a record that would not read back is never written), and written atomically
// (a temp sibling, an fsync, a rename, a folder flush), so a reader or a restart sees the old record or the new, never a mix. The journal goes once the record stands. Paths come from the
// library's own naming and the clip's id only; nothing here takes a caller's string as a path.

/** The avatar's clips folder, by the library's own naming (the avatar id is validated there, since it becomes a path segment). */
export function clipsDirOf(library: Pick<Library, "avatarDirPath">, avatarId: string): string {
  return join(library.avatarDirPath(avatarId), CLIPS_DIR);
}

/** Makes the clips folder if it is not there yet, and makes its entry in the avatar's folder durable. */
export async function ensureClipsDir(clipsDir: string): Promise<void> {
  const made = await mkdir(clipsDir, { recursive: true });
  if (made !== undefined) await fsyncDir(dirname(clipsDir));
}

export function clipRecordPath(clipsDir: string, clipId: string): string {
  return join(clipsDir, `${clipId}.json`);
}

/** Writes the record (the commit, I5.53): refused before anything is written when it breaks the strict schema. */
export async function writeClipRecord(clipsDir: string, record: ClipRecord): Promise<void> {
  const checked = ClipRecord.parse(record);
  await writeJsonAtomic(clipRecordPath(clipsDir, checked.id), checked);
}

export type ClipRecordRead = { kind: "record"; record: ClipRecord } | { kind: "missing" } | { kind: "invalid" };

/** The record as it is on disk: `missing` when there is none, `invalid` when it does not parse or breaks the strict schema. A disk that cannot be read rejects. */
export async function readClipRecord(clipsDir: string, clipId: string): Promise<ClipRecordRead> {
  const read = await readRecordFile(clipRecordPath(clipsDir, clipId));
  if (!read.ok) {
    if (read.reason === "io") throw read.error;
    return { kind: read.reason };
  }
  const parsed = ClipRecord.safeParse(read.value);
  return parsed.success ? { kind: "record", record: parsed.data } : { kind: "invalid" };
}

/** The clip's journal (`<clipId>.journal.jsonl`). */
export function journalOf(clipsDir: string, clipId: string): ClipJournal {
  return openClipJournal(clipJournalPath(clipsDir, clipId));
}

/** Removes the journal once the record stands (or a clip that never reserved anything ends): a journal that is not there is fine. */
export async function removeJournal(clipsDir: string, clipId: string): Promise<void> {
  try {
    await rm(clipJournalPath(clipsDir, clipId));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await fsyncDir(clipsDir);
}

/** `<clipId>.mp4`: the provider's bytes, byte for byte (I5.54). */
export function clipFilePath(clipsDir: string, clipId: string): string {
  return join(clipsDir, `${clipId}.mp4`);
}

/** `<clipId>.poster.jpg`: the frame at 0.5 s. */
export function posterPath(clipsDir: string, clipId: string): string {
  return join(clipsDir, `${clipId}.poster.jpg`);
}

/**
 * A fresh temp name for the poster, in the clips folder (the library's temp convention, so a sweep after a crash finds it). The poster is drawn there and renamed onto its own name once
 * it is durable: ffmpeg never overwrites a file, so a poster left by an earlier try must not stand in the way.
 */
export function posterTempPath(clipsDir: string, clipId: string): string {
  return tempSiblingPath(posterPath(clipsDir, clipId));
}
