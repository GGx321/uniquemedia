import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Focus } from "../../shared/engine/montage";
import { writeJsonAtomic } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { LibraryIdSchema } from "../library/schemas";

// S8: the persisted focus answers, one small file per avatar
// (`avatars/<avatarId>/focus.json`), so a restart does not run YuNet again.
//
// Why one file per avatar next to the manifest, not one per photo in photos/:
// the library's survey reads `photos/` and treats anything named like a photo's
// own files (`<id>.<ext>`) as a record to pair or quarantine. This file is not
// named like one, and the survey only ever moves TEMP files at the avatar level,
// so a leftover `.focus.json.<hex>.tmp` from a crash is cleaned up like any other.
//
// It is a cache, never a source of truth: nothing here can fail a caller. An
// unreadable, corrupt, wrong-shaped or wrong-method file reads as empty (the
// answers are recomputed and the file rewritten); a photo's entry counts only
// while its `sha256` still equals the sidecar's, so changed bytes are never
// served a stale point.

export const FOCUS_FILE = "focus.json";

/**
 * How the point is derived (focusPoint.ts). A file written by another method is
 * stale as a whole: change this string when the derivation changes.
 */
export const FOCUS_METHOD = "yunet-box-centre-v1";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** `focus: null` is a real, cached answer: YuNet ran and found no face. */
const EntrySchema = z.strictObject({ sha256: Sha256, focus: Focus.nullable() });
export type FocusCacheEntry = z.infer<typeof EntrySchema>;

const FileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  method: z.string(),
  photos: z.record(LibraryIdSchema, EntrySchema),
});

/** The avatar's cached answers by photo id; empty when the file is missing, unreadable, corrupt or from another method. */
export async function readFocusCache(path: string): Promise<Map<string, FocusCacheEntry>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return new Map();
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success || parsed.data.method !== FOCUS_METHOD) return new Map();
  return new Map(Object.entries(parsed.data.photos));
}

/**
 * Adds (or replaces) one photo's answer, atomically: re-read under a per-file
 * lock, merge, drop the entries of photos that no longer exist (`livePhotoIds`),
 * write a temp file, fsync and rename. Two answers for two photos of one avatar
 * therefore never overwrite each other.
 */
export function rememberFocus(path: string, photoId: string, entry: FocusCacheEntry, livePhotoIds: ReadonlySet<string>): Promise<void> {
  return runExclusive(`focus:${path}`, async () => {
    const photos = new Map([...(await readFocusCache(path))].filter(([id]) => livePhotoIds.has(id)));
    photos.set(photoId, entry);
    await writeJsonAtomic(path, { schemaVersion: 1, method: FOCUS_METHOD, photos: Object.fromEntries(photos) });
  });
}
