import { LAUNCH_SLICE_MAX_PHOTOS, MAX_COMPOSE_SCENES } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import { LibraryError, type Library } from "../library";
import { SceneSetError, withSceneSetLock, type StoredSceneSet } from "../library/sceneSets";
import type { RunPlan } from "../runs/plan";
import { RunPlanSchema } from "../runs/plan";
import { sentenceProblems } from "../scenes";
import { findSceneSet } from "./approve";
import type { LaunchRegistry } from "./launchRegistry";
import { sceneRefusal } from "./refusal";

// S4.5a (plan §3.4, §3.7, §4.3, §4.7): the launch's life on a scene set's FILE. Three steps, each under the set's own mutex, each recorded in the set before
// anything is created from it, so a kill at any point leaves a file the next call reads and finishes:
//  - `approveLaunchSet` freezes the ordered list of scenes the launch will draw (`launchDraw.sceneIds`); the set is read-only from then on.
//  - `drawLaunchSlice` appends one slice entry `{ runId, sceneIds, capMicros }` and only THEN makes the run folder (`ensureSliceRuns`). The first slice uses
//    the set's pre-issued run id, so "used" (that run's folder exists) keeps its meaning. A second call finds the entry without a folder and makes the same run.
//  - `unlinkLaunchSet` releases the set when the launch stops, by the phase the set is in.
// Money is the caller's: it passes the draw allocation, a price per size and what each earlier slice settled at. Nothing here reserves, holds or starts a job.

export interface LaunchSetDeps {
  library: Library;
  /** Whether a job of the set runs (or is about to). */
  isLive: (sceneSetId: string) => boolean;
  /** Told of each slice's run before its folder is made, and of every link a stop removes. Absent: nothing is told. */
  registry?: LaunchRegistry | undefined;
}

export interface SliceEntry {
  runId: string;
  sceneIds: number[];
  capMicros: number;
}

/** What the caller knows of a slice that has a run: live (it runs, or can be resumed) or finished (every slot closed) and what it committed. */
export type SliceStatus = { finished: false } | { finished: true; committedMicros: number };

export interface DrawSliceInput {
  sceneSetId: string;
  launchId: string;
  /** How many photos to draw, 1..25; fewer when fewer scenes are left or the room is short. */
  size: number;
  /** The avatar's draw allocation (plan §4.3): the sum of finished slices' committed and live slices' caps stays within it. */
  drawMicros: number;
  /** The worst case of a slice of `n` photos at today's prices; non-decreasing in `n`. */
  capFor: (size: number) => number;
  statusOf: (runId: string) => SliceStatus;
  /** Issues a run id for a slice after the first. */
  newId: () => string;
  /** The run's plan for a slice, made from the set as it is now. */
  build: (current: StoredSceneSet, slice: SliceEntry) => RunPlan;
}

export type DrawSliceResult = ({ kind: "drawn"; created: boolean } & SliceEntry) | { kind: "none-left" } | { kind: "no-room"; leftMicros: number };

const textlessActive = (set: StoredSceneSet): number[] => set.scenes.flatMap((s) => (s.origin === "planned" && !s.removed && s.text === null ? [s.sceneId] : []));

/**
 * Under the set's mutex: removes the active planned scenes that have no text, then freezes the rest, in the set's order, into `launchDraw`. Own scenes are
 * never part of M and never drawn (§4.7). `plannedCount` is n, the photos the launch planned for the avatar: M above it is `over-plan` (adding scenes can never
 * raise the launch's spend). The set must name this launch (else `not-awaiting`), be at `revision`, and have no job running. Approving again changes nothing.
 */
