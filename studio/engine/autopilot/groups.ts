import type { AttemptGroup } from "../money/budget";
import type { Scope } from "../money/ledger";

// Stage 4 (plan §4.10, invariant A2): which attempts belong to a launch's `Budget` group. The engine's `groupOf` reads this registry. The orchestrator (S4.6)
// registers a launch BEFORE its first reserve, adds each slice run and each set before the call that uses it, and restores the registry from the launch files
// when the library opens, before any paid command can run. The ledger is not touched: membership is derived from the attempt ids and scopes already on every
// `reserve` line, so the group of an old line is found again by the same rule.

export interface LaunchGroupSpec {
  launchId: string;
  /** W′: the most the launch's attempts may commit together, over all its scopes. */
  capMicros: number;
  /** The launch's scene sets: their writer attempts (`<setId>:writer-<n>#k`, the compose and the launch's own «Дописать») are in the group. */
  setIds: readonly string[];
  /** The launch's slice runs: every attempt in their scope is in the group. */
  runIds: readonly string[];
}

interface Entry {
  key: string;
  capMicros: number;
  setIds: Set<string>;
  runIds: Set<string>;
}

/** Marks a writer attempt of a scene set: `<setId>:writer-<chunk>#<n>`. Review writes are `<setId>:write-<k>#<n>` and never match. */
const WRITER_MARK = ":writer-";

export function launchGroupKey(launchId: string): string {
  return `launch:${launchId}`;
}

export class LaunchGroups {
  readonly #launches = new Map<string, Entry>();
  readonly #bySet = new Map<string, Entry>();
  readonly #byRun = new Map<string, Entry>();

  /** Registers a launch, replacing any earlier registration of the same id. */
  register(spec: LaunchGroupSpec): void {
    if (!Number.isSafeInteger(spec.capMicros) || spec.capMicros < 0) throw new TypeError(`a group cap must be a non-negative whole number of micro-dollars, got ${spec.capMicros}`);
    this.finish(spec.launchId);
    const entry: Entry = { key: launchGroupKey(spec.launchId), capMicros: spec.capMicros, setIds: new Set(spec.setIds), runIds: new Set(spec.runIds) };
    this.#launches.set(spec.launchId, entry);
    for (const setId of entry.setIds) this.#bySet.set(setId, entry);
    for (const runId of entry.runIds) this.#byRun.set(runId, entry);
  }

  addSet(launchId: string, setId: string): void {
    const entry = this.#entry(launchId);
    entry.setIds.add(setId);
    this.#bySet.set(setId, entry);
  }

  addRun(launchId: string, runId: string): void {
    const entry = this.#entry(launchId);
    entry.runIds.add(runId);
    this.#byRun.set(runId, entry);
  }

  /**
   * The launch is over: its attempts map to no group any more, so its old ledger lines limit nothing. Harmless for an unknown launch. Call it only after EVERY
   * job of the launch has ended (a compose, a «Дописать», a slice run): a job still running would reserve outside the group from then on.
   */
  finish(launchId: string): void {
    const entry = this.#launches.get(launchId);
    if (entry === undefined) return;
    for (const setId of entry.setIds) if (this.#bySet.get(setId) === entry) this.#bySet.delete(setId);
    for (const runId of entry.runIds) if (this.#byRun.get(runId) === entry) this.#byRun.delete(runId);
    this.#launches.delete(launchId);
  }

  /**
   * Replaces the registry with the launch files' (at library open): every unfinished launch is registered, a finished one maps nothing. The spec's `runIds` must
   * hold every slice run of the launch, including the ones the sets record in their `launchDraw.slices` (plan §3.4), not only those the launch file lists: a
   * slice run left out would reserve outside the group.
   */
  restore(specs: readonly (LaunchGroupSpec & { finished: boolean })[]): void {
    for (const launchId of [...this.#launches.keys()]) this.finish(launchId);
    for (const spec of specs) if (!spec.finished) this.register(spec);
  }

  /** The `Budget`'s `groupOf`. */
  groupOf(req: { attemptId: string; scope: Scope }): AttemptGroup | null {
    const mark = req.attemptId.indexOf(WRITER_MARK);
    if (mark > 0) {
      const set = this.#bySet.get(req.attemptId.slice(0, mark));
      if (set !== undefined) return { key: set.key, capMicros: set.capMicros };
    }
    if ("runId" in req.scope) {
      const run = this.#byRun.get(req.scope.runId);
      if (run !== undefined) return { key: run.key, capMicros: run.capMicros };
    }
    return null;
  }

  #entry(launchId: string): Entry {
    const entry = this.#launches.get(launchId);
    if (entry === undefined) throw new Error(`launch ${launchId} is not registered: register it before its first reserve`);
    return entry;
  }
}
