import * as nodePath from "node:path";
import { placeOf } from "../exportName";
import { runExclusive } from "../library/keyedMutex";
import type { CommitFs } from "./commitFs";

// One lock per export root, held by a commit from its name claim to its record,
// and by the recovery that runs when a library opens. A recovery that ran in the
// middle of a commit would see its placeholder, its intent, its half-renamed file
// as a crash's leftovers and delete or adopt them under it; and a placeholder
// claimed after recovery took its snapshot would look free to it. The lock is
// keyed by the root's REAL path as a place, so two spellings of one folder share it.
// (It is process-wide, like `runExclusive`: one engine, one process.)

export async function withRootLock<T>(fs: Pick<CommitFs, "realpath">, root: string, caseInsensitive: boolean, work: () => Promise<T>): Promise<T> {
  const real = await fs.realpath(root);
  return runExclusive(`export-root:${placeOf(nodePath, real, caseInsensitive)}`, work);
}
