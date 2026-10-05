// The time bounds of the video commands that main's command deadlines (`control.ts` `COMMAND_DEADLINE_MS`) are sized from. A leaf module with no imports,
// so main can read the numbers without loading the engine.

/** Bounds one export folder check (start, a settings update, a render attempt, a delete): a stale network share must not block any of them. */
export const EXPORT_CHECK_TIMEOUT_MS = 5_000;
/** One record's file check in a listing or a `videos.get`; a disk that does not answer reads `unchecked` (K15). */
export const RECORD_CHECK_TIMEOUT_MS = 5_000;
/** A delete's disk work (a full hash of a file up to 64 MiB, two unlinks, flushes). */
export const DELETE_TIMEOUT_MS = 60_000;
/** Room for the answer to travel and for the engine's other work around a delete (the library's write turn, the announcements). */
export const DELETE_DEADLINE_SLACK_MS = 10_000;
/** What main waits for `videos.delete`: the export check, then the bounded delete, then slack; the engine's own timeout answer is always inside it. */
export const VIDEOS_DELETE_DEADLINE_MS = EXPORT_CHECK_TIMEOUT_MS + DELETE_TIMEOUT_MS + DELETE_DEADLINE_SLACK_MS;
