import type { Library } from "../library";
import { scenePhotoIds, type VideoRecord } from "./record";

// Telling the used index about a record the commit has just made durable
// (invariant 24: "used" comes from the records). This is the job's last step,
// before the queue lets go of the photo reservation, so there is never a moment
// when the photos are neither reserved nor used.
//
// DECISION for an index update that throws: the record on disk is the truth, so
// the JOB STILL ENDS `done` (it made a video and a record; failing it would make
// the queue release the photos while the record stands). This function never
// throws. It heals in steps:
//   1. add the record to the index (in memory, the normal way);
//   2. if that throws, rebuild the avatar's index from the disk at once;
//   3. if that fails too, close the avatar (`flagVideoIndexStale`): its usage reads
//      `index-stale` (no record is broken, nothing may be "repaired") until a reload or
//      the next open reads the record.
// Each failure is logged by kind only (never a path). The one thing that must not
// happen is a video on disk whose photos are offered as free.

export type IndexPort = Pick<Library, "addVideoRecordToIndex" | "reloadVideoRecords" | "flagVideoIndexStale">;
export type IndexOutcome = "indexed" | "reloaded" | "flagged";

function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : error.name;
}

export async function indexCommittedRecord(library: IndexPort, record: VideoRecord, log: (line: string) => void): Promise<IndexOutcome> {
  try {
    library.addVideoRecordToIndex(record.avatarId, { videoId: record.id, photoIds: scenePhotoIds(record.spec.clips), montageId: record.montageId, file: { rootId: record.file.rootId, relPath: record.file.relPath } });
    return "indexed";
  } catch (error) {
    log(`video ${record.id}: the used index could not take the committed record (${kindOf(error)}); rebuilding it from disk`);
  }
  try {
    await library.reloadVideoRecords(record.avatarId);
    return "reloaded";
  } catch (error) {
    log(`video ${record.id}: the used index could not be rebuilt either (${kindOf(error)}); the avatar is closed until the record is read`);
  }
  library.flagVideoIndexStale(record.avatarId, record.id);
  return "flagged";
}
