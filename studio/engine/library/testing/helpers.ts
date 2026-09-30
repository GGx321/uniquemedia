import { afterEach, beforeEach, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryError, type LibraryErrorCode } from "../errors";

export * from "./sampleData";

/** A fresh temp dir per test, removed after it. Returns a getter because the
 *  path only exists once `beforeEach` has run. */
export function useTempDir(prefix = "studio-lib-"): () => string {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
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
