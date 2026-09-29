import * as nodePath from "node:path";
import { placeOf } from "../exportName";
import { runExclusive } from "../library/keyedMutex";
import type { CommitFs } from "./commitFs";

// One lock per export root, held by a commit from its name claim to its record,
// and by the recovery that runs when a library opens. A recovery that ran in the
// middle of a commit would see its placeholder, its intent, its half-renamed file
// as a crash's leftovers and delete or adopt them under it; and a placeholder
// claimed after recovery took its snapshot would look free to it. The lock is
// keyed by the root's REAL path as a place, letter case ALWAYS folded (as `live.ts` does):
// whether the volume folds case is a guess two callers can make differently, and a
// lock that two spellings could hold at once is no lock. Over-sharing costs nothing.
// (It is process-wide, like `runExclusive`: one engine, one process.)
//
// A WAIT IS NOT FOREVER. The lock is held across disk calls, and a hung one (a dead
// network share) would hold it for ever, so both ways of waiting have a way out:
// - a commit waits with its `AbortSignal`: a cancel while it waits ends it, and it never runs;
// - recovery waits `waitMs`, then gives up (`LockWaitTimeout`) and defers the root.
// Once the work has STARTED neither applies: the work finishes (a commit past its claim
// runs to its record).
//
// RULE: never await recovery from inside a commit (or a commit from inside recovery): each
// holds this lock while the other waits for it. A test hook that wants to run recovery
// mid-commit starts it and awaits it after the commit is over.

/** The lock did not come free within the time the caller was willing to wait. */
export class LockWaitTimeout extends Error {
  constructor() {
    super("the export folder is busy");
    this.name = "LockWaitTimeout";
  }
}

export interface RootLockOptions {
  /** A cancel while waiting rejects with the signal's reason and the work never runs. */
  readonly signal?: AbortSignal;
  /** Gives up waiting after this long (rejects with `LockWaitTimeout`); the work never runs. Unbounded when absent. */
  readonly waitMs?: number;
}

export async function withRootLock<T>(fs: Pick<CommitFs, "realpath">, root: string, work: () => Promise<T>, options: RootLockOptions = {}): Promise<T> {
  const real = await fs.realpath(root);
  let started = false;
  let abandoned = false;
  const key = `export-root:${placeOf(nodePath, real, true)}`;
  const running = runExclusive(key, async (): Promise<T> => {
    if (abandoned) throw new LockWaitTimeout(); // the caller left while it queued: nothing runs
    started = true;
    return work();
  });
  void running.catch(() => undefined); // an abandoned turn rejects unobserved
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<never>((_resolve, reject) => {
    const stop = (error: unknown): void => {
      if (started) return; // the work has begun: it finishes
      abandoned = true;
      reject(error);
    };
    if (options.signal !== undefined) {
      const { signal } = options;
      if (signal.aborted) stop(signal.reason);
      onAbort = () => stop(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.waitMs !== undefined) timer = setTimeout(() => stop(new LockWaitTimeout()), options.waitMs);
  });
  giveUp.catch(() => undefined); // a give-up after the work finished must not be an unhandled rejection
  try {
    return await Promise.race([running, giveUp]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
  }
}
