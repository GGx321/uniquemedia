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
// Contract of the steps towards the core: `ctx.update`, `ctx.raisePaidHold` and `ctx.clearPaidHold` are refused while the launch is paused or ended (nothing continues during «Пауза», A13);
// `ctx.finish()` is refused unless the launch is running or pausing; a paid hold leaves the launch `running` and free work goes on through it (A13).

/** The steps' timers (the bounded automatic continues, the busy wait, the composer's finish retry): injectable so a test owns the clock. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;
export interface StepTimers {
  set(run: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

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
  /**
   * S4.6b2: raises a paid hold, decided INSIDE the file's own write (compare-and-set on the fresh file, never on a copy read before an await). The hold is set when none stands, or when it
   * outranks the one that stands (`holdRank`: 0 a waiting hold, 1 credits / key / price / budget / a price list that stayed unavailable, 2 a network hold with no retry, 3 halt / internal), which it displaces. Among equals the first stays.
   * `won` says whether this hold is the one that stands now. Refused like `update` while the launch is paused or ended.
   */
  raisePaidHold(hold: PaidHold): Promise<{ won: boolean }>;
  /** S4.6b2: clears the hold only if it is still `expected` (the same hold, not one that replaced it meanwhile). True when it was cleared. */
  clearPaidHold(expected: PaidHold): Promise<boolean>;
  setFreeHold(hold: FreeHold | null): Promise<LaunchFile>;
  /** Appends a typed line to the launch's «Журнал». Never rejects: a log that cannot be written is told in the console and the launch goes on. */
  log(line: LogLine): Promise<void>;
  /**
   * Every video is done or dropped: the launch is done, its group is finished and its sum is final. Refused (rejects) while anything of the launch is in flight (`steps.inFlight()`
   * above 0), because the group is closed and the sum read at this moment. Runs in the core's queue. Behind the composer this is a VOTE (see stepsComposer.ts).
   */
  finish(): Promise<LaunchFile>;
  /** S4.6b1: an avatar whose scene sets could not all be read at open (its allocation counts as spent in full): it does no paid work, whatever its own set reads like. */
  isCut(avatarId: string): boolean;
  /** S4.6b1: the steps changed something the view shows (a set mirror) without writing the file: announce the launch again. */
  touch(): void;
}

/** What `autopilot.continueAfterReview` hands the steps (S4.6b1): the avatar's set as the owner reviewed it. */
export interface ContinueInput {
  avatarId: string;
  sceneSetId: string;
  revision: number;
}

/** The steps' answer to the owner's «Продолжить запуск»: whether the draw starts now, or the approval is only recorded (the launch is paused or pausing), and how many photos the frozen list holds. */
export interface ContinueOutcome {
  draw: "started" | "waits-for-resume";
  photos: number;
}

/** What the window shows of an avatar's scene set, kept by the paid steps in memory (never in the launch file): the view fills the avatar row's set mirrors from it. */
/** What the mirrors are built from: a scene set as the library lists it (`StoredSceneSet` satisfies it). */
export interface MirrorSource {
  sceneSetId: string;
  avatarId: string;
  revision: number;
  scenes: readonly { origin: string; removed: boolean; text: string | null }[];
  launchDraw?: { sceneIds: readonly number[]; slices: readonly { sceneIds: readonly number[] }[] } | undefined;
}

export interface AvatarMirror {
  sceneSetId: string;
  setRevision: number;
  scenes: number;
  scenesWithoutText: number;
  continuePhotos: number;
  slice: { index: number; total: number } | null;
  undrawnScenes: number;
  resumableSlots: number;
}

export interface LaunchSteps {
  begin(ctx: LaunchStepsContext): void;
  drain(): Promise<void>;
  release(ctx: LaunchStepsContext): Promise<void>;
  inFlight(): { requests: number; renders: number };
  /**
   * S4.6b1: the owner's «Продолжить запуск» for an avatar that waits in `awaiting-review`. The orchestrator has already checked the launch and the phase; the steps approve the set (the
   * frozen list: `SCENES_CHANGED` and `over-plan` come from there) and, while the launch runs, start the draw. Absent: the launch has no review step (the orchestrator answers `not-awaiting`).
   */
  continueAfterReview?(ctx: LaunchStepsContext, input: ContinueInput): Promise<ContinueOutcome>;
  /** The avatar's set mirrors for the view, or null when the steps know none (before the set was read in this process). Pure and synchronous. */
  mirror?(launchId: string, avatarId: string): AvatarMirror | null;
  /** S4.6b1: the sets a library open found for an unfinished launch, so the mirrors are there before «Продолжить». Synchronous. */
  restore?(launchId: string, sets: readonly MirrorSource[]): void;
  /** S4.6b1: the launch is done: release what it holds (unlink its sets, clear its mirrors). Idempotent. Not «Стоп»: nothing is dropped. */
  complete?(ctx: LaunchStepsContext): Promise<void>;
  /**
   * S4.6b1, the composer's finish gate: a PASSIVE voter answers whether it has nothing left to do for this launch (no worker, no live job, every avatar final). A part without it
   * is an ACTIVE voter and says so by calling `ctx.finish()` itself.
   */
  finishReady?(launchId: string): boolean;
  /** S4.6b1: the composer registers here; a passive voter calls it whenever its `finishReady` may have turned true. */
  onReadyChange?(listener: () => void): void;
  /**
   * S4.6b2, `host.power` `suspend`: the Mac is going to sleep. From this instant the context reports the launch as not running, so nothing new is sent; this is the part's chance to
   * soft-stop the jobs it has in flight (no new attempt leaves; an attempt already sent ends under the ordinary rules) and to hold its timers. Synchronous; never rejects.
   */
  suspend?(): void;
  /**
   * S4.6b2, `host.power` `resume`, for a launch that ran when the Mac slept: put right what the sleep interrupted (a waiting hold's timer, the passes), then go on. The context is running again. A part without it is begun
   * again (`begin` is idempotent for a running launch).
   */
  wake?(ctx: LaunchStepsContext): Promise<void>;
  /** S4.6b1: whether the part has live work for this avatar now (a worker, a job); the composer lets the free part finish an avatar (`montage` to `done`) only when it is idle. */
  active?(launchId: string, avatarId: string): boolean;
}

/** No work at all: a launch started with these stays in its first step. S4.6a's default, until S4.6b and S4.6c plug theirs in. */
export const IDLE_STEPS: LaunchSteps = {
  begin: () => undefined,
  drain: () => Promise.resolve(),
  release: () => Promise.resolve(),
  inFlight: () => ({ requests: 0, renders: 0 }),
};