export async function approveLaunchSet(deps: LaunchSetDeps, input: { sceneSetId: string; launchId: string; revision: number; plannedCount: number }): Promise<StoredSceneSet> {
  const { library } = deps;
  const { sceneSetId, launchId } = input;
  refuseUnlinked(deps, sceneSetId, launchId);
  const { avatarId } = await findSceneSet(library, sceneSetId);
  try {
    return await library.sceneSets.update(
      avatarId,
      sceneSetId,
      (current) => {
        if (current.launchId !== launchId) throw sceneRefusal(`scene set ${sceneSetId} is not waiting for launch ${launchId}`, "not-awaiting");
        if (current.launchDraw !== undefined) return null;
        if (current.revision !== input.revision) throw new EngineFailure({ code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} is at revision ${current.revision}, not ${input.revision}` });
        const dropped = new Set(textlessActive(current));
        const scenes = current.scenes.map((s) => (dropped.has(s.sceneId) ? { ...s, removed: true } : s));
        const drawn = scenes.filter((s) => s.origin === "planned" && !s.removed);
        if (drawn.length === 0) throw sceneRefusal(`scene set ${sceneSetId} has no scene with text to draw`, "no-active-scenes");
        if (drawn.length > input.plannedCount) {
          throw sceneRefusal(`scene set ${sceneSetId} has ${drawn.length} scenes to draw; the launch planned ${input.plannedCount}`, "over-plan");
        }
        if (drawn.length > MAX_COMPOSE_SCENES) throw sceneRefusal(`scene set ${sceneSetId} has ${drawn.length} active scenes; a launch draws at most ${MAX_COMPOSE_SCENES}`, "too-many-active");
        const unfit = drawn.find((s) => s.text !== null && sentenceProblems(s.text).length > 0);
        if (unfit !== undefined) throw sceneRefusal(`the text of scene ${unfit.sceneId} of set ${sceneSetId} breaks today's word rules: edit or remove it first`, "scene-text-problem", unfit.sceneId);
        return { ...current, scenes, launchDraw: { launchId, sceneIds: drawn.map((s) => s.sceneId), slices: [] } };
      },
      {
        guard: async (current) => {
          if (deps.isLive(sceneSetId)) throw new EngineFailure({ code: "IN_FLIGHT", detail: `scene set ${sceneSetId} is being written; wait for that to end (or cancel it)` });
          if (current.launchDraw === undefined && (await library.runFolderExists(current.runId))) throw sceneRefusal(`scene set ${sceneSetId} is used by run ${current.runId} and is read-only`, "set-used");
        },
      },
    );
  } catch (error) {
    throw asEngineError(error);
  }
}

/** The unlinked rule (plan §3.4): a launch that is not readable and unfinished approves and draws nothing, so a finished or removed launch can never move a set. */
function refuseUnlinked(deps: LaunchSetDeps, sceneSetId: string, launchId: string): void {
  if (deps.registry !== undefined && deps.registry.activeLaunch(launchId) === undefined) throw sceneRefusal(`launch ${launchId} is not unfinished; scene set ${sceneSetId} is not waiting for it`, "not-awaiting");
}

/** A store's own refusal as the engine's; anything else as it was. */
function asEngineError(error: unknown): unknown {
  if (error instanceof SceneSetError) {
    if (error.code === "stale") return new EngineFailure({ code: "SCENES_CHANGED", detail: error.message });
    if (error.code === "not-found") return new EngineFailure({ code: "NOT_FOUND", detail: error.message });
    return new EngineFailure({ code: "INTERNAL", detail: error.message });
  }
  return error;
}

/**
 * Draws the launch's next slice: appends its entry to the set (under the set's mutex), links its run, makes the run folder. A slice never exceeds 25 photos
 * (RangeError above) and never the room the draw allocation has left: `drawMicros` minus what finished slices committed minus the caps of the live ones; a
 * price rise shrinks it, down to `no-room`. An entry left without a folder by a crash is finished first, with the SAME run id and scenes: its cap is
 * recomputed at today's prices and never raised, and scenes it can no longer afford go back to the undrawn list. `none-left` when the frozen list is drawn.
 */
export async function drawLaunchSlice(deps: LaunchSetDeps, input: DrawSliceInput): Promise<DrawSliceResult> {
  const { library, registry } = deps;
  const { sceneSetId, launchId } = input;
  refuseUnlinked(deps, sceneSetId, launchId);
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > LAUNCH_SLICE_MAX_PHOTOS) throw new RangeError(`a slice holds 1..${LAUNCH_SLICE_MAX_PHOTOS} photos, not ${input.size}`);
  const { avatarId } = await findSceneSet(library, sceneSetId);
  const folders = new Map<string, boolean>();
  let result: DrawSliceResult | null = null;
  try {
    await library.sceneSets.update(
      avatarId,
      sceneSetId,
      (current) => {
        const draw = current.launchDraw;
        if (current.launchId !== launchId || draw === undefined || draw.launchId !== launchId) throw sceneRefusal(`scene set ${sceneSetId} is not approved by launch ${launchId}`, "not-awaiting");
        let room = input.drawMicros;
        for (const entry of draw.slices) {
          if (folders.get(entry.runId) !== true) continue;
          const status = input.statusOf(entry.runId);
          room -= status.finished ? status.committedMicros : entry.capMicros;
        }
        const pending = draw.slices.find((entry) => folders.get(entry.runId) !== true);
        const largestFit = (most: number, limit: number): number => {
          for (let s = most; s >= 1; s--) if (input.capFor(s) <= limit) return s;
          return 0;
        };
        if (pending !== undefined) {
          const fit = largestFit(pending.sceneIds.length, Math.min(room, pending.capMicros));
          if (fit === 0) {
            result = { kind: "no-room", leftMicros: Math.max(0, room) };
            return null;
          }
          const entry: SliceEntry = { runId: pending.runId, sceneIds: pending.sceneIds.slice(0, fit), capMicros: input.capFor(fit) };
          result = { kind: "drawn", created: false, ...entry };
          if (entry.sceneIds.length === pending.sceneIds.length && entry.capMicros === pending.capMicros) return null;
          return { ...current, launchDraw: { ...draw, slices: draw.slices.map((e) => (e.runId === pending.runId ? entry : e)) } };
        }
        const taken = new Set(draw.slices.flatMap((e) => e.sceneIds));
        const undrawn = draw.sceneIds.filter((id) => !taken.has(id));
        if (undrawn.length === 0) {
          result = { kind: "none-left" };
          return null;
        }
        const fit = largestFit(Math.min(input.size, undrawn.length), room);
        if (fit === 0) {
          result = { kind: "no-room", leftMicros: Math.max(0, room) };
          return null;
        }
        const entry: SliceEntry = { runId: draw.slices.length === 0 ? current.runId : input.newId(), sceneIds: undrawn.slice(0, fit), capMicros: input.capFor(fit) };
        result = { kind: "drawn", created: false, ...entry };
        return { ...current, launchDraw: { ...draw, slices: [...draw.slices, entry] } };
      },
      {
        guard: async (current) => {
          for (const entry of current.launchDraw?.slices ?? []) folders.set(entry.runId, await library.runFolderExists(entry.runId));
        },
      },
    );
  } catch (error) {
    throw asEngineError(error);
  }
  const decided = result as DrawSliceResult | null;
  if (decided === null) throw new Error("the slice was neither drawn nor refused");
  if (decided.kind !== "drawn") return decided;
  // The entry is in the set; its run is linked now, before its folder exists, so a refusal can never miss a run that is about to be.
  registry?.linkRun(decided.runId, launchId);
  const made = await ensureSliceRuns(deps, { sceneSetId, launchId, build: input.build });
  return { ...decided, created: made.created.includes(decided.runId) };
}

