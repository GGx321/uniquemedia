import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stall installed on `FileHandle.prototype.sync`. */
export interface FsyncStall {
  /** How many `sync` calls have been made since the stall was installed. */
  calls(): number;
  /** Whether the stalled call has been reached (and has finished waiting). */
  stalled(): boolean;
  /** `performance.now()` at the moment the stalled call stopped waiting, or `null` while it has not. */
  releasedAt(): number | null;
  /** Puts the original `sync` back. Call it in `finally`. */
  restore(): void;
}

/** A stall that waits to be armed: the first `sync` after `arm()` is the one that stalls. */
export interface ArmedFsyncStall extends FsyncStall {
  /** Synchronous. From this moment on, the next `sync` call waits. Calling it again after the stall has happened does nothing. */
  arm(): void;
}

async function patchSync(
  decide: (calls: number) => boolean,
  ms: number
): Promise<FsyncStall & { restore(): void }> {
  const probe = join(tmpdir(), `stall-fsync-probe-${process.pid}-${Date.now()}`);
  const handle = await open(probe, "w");
  const proto = Object.getPrototypeOf(handle) as { sync: (this: unknown) => Promise<void> };
  await handle.close();
  await rm(probe, { force: true });
  const original = proto.sync;
  let calls = 0;
  let stalled = false;
  let released: number | null = null;
  let taken = false;
  proto.sync = async function patched(this: unknown): Promise<void> {
    calls += 1;
    if (!taken && decide(calls)) {
      taken = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
      released = performance.now();
      stalled = true;
    }
    return original.call(this);
  };
  return {
    calls: () => calls,
    stalled: () => stalled,
    releasedAt: () => released,
    restore: () => {
      proto.sync = original;
    },
  };
}

/**
 * Test support: makes the `nth` (1-based) `FileHandle.prototype.sync` call after this one wait `ms` milliseconds before it syncs, the way a
 * runner's disk sometimes stalls one fsync for seconds. Every other call goes straight through. It exists to show that a test waits on the code's
 * events and not on a wall clock: a wait with a real-time deadline fails under the stall, a wait on events passes.
 *
 * The number of syncs a code path makes differs by platform (the folder flush is skipped on Windows), so a fixed `nth` only suits a path whose
 * count does not depend on it; for anything else use `stallNextFsync`.
 *
 * The prototype is process-global; the caller must `restore()` in `finally`, and must not run two stalls at once.
 */
export async function stallNthFsync(options: { nth: number; ms: number }): Promise<FsyncStall> {
  if (!Number.isInteger(options.nth) || options.nth < 1) throw new Error(`stallNthFsync: nth must be a positive integer, got ${options.nth}`);
  return patchSync((calls) => calls === options.nth, options.ms);
}

/**
 * Test support: like `stallNthFsync`, but the stalled call is the first `sync` after `arm()`, whatever its ordinal. The test arms it at a point
 * it knows is just before the path it cares about, so the stall lands on that path on every platform, whatever else syncs earlier.
 *
 * The prototype is process-global; the caller must `restore()` in `finally`, and must not run two stalls at once.
 */
export async function stallNextFsync(options: { ms: number }): Promise<ArmedFsyncStall> {
  if (!Number.isFinite(options.ms) || options.ms < 0) throw new Error(`stallNextFsync: ms must be a non-negative number, got ${options.ms}`);
  let armed = false;
  const stall = await patchSync(() => armed, options.ms);
  return {
    ...stall,
    arm: () => {
      armed = true;
    },
  };
}
