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
export const HISTORY_FILE = "history.jsonl";
export const PLAN_FILE = "plan.json";
export const JOURNAL_FILE = "journal.jsonl";
/** T6c (H2): a library-root file listing the sha256 of every imported photo the mandatory one-time age check has already refused, so re-picking the exact same bytes cannot re-roll it for free. */
export const REFUSED_IMPORTS_FILE = "refused-imports.json";

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
export const REFUSED_IMPORTS_SCHEMA_VERSION = 1;

/**
 * A temp file left by a crash while one of the library root's own JSON
 * files — library.json or refused-imports.json (T6c review round 3, L8) —
 * was being written (durableFs.ts's own `.<name>.<hex>.tmp` shape).
 */
export function isLibraryFileTemp(name: string): boolean {
  return [LIBRARY_FILE, REFUSED_IMPORTS_FILE].some((file) => name.startsWith(`.${file}.`) && name.endsWith(".tmp"));
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