/**
 * Makes the run folder of every slice entry that has none, under the set's mutex and with the entry's own run id: `createRun` refuses an existing folder,
 * so an entry can never become two runs (a kill before or after `createRun` is the same call again). Returns the runs this call made.
 */
export async function ensureSliceRuns(deps: LaunchSetDeps, input: { sceneSetId: string; launchId: string; build: DrawSliceInput["build"] }): Promise<{ created: string[] }> {
  const { library, registry } = deps;
  const { avatarId } = await findSceneSet(library, input.sceneSetId);
  return withSceneSetLock(input.sceneSetId, async () => {
    const current = await library.sceneSets.get(avatarId, input.sceneSetId);
    if (current === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `scene set ${input.sceneSetId} is gone` });
    if (current.launchId !== input.launchId || current.launchDraw === undefined) throw sceneRefusal(`scene set ${input.sceneSetId} is not approved by launch ${input.launchId}`, "not-awaiting");
    const created: string[] = [];
    for (const entry of current.launchDraw.slices) {
      registry?.linkRun(entry.runId, input.launchId);
      if (await library.runFolderExists(entry.runId)) continue;
      try {
        await library.createRun(entry.runId, input.build(current, entry), RunPlanSchema);
        created.push(entry.runId);
      } catch (error) {
        if (!(error instanceof LibraryError && error.code === "run-exists")) throw error;
      }
    }
    return { created };
  });
}

/**
 * Which phase the stop found the set in: `plain` (no launch), `awaiting` (written or awaiting review, not approved), `approved` (a frozen draw and no slice
 * folder yet), `drawn` (at least one slice folder: the set stays used).
 */
export type UnlinkPhase = "plain" | "awaiting" | "approved" | "drawn";

/**
 * Plan §3.7: releases the set from its launch under the set's mutex (revision + 1): clears `launchId` and, if there is one, `launchDraw`. With no slice
 * folder the set is an ordinary open set again; with one it stays used and its runs become the owner's own (the registry forgets them). The caller has waited
 * for any job of the set to end (a composing set is unlinked after the soft stop, not during it). Unlinking a set that has no launch changes nothing.
 */
export async function unlinkLaunchSet(deps: LaunchSetDeps, sceneSetId: string): Promise<{ phase: UnlinkPhase }> {
  const { library, registry } = deps;
  const { avatarId } = await findSceneSet(library, sceneSetId);
  const folders = new Set<string>();
  let phase: UnlinkPhase = "plain";
  let released: string[] = [];
  try {
    await library.sceneSets.update(
      avatarId,
      sceneSetId,
      (current) => {
        const { launchId, launchDraw, ...rest } = current;
        if (launchId === undefined && launchDraw === undefined) return null;
        phase = launchDraw === undefined ? "awaiting" : launchDraw.slices.some((e) => folders.has(e.runId)) ? "drawn" : "approved";
        released = (launchDraw?.slices ?? []).map((e) => e.runId);
        return rest;
      },
      {
        guard: async (current) => {
          for (const entry of current.launchDraw?.slices ?? []) if (await library.runFolderExists(entry.runId)) folders.add(entry.runId);
        },
      },
    );
  } catch (error) {
    throw asEngineError(error);
  }
  registry?.unlinkSet(sceneSetId);
  for (const runId of released) registry?.unlinkRun(runId);
  return { phase };
}
