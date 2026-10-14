import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stall installed on `FileHandle.prototype.sync`. */
export interface FsyncStall {
  /** How many `sync` calls have been made since the stall was installed. */
  calls(): number;
  /** Whether the stalled call has been reached (and has finished waiting). */
  stalled(): boolean;
  /** Puts the original `sync` back. Call it in `finally`. */
  restore(): void;
}

/**
 * Test support: makes the `nth` (1-based) `FileHandle.prototype.sync` call after this one wait `ms` milliseconds before it syncs, the way a
 * runner's disk sometimes stalls one fsync for seconds. Every other call goes straight through. It exists to show that a test waits on the code's
 * events and not on a wall clock: a wait with a real-time deadline fails under the stall, a wait on events passes.
 *
 * The prototype is process-global; the caller must `restore()` in `finally`, and must not run two stalls at once.
 */
export async function stallNthFsync(options: { nth: number; ms: number }): Promise<FsyncStall> {
  if (!Number.isInteger(options.nth) || options.nth < 1) throw new Error(`stallNthFsync: nth must be a positive integer, got ${options.nth}`);
  const probe = join(tmpdir(), `stall-fsync-probe-${process.pid}-${Date.now()}`);
  const handle = await open(probe, "w");
  const proto = Object.getPrototypeOf(handle) as { sync: (this: unknown) => Promise<void> };
  await handle.close();
  await rm(probe, { force: true });
  const original = proto.sync;
  let calls = 0;
  let stalled = false;
  proto.sync = async function patched(this: unknown): Promise<void> {
    calls += 1;
    if (calls === options.nth) {
      await new Promise((resolve) => setTimeout(resolve, options.ms));
      stalled = true;
    }
    return original.call(this);
  };
  return {
    calls: () => calls,
    stalled: () => stalled,
    restore: () => {
      proto.sync = original;
    },
  };
}
