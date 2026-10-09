import type { Library } from "../library";

// S4.5a (plan §3.4): which scene sets and which runs belong to an unfinished batch launch.
//
// The registry is engine memory: `sceneSetId -> launchId` and `slice runId -> launchId`. It feeds the refusals of §4.7, the `launchId` marks of `runs.list`
// and `scenes.get`, and (S4.6) the launch's `Budget` group. It is rebuilt when a library opens, from the sets' own files, before any paid command can run;
// a slice's run is linked right after the set's write that names it and before its folder is made.
//
// THE UNLINKED RULE: every answer goes through `LaunchLookup`. A link whose launch is not a readable, unfinished launch is no link at all: a finished,
// stopped or removed launch can never lock an avatar. The links are never trusted on their own.

/**
 * What the launch store (S4.6a: `<library>/autopilot/<launchId>.json`) tells the registry. `isUnfinished` is true exactly when the launch's file is
 * readable and its status is not terminal (`done`, `stopped`); false for a launch that is finished, whose file was removed, or that cannot be read.
 */
export interface LaunchLookup {
  isUnfinished(launchId: string): boolean;
  /**
   * Whether any launch of THIS library is unfinished. The launch files live in the library (`<library>/autopilot/`), so the store can answer only once it is
   * handed the opened library; it may read the folder to do so (and cache what it read for `isUnfinished`). When none is, nothing is linked and the
   * library's set files are not read at open.
   */
  hasUnfinished(library: Library): boolean | Promise<boolean>;
}

/** No launch store yet: every link is unlinked, so every set and run behaves as the owner's own. */
export const NO_LAUNCHES: LaunchLookup = { isUnfinished: () => false, hasUnfinished: () => false };

export class LaunchRegistry {
  readonly #lookup: LaunchLookup;
  readonly #sets = new Map<string, string>();
  readonly #runs = new Map<string, string>();

  constructor(lookup: LaunchLookup) {
    this.#lookup = lookup;
  }

  linkSet(sceneSetId: string, launchId: string): void {
    this.#sets.set(sceneSetId, launchId);
  }

  linkRun(runId: string, launchId: string): void {
    this.#runs.set(runId, launchId);
  }

  unlinkSet(sceneSetId: string): void {
    this.#sets.delete(sceneSetId);
  }

  unlinkRun(runId: string): void {
    this.#runs.delete(runId);
  }

  /** The launch id as the refusals read it: itself while that launch is unfinished, otherwise nothing (the unlinked rule). */
  activeLaunch(launchId: string | undefined): string | undefined {
    return launchId !== undefined && this.#lookup.isUnfinished(launchId) ? launchId : undefined;
  }

  /** The unfinished launch the set belongs to, by what was linked in memory. A caller holding the set's file asks `activeLaunch(set.launchId)` instead. */
  launchOfSet(sceneSetId: string): string | undefined {
    return this.activeLaunch(this.#sets.get(sceneSetId));
  }

  /** The unfinished launch the run is a slice of. */
  launchOfRun(runId: string): string | undefined {
    return this.activeLaunch(this.#runs.get(runId));
  }

  /**
   * What a library's sets say: a set's `launchId`, and the run of each slice of its `launchDraw`. A set that cannot be read links nothing (its launch cannot
   * lock what is not shown); the walk never throws for one bad record. Read when the library is OPENED, so that adopting it as the live one is synchronous.
   */
  async scan(library: Library): Promise<LaunchLinks> {
    // With no unfinished launch every link would be unlinked anyway: read nothing (a plain library's open does exactly the reads it did before Stage 4).
    if (!(await this.#lookup.hasUnfinished(library))) return NO_LINKS;
    const sets = new Map<string, string>();
    const runs = new Map<string, string>();
    for (const avatar of library.listAvatars()) {
      const { sets: listed } = await library.sceneSets.list(avatar.id).catch(() => ({ sets: [] }));
      for (const set of listed) {
        if (set.launchId === undefined) continue;
        sets.set(set.sceneSetId, set.launchId);
        for (const slice of set.launchDraw?.slices ?? []) runs.set(slice.runId, set.launchId);
      }
    }
    return { sets, runs };
  }

  /** Replaces every link with a scan: the library just became the live one. */
  adopt(links: LaunchLinks): void {
    this.#sets.clear();
    this.#runs.clear();
    for (const [id, launchId] of links.sets) this.#sets.set(id, launchId);
    for (const [id, launchId] of links.runs) this.#runs.set(id, launchId);
  }

  async rebuild(library: Library): Promise<void> {
    this.adopt(await this.scan(library));
  }
}

/** The links of one library, as `LaunchRegistry.scan` read them. */
export interface LaunchLinks {
  sets: ReadonlyMap<string, string>;
  runs: ReadonlyMap<string, string>;
}

export const NO_LINKS: LaunchLinks = { sets: new Map(), runs: new Map() };
