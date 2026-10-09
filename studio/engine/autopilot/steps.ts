import type { FreeHold, LogLine, PaidHold } from "../../shared/engine/autopilot";
import type { LaunchRegistry } from "../sceneSets/launchRegistry";
import type { LaunchGroups } from "./groups";
import type { LaunchFile } from "./launchFile";

// Stage 4 (plan §3.2, §3.6): THE SEAM between the orchestrator core (S4.6a: the launch file, the state machine, the commands, the events) and the work a launch does.
//
// The core knows nothing of composing scenes, drawing slices, assigning photos or rendering. Those are STEPS, plugged in through `LaunchSteps`:
//   - S4.6b1/b2 plug in the paid path (compose, the review wait, the approval, the slices, the automatic continues, the holds);
//   - S4.6c1/c2 plug in the free path (photo assignment, specs, focus prefetch, renders, music).
// A step reads the launch through `file()`, writes it through `update()` (whole-file, atomic, revision + 1: the core announces the change), and tells the core of a hold, a
// log line, or the end through the context. It starts nothing while `isRunning()` is false, and it never aborts a request: the soft stop is `drain()`.
//
// Contract of the core towards the steps:
//   - `begin(ctx)` is called after `autopilot.start` has written the launch file and registered the launch's `Budget` group, and after every accepted
//     `autopilot.resume` (also the one that clears a hold). It is NOT called after a restart until «Продолжить» (invariant A5). It returns at once; the work runs on and
//     reports through `ctx`. It is called with a fresh context each time; a context of an earlier call stays valid for the same launch.
//   - `drain()` is the soft stop of «Пауза» and «Стоп»: from the moment it is called nothing new starts, and the promise resolves when nothing of the launch is in flight (no
//     request, no running render). It never rejects and never aborts.
//   - `release(ctx)` follows `drain()` on «Стоп» (and on a restart that finds the launch `stopping`): it releases what the launch holds (unlinks its scene sets, drops what
//     is not done). Idempotent: a crash can repeat it.
//   - `inFlight()` counts what a drain would wait for now.
// Contract of the steps towards the core: `ctx.update` and `ctx.setPaidHold` are refused while the launch is paused or ended (nothing continues during «Пауза», A13);
// `ctx.finish()` is refused unless the launch is running or pausing; a paid hold leaves the launch `running` and free work goes on through it (A13).

export interface LaunchStepsContext {
  readonly launchId: string;
  /** The launch's sets and slice runs, and its `Budget` group: for the steps that link a set, add a slice run or finish the group. */
  readonly registry: LaunchRegistry;
  readonly groups: LaunchGroups;
  /** The launch file as it stands after the last write. */
  file(): LaunchFile;
  /** True exactly while the launch runs: not paused, pausing, stopping or ended. A step checks it before it starts anything. */
  isRunning(): boolean;
  /** A whole-file rewrite under the store's queue: `change` gets the file as it is on disk and returns the next one (null: no change). */
  update(change: (file: LaunchFile) => LaunchFile | null): Promise<LaunchFile>;
  /** Sets or clears the paid hold (and logs it). Free work goes on. */
  setPaidHold(hold: PaidHold | null): Promise<LaunchFile>;
  setFreeHold(hold: FreeHold | null): Promise<LaunchFile>;
  /** Appends a typed line to the launch's «Журнал». Never rejects: a log that cannot be written is told in the console and the launch goes on. */
  log(line: LogLine): Promise<void>;
  /** Every video is done or dropped: the launch is done, its group is finished and its sum is final. */
  finish(): Promise<LaunchFile>;
}

export interface LaunchSteps {
  begin(ctx: LaunchStepsContext): void;
  drain(): Promise<void>;
  release(ctx: LaunchStepsContext): Promise<void>;
  inFlight(): { requests: number; renders: number };
}

/** No work at all: a launch started with these stays in its first step. S4.6a's default, until S4.6b and S4.6c plug theirs in. */
export const IDLE_STEPS: LaunchSteps = {
  begin: () => undefined,
  drain: () => Promise.resolve(),
  release: () => Promise.resolve(),
  inFlight: () => ({ requests: 0, renders: 0 }),
};
