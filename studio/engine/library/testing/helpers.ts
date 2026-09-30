import { afterEach, beforeEach, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { tempDirFor, type TempDir } from "../../../testing/tempDir";
import { LibraryError, type LibraryErrorCode } from "../errors";

export * from "./sampleData";

/** A fresh temp dir per test, removed after it (`tempDirFor`, bun:test's hooks). Returns a getter because the
 *  path only exists once `beforeEach` has run; `.track(work)` makes the cleanup wait for a setup still writing. */
export function useTempDir(prefix = "studio-lib-"): TempDir {
  return tempDirFor({ beforeEach, afterEach }, prefix);
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

export async function expectLibraryError(promise: Promise<unknown>, code: LibraryErrorCode): Promise<LibraryError> {
  const error = await rejectionOf(promise);
  if (!(error instanceof LibraryError)) {
    throw new Error(`expected a LibraryError(${code}), got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

/** Names in `dir` that look like our atomic-write temp files. */
export async function tempFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
}
