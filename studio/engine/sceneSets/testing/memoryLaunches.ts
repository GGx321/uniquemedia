import type { Library } from "../../library";
import type { LaunchLookup } from "../launchRegistry";

// Test-only: the launch store S4.6a will back `LaunchLookup` with, in memory. A launch is unfinished from `add` until `finish` or `remove`.

export class MemoryLaunches implements LaunchLookup {
  readonly #unfinished = new Set<string>();

  add(launchId: string): this {
    this.#unfinished.add(launchId);
    return this;
  }

  /** The launch ended (done or stopped): its file is still there, but it is not unfinished. */
  finish(launchId: string): void {
    this.#unfinished.delete(launchId);
  }

  /** The launch's file was removed or is unreadable: the same answer as a finished one. */
  remove(launchId: string): void {
    this.#unfinished.delete(launchId);
  }

  isUnfinished(launchId: string): boolean {
    return this.#unfinished.has(launchId);
  }

  hasUnfinished(_library?: Library): boolean {
    return this.#unfinished.size > 0;
  }
}
