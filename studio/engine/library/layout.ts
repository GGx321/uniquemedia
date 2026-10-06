/** File and folder names of the on-disk library layout. */
export const LIBRARY_FILE = "library.json";
export const AVATARS_DIR = "avatars";
export const RUNS_DIR = "runs";
export const QUARANTINE_DIR = "quarantine";
export const MANIFEST_FILE = "avatar.json";
export const PHOTOS_DIR = "photos";
export const THUMBS_DIR = "thumbs";
/** The owner's "do not use" marks: append-only `{ photoId, op: "reject" | "restore", at }` lines. */
export const REJECTED_FILE = "rejected.jsonl";
/** Video records, one write-once JSON per video (task 3a.8b writes them; 3a.2 reads them). "Used" is derived from these, never from a log of its own. */
export const VIDEOS_DIR = "videos";
/**
 * Own media (Stage 3, 3f.1b): `<library>/media/<mediaId>.json` (one write-once record) beside the stored file `<mediaId>.<ext>`.
 * Library-wide, not per avatar. `.staging` inside it holds the copies an import is still working on (3f.1).
 */
export const MEDIA_DIR = "media";
/**
 * The owner's own scene categories (CS.2): `<library>/categories/<categoryId>.json`, one atomically rewritten record per category (library-wide,
 * shared by every avatar), and `pending-<jobId>.json` for a paid create or regenerate that has not ended. Older builds never look here.
 */
export const CATEGORIES_DIR = "categories";
/** A category record's `schemaVersion`: the store stamps it, and a newer one is refused and kept as it is (it would lose what it does not know on the next write). */
export const CATEGORY_FILE_SCHEMA_VERSION = 1;
export const MEDIA_STAGING_DIR = ".staging";
/** An own-media record's `schemaVersion`: the writer (mediaRecords.ts) stamps it and refuses to list a newer one (it is kept as it is). */
export const MEDIA_RECORD_SCHEMA_VERSION = 1;
/**
 * Montage drafts (Stage 3, 3d.1a): one JSON per draft, `avatars/<avatarId>/montages/<montageId>.json`, written
 * atomically (temp, fsync, rename) by the montage service. A draft is the owner's work in progress, never a source
 * of "used" (only a rendered video's record is).
 */
export const MONTAGES_DIR = "montages";
/** S8: an avatar's cached focus points (`avatars/<id>/focus.json`); a cache, rebuilt when missing or corrupt. */
export const FOCUS_FILE = "focus.json";
export const HISTORY_FILE = "history.jsonl";
export const PLAN_FILE = "plan.json";
export const JOURNAL_FILE = "journal.jsonl";
/**
 * Legacy (T6c, H2; removed 2026-10-05): older builds kept a library-root list of refused imports here. Nothing reads or writes it any more;
 * the name survives only so a crash leftover of its write still counts as a library temp file. The file itself is left alone.
 */
const LEGACY_REFUSED_IMPORTS_FILE = "refused-imports.json";

/**
 * The schema version this build writes and the newest it reads, per record
 * kind. An older build refuses a library holding a newer record rather than
 * quarantine it. Avatar manifests are at version 2: trait values keep their
 * JSON types (text, number, list of text); version 1 manifests (text-only
 * traits) are still read as they are.
 */
export const LIBRARY_FILE_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 2;
export const SIDECAR_SCHEMA_VERSION = 1;
/** A draft file's `schemaVersion`: the montage service stamps it, and refuses to read a newer one (it would drop what it does not know on the next save). */
export const MONTAGE_FILE_SCHEMA_VERSION = 1;
/** A video record's `schemaVersion`: the writer (task 3a.8b) stamps it, the reader (videoRecords.ts) refuses a newer one with its own reason. */
export const VIDEO_RECORD_SCHEMA_VERSION = 1;

/**
 * A temp file left by a crash while one of the library root's own JSON
 * files — library.json, or the removed refused-imports.json (T6c review
 * round 3, L8) — was being written (durableFs.ts's own `.<name>.<hex>.tmp` shape).
 */
export function isLibraryFileTemp(name: string): boolean {
  return [LIBRARY_FILE, LEGACY_REFUSED_IMPORTS_FILE].some((file) => name.startsWith(`.${file}.`) && name.endsWith(".tmp"));
}

/** True when a parsed record declares a schema version newer than `newestReadable`, the newest this build knows for its kind. */
export function isFromNewerVersion(raw: unknown, newestReadable: number): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "schemaVersion" in raw &&
    typeof raw.schemaVersion === "number" &&
    raw.schemaVersion > newestReadable
  );
}
