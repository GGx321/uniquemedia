import type { Library } from "../library";
import type { LaunchLookup } from "../sceneSets/launchRegistry";
import { LaunchStore, type LaunchStoreDeps } from "./launchStore";

// Stage 4 (plan §3.4, §19): the store-backed `LaunchLookup` the scene registry asks.
//
//  - LIBRARY-BOUND. The launch files live in the library, so `hasUnfinished(library)` reads THAT library's folder; it is called for a STAGED folder before it is live.
//  - CACHED PER LIBRARY. Each library has its own store and index. `isUnfinished(launchId)` reads the index of the LIVE library only (`adopt`), so a staged open can never
//    overwrite what the live library's refusals read.
//  - NEVER THROWS, FAILS CLOSED. A folder that cannot be listed, a file that cannot be read, or a scan that fails counts as an unfinished launch: it may describe an active one.

export interface LaunchStoresDeps extends LaunchStoreDeps {
  /** Test seam: makes the store of a folder. */
  makeStore?: (root: string) => LaunchStore;
}

export class LaunchStores implements LaunchLookup {
  readonly #deps: LaunchStoresDeps;
  readonly #stores = new Map<string, LaunchStore>();
  #live: LaunchStore | null = null;

  constructor(deps: LaunchStoresDeps = {}) {
    this.#deps = deps;
  }

  /** The one store of a library's folder: its writes and its index are shared by everything that asks. */
  storeOf(library: Pick<Library, "root">): LaunchStore {
    const known = this.#stores.get(library.root);
    if (known !== undefined) return known;
    const { makeStore, ...storeDeps } = this.#deps;
    const made = makeStore === undefined ? new LaunchStore(library.root, storeDeps) : makeStore(library.root);
    this.#stores.set(library.root, made);
    return made;
  }

  /** The library that is live now (or none): the one `isUnfinished` answers for. */
  adopt(library: Pick<Library, "root"> | null): void {
    this.#live = library === null ? null : this.storeOf(library);
  }

  isUnfinished(launchId: string): boolean {
    try {
      return this.#live?.isUnfinished(launchId) ?? false;
    } catch {
      return true;
    }
  }

  async hasUnfinished(library: Pick<Library, "root">): Promise<boolean> {
    try {
      const store = this.storeOf(library);
      await store.scan();
      return store.hasUnfinishedOrUnreadable();
    } catch {
      return true;
    }
  }
}
