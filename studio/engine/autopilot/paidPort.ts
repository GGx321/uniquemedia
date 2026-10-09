import type { BudgetHoldDetail, MonthRoom } from "../../shared/autopilot/money";
import type { Estimate } from "../../shared/engine";
import type { CategoryRef } from "../../shared/engine/categories";
import type { StoredSceneSet } from "../library/sceneSets";
import type { Budget } from "../money/budget";
import type { RunJobEnd } from "../runs/runJob";
import type { DrawSliceResult, SliceStatus, UnlinkPhase } from "../sceneSets/launchDraw";
import type { LaunchComposeOptions } from "../sceneSets/service";
import type { LiveScope } from "./room";

// Stage 4, S4.6b1 (plan §3.4, §3.6): what the paid steps need of the engine. The engine satisfies it structurally (its engine-internal launch methods); a test hands the steps a double.
// Nothing here is a command: every method is internal, and every paid one is a call the launch's acceptance covers (the click at `autopilot.start`).

/** The detail every refusal of a launch that cannot pay now starts with (VALIDATION): the steps leave such a launch quietly, they do not read it as «avatar busy». */
export const NOT_PAYABLE_DETAIL = "the launch is not payable now";

/** The payload of a compose, as the engine's `scenes.compose` takes it. */
export interface LaunchComposePayload {
  avatarId: string;
  count: number;
  categories: readonly CategoryRef[];
  poses: { profile: boolean; back: boolean };
  acceptedWorstMicros: number;
}

/** A slice run's job: started (or resumed inside its cap), with the promise of its end; or `finished` when every slot has already ended or its cap cannot fund another attempt. */
export type LaunchSliceStart = { kind: "started"; jobId: string; ended: Promise<RunJobEnd> } | { kind: "finished" };

/** What the paid steps read of the open library: the avatar's scene sets. `Library` satisfies it. */
export interface PaidLibrary {
  readonly sceneSets: {
    get(avatarId: string, sceneSetId: string): Promise<StoredSceneSet | null>;
    list(avatarId: string): Promise<{ sets: readonly StoredSceneSet[]; unreadable: number }>;
  };
}

/** How a slice's slots ended (S4.6b2, the failure-rate guard): the slice's slots, and those that closed failed by a QA gate or by moderation: never by the cap, the month, or a request that got no answer. */
export interface SliceOutcome {
  slots: number;
  checkFailures: number;
}

export interface PaidPort {
  /** The open library, or null. */
  readonly library: PaidLibrary | null;
  /** The one Budget over the ledger, or null when the ledger could not be read. */
  readonly budget: Budget | null;

  /** A compose under the launch's ids and exact split (`Engine.composeLaunchSet`). Made again after a crash it creates nothing and sends nothing (`jobId` null). */
  composeLaunchSet(payload: LaunchComposePayload, launch: LaunchComposeOptions): Promise<{ sceneSetId: string; jobId: string | null }>;
  /** What composing `count` scenes could cost now (free). */
  composeEstimate(request: { avatarId: string; count: number; categories: readonly CategoryRef[] }): Promise<Estimate>;
  /** The launch's own «Дописать» of the set (internal): the scenes still waiting, within `acceptedWorstMicros` (PRICE_CHANGED above it). */
  writeLaunchScenes(input: { sceneSetId: string; launchId: string; revision: number; acceptedWorstMicros: number }): Promise<{ jobId: string }>;
  /** What the «Дописать» of the set could cost now (free). */
  writeEstimate(sceneSetId: string): Promise<Estimate>;
  /** The launch approval (plan §3.4): freezes the scenes with text. */
  approveLaunchSet(input: { sceneSetId: string; launchId: string; revision: number; plannedCount: number }): Promise<StoredSceneSet>;
  /** Draws the launch's next slice entry and makes its run folder; never starts its job (`Engine.drawLaunchSlice`). */
  drawLaunchSlice(input: { sceneSetId: string; launchId: string; size: number; drawMicros: number }): Promise<DrawSliceResult>;
  /** Starts the slice run's job, or resumes it, inside its own cap and without a click of its own: the launch accepted it (internal). */
  startLaunchSlice(runId: string): Promise<LaunchSliceStart>;
  /** Which of the set's slices have a run, and whether each is finished (every slot closed) with what it committed. */
  sliceStatuses(set: StoredSceneSet): Promise<Map<string, SliceStatus>>;
  /** One photo's worst case at today's prices, for the avatars' models (not the text model's price: a library-only launch never reads it). */
  photoWorstMicros(): Promise<number>;
  /** The month's room with live caps; `extraLive` the launch's resumable slices. Null when the ledger cannot be read. */
  monthRoom(extraLive?: readonly LiveScope[]): MonthRoom | null;
  /** The `resume-slice` budget hold of a slice run. */
  resumeSliceHold(runId: string, extraLive?: readonly LiveScope[]): Promise<BudgetHoldDetail>;

  /** The single admission rule (A19) as an automatic continue applies it: true while `Budget.blocked()` is null (no reserve of a previous process, no torn line, no halt). An open reserve of this session never blocks it. */
  admitted(): boolean;
  /** How the slice run's slots ended, or null when its journal cannot be read. */
  sliceOutcome(runId: string): Promise<SliceOutcome | null>;

  /** The soft stop of a scenes job / a run job; false when there is none (and no start under way). */
  softStopScenes(sceneSetId: string): boolean;
  softStopRun(runId: string): boolean;
  /** Resolves when no job of the set runs and its end has been announced. */
  whenSceneSetIdle(sceneSetId: string): Promise<void>;
  /** Called with every scene set the engine announces (an owner's edit, a job's end, an approval); returns the way to stop. The paid steps keep the launch sets' mirrors from it. */
  onSetChanged?(listener: (set: StoredSceneSet) => void): () => void;
  /** Releases the set from its launch by the phase it is in. */
  unlinkLaunchSet(sceneSetId: string): Promise<{ phase: UnlinkPhase }>;
}
