/** File and folder names of the on-disk library layout. */
export const LIBRARY_FILE = "library.json";
export const AVATARS_DIR = "avatars";
export const RUNS_DIR = "runs";
export const QUARANTINE_DIR = "quarantine";
export const MANIFEST_FILE = "avatar.json";
export const PHOTOS_DIR = "photos";
export const THUMBS_DIR = "thumbs";
export const USED_FILE = "used.jsonl";
export const HISTORY_FILE = "history.jsonl";
export const PLAN_FILE = "plan.json";
export const JOURNAL_FILE = "journal.jsonl";

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

/** A temp file left by a crash while library.json itself was being written. */
export function isLibraryFileTemp(name: string): boolean {
  return name.startsWith(`.${LIBRARY_FILE}.`) && name.endsWith(".tmp");
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
