import * as nodePath from "node:path";
import { placeOf } from "../exportName";

// The renders running right now, seen by the recovery that runs when a library
// opens. Recovery must not take a live job's temp or claimed placeholder for a
// crash's leftovers, nor settle a live job's intent. Paths are compared as PLACES
// (`placeOf`: normalised, and letter case folded), never as strings, and always
// folded: on a case-sensitive volume that only makes recovery more careful.

/** What recovery asks of the running jobs. */
export interface LiveCommits {
  hasTemp(path: string): boolean;
  hasPlaceholder(path: string): boolean;
  hasJob(jobId: string): boolean;
}

const keyOf = (path: string): string => placeOf(nodePath, nodePath.resolve(path), true);

export class CommitTracker implements LiveCommits {
  readonly #temps = new Set<string>();
  readonly #placeholders = new Set<string>();
  readonly #jobs = new Map<string, string>();

  /** A LIVE view (not a copy): it follows every later add and release. Keys are places, so use `hasTemp` to ask. */
  tempPaths(): ReadonlySet<string> {
    return this.#temps;
  }

  /** A live view of the claimed placeholders; see `tempPaths`. */
  placeholderPaths(): ReadonlySet<string> {
    return this.#placeholders;
  }

  /** A live view of the running jobs' ids. */
  liveJobIds(): ReadonlySet<string> {
    return new Set(this.#jobs.keys());
  }

  liveVideoIds(): ReadonlySet<string> {
    return new Set(this.#jobs.values());
  }

  hasTemp(path: string): boolean {
    return this.#temps.has(keyOf(path));
  }

  hasPlaceholder(path: string): boolean {
    return this.#placeholders.has(keyOf(path));
  }

  hasJob(jobId: string): boolean {
    return this.#jobs.has(jobId);
  }

  addJob(jobId: string, videoId: string): void {
    this.#jobs.set(jobId, videoId);
  }

  releaseJob(jobId: string): void {
    this.#jobs.delete(jobId);
  }

  addTemp(path: string): void {
    this.#temps.add(keyOf(path));
  }

  addPlaceholder(path: string): void {
    this.#placeholders.add(keyOf(path));
  }

  release(...paths: string[]): void {
    for (const path of paths) {
      this.#temps.delete(keyOf(path));
      this.#placeholders.delete(keyOf(path));
    }
  }
}
