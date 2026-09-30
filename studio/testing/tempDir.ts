import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The two hooks a test runner gives: `bun:test` and `node:test` both fit, so one helper serves both runners. */
export interface TempDirHooks {
  beforeEach(run: () => Promise<void>): unknown;
  afterEach(run: () => Promise<void>): unknown;
}

/** A getter for the current test's directory, and `track` for work that writes into it and may outlive the test. */
export interface TempDir {
  (): string;
  /**
   * Registers `work` (a setup that is still writing, say) so the cleanup waits for it to settle before it removes the
   * folder: a test that timed out mid-setup must not have its folder pulled out from under the setup (ENOENT after teardown).
   * Returns `work` itself, so a call site reads as before.
   */
  track<T>(work: Promise<T>): Promise<T>;
}

/**
 * A fresh temp folder per test, removed after it (the path exists only once `beforeEach` has run, hence the getter).
 * Removal retries a locked entry a few times (Windows: Defender or the indexer briefly holds a just-written file, EBUSY
 * or EPERM), so a cleanup does not fail a test that passed.
 */
export function tempDirFor(hooks: TempDirHooks, prefix: string): TempDir {
  let dir = "";
  let tracked: Promise<unknown>[] = [];
  hooks.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix));
  });
  hooks.afterEach(async () => {
    const pending = tracked;
    tracked = [];
    await Promise.allSettled(pending);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const current = (): string => dir;
  return Object.assign(current, {
    track: <T>(work: Promise<T>): Promise<T> => {
      tracked.push(work);
      return work;
    },
  });
}
