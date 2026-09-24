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

/** The only schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 1;

/** A temp file left by a crash while library.json itself was being written. */
export function isLibraryFileTemp(name: string): boolean {
  return name.startsWith(`.${LIBRARY_FILE}.`) && name.endsWith(".tmp");
}

/** True when a parsed record declares a schema version newer than this build knows. */
export function isFromNewerVersion(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "schemaVersion" in raw &&
    typeof raw.schemaVersion === "number" &&
    raw.schemaVersion > CURRENT_SCHEMA_VERSION
  );
}
