import { EngineFailure } from "../engineFailure";
import { LibraryError, type Library } from "../library";
import { withSceneSetLock, type StoredSceneSet } from "../library/sceneSets";
import { RunPlanSchema, type RunPlan } from "../runs/plan";
import { sceneRefusal } from "./refusal";
import { approvalRefusal } from "./toRun";

// CS.5: the approval of a scene set, the two library steps of «Отрисовать N фото». The engine owns the money and the checks between them; this owns what must
// be true of the SET when a run is made from it:
//  - `loadApprovable` reads the set and refuses, free and in the contract's order, whatever keeps it from becoming a run.
//  - `commitApproval` is the last step, under the set's own lock: the set is read again, the same refusals are made again on what is there NOW, and only
//    then the run folder is made (under the set's pre-issued run id). An edit or a discard that landed while the engine awaited prices and the master's
//    preflight is refused here (SCENES_CHANGED / NOT_FOUND) and nothing is written; an edit that arrives after the folder exists meets a used set.
//    The folder is created whole (its plan inside) or not at all, so no image can be asked for before `plan.json` exists.

export interface ApprovalDeps {
  library: Library;
  /** Whether a job of the set runs now (or is about to). */
  isLive: (sceneSetId: string) => boolean;
  /** S4.5a: the unfinished launch a set belongs to, if any. The owner's «Отрисовать» on a launch's set is refused (`launch-set`): the launch draws it in slices. */
  launchOf: (set: StoredSceneSet) => string | undefined;
}

/** The refusal of an owner's approval of a set an unfinished launch holds, or null. */
function launchRefusal(deps: ApprovalDeps, set: StoredSceneSet): EngineFailure | null {
  const launchId = deps.launchOf(set);
  return launchId === undefined ? null : sceneRefusal(`scene set ${set.sceneSetId} is part of launch ${launchId}; the launch draws it`, "launch-set");
}

export interface Approvable {
  set: StoredSceneSet;
  avatarId: string;
}

/** The set with this id, in whichever avatar's folder it lies; NOT_FOUND when none of them has it. */
export async function findSceneSet(library: Library, sceneSetId: string): Promise<Approvable> {
  for (const manifest of library.listAvatars()) {
    const set = await library.sceneSets.get(manifest.id, sceneSetId).catch(() => null);
    if (set !== null) return { set, avatarId: manifest.id };
  }
  throw new EngineFailure({ code: "NOT_FOUND", detail: `no scene set ${sceneSetId} in the open library` });
}

/** The set at the revision the window approved, or the free refusal that says why not. */
export async function loadApprovable(deps: ApprovalDeps, sceneSetId: string, revision: number): Promise<Approvable> {
  const found = await findSceneSet(deps.library, sceneSetId);
  const held = launchRefusal(deps, found.set);
  if (held !== null) throw held;
  const refusal = approvalRefusal(found.set, { revision, live: deps.isLive(sceneSetId), used: await deps.library.runFolderExists(found.set.runId) });
  if (refusal !== null) throw new EngineFailure(refusal);
  return found;
}

/**
 * Under the set's lock: re-read, refuse again on what is there now, then make the run folder with the plan `build` makes from that very record.
 * A run folder that is already there (a start that raced, or a crash that left one) is refused: a set never becomes two runs.
 */
export async function commitApproval(deps: ApprovalDeps, approved: Approvable & { revision: number }, build: (current: StoredSceneSet) => RunPlan): Promise<RunPlan> {
  const { library } = deps;
  const { avatarId, revision } = approved;
  const sceneSetId = approved.set.sceneSetId;
  return withSceneSetLock(sceneSetId, async () => {
    const current = await library.sceneSets.get(avatarId, sceneSetId);
    if (current === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `scene set ${sceneSetId} is gone: it was discarded while the run was being prepared` });
    const held = launchRefusal(deps, current);
    if (held !== null) throw held;
    const refusal = approvalRefusal(current, { revision, live: deps.isLive(sceneSetId), used: await library.runFolderExists(current.runId) });
    if (refusal !== null) throw new EngineFailure(refusal);
    const plan = build(current);
    try {
      await library.createRun(current.runId, plan, RunPlanSchema);
    } catch (error) {
      if (error instanceof LibraryError && error.code === "run-exists") {
        throw sceneRefusal(`scene set ${sceneSetId} is already used by run ${current.runId}`, "set-used");
      }
      throw error;
    }
    return plan;
  });
}
