import { isCustomCategory, MAX_COMPOSE_SCENES, type CategorySnapshot, type EngineError } from "../../shared/engine";
import type { SceneRecord, StoredSceneSet } from "../library/sceneSets";
import type { SceneRunSource } from "../runs/plan";

// CS.5: what a reviewed scene set must be before it may become a run, and what it hands the run. Pure: the engine owns the money and the library.
// A run draws every ACTIVE scene (not removed), so `M` is the active scenes, each of which must have its text.

export interface ApprovalContext {
  /** The revision the window approved. */
  revision: number;
  /** A job of the set runs (a compose, a write) or is about to. */
  live: boolean;
  /** The set's pre-issued run's folder exists. */
  used: boolean;
}

export type ApprovalRefusal = Pick<EngineError, "code" | "detail"> & { code: "SCENES_CHANGED" | "VALIDATION" | "IN_FLIGHT"; detail: string };

/** The scenes a run would draw: not removed, in the set's order. */
function activeScenes(set: StoredSceneSet): SceneRecord[] {
  return set.scenes.filter((scene) => !scene.removed);
}

/**
 * Why this set may not become a run now, or null. The order is the contract, and every refusal is free: the revision moved (the window approved
 * something else), an active scene has no text, none or more than `MAX_COMPOSE_SCENES` are active, a job of the set runs, the set is already used.
 */
export function approvalRefusal(set: StoredSceneSet, ctx: ApprovalContext): ApprovalRefusal | null {
  if (set.revision !== ctx.revision) return { code: "SCENES_CHANGED", detail: `scene set ${set.sceneSetId} is at revision ${set.revision}, not ${ctx.revision}` };
  const active = activeScenes(set);
  const empty = active.filter((scene) => scene.text === null).map((scene) => scene.sceneId);
  if (empty.length > 0) return { code: "VALIDATION", detail: `scene(s) ${empty.join(", ")} of set ${set.sceneSetId} have no text: write, type or remove them first` };
  if (active.length === 0) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} has no scene to draw: every scene is removed` };
  if (active.length > MAX_COMPOSE_SCENES) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} has ${active.length} active scenes; a run draws at most ${MAX_COMPOSE_SCENES}` };
  if (ctx.live) return { code: "IN_FLIGHT", detail: `scene set ${set.sceneSetId} is being written; wait for that to end (or cancel it)` };
  if (ctx.used) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} is already used by run ${set.runId}` };
  return null;
}

/** What the run is made of: each active scene's text and its slot, in the set's order. A scene with no text is a bug of the caller (`approvalRefusal` first). */
export function runSources(set: StoredSceneSet): SceneRunSource[] {
  return activeScenes(set).map((scene): SceneRunSource => {
    if (scene.text === null) throw new RangeError(`scene ${scene.sceneId} of set ${set.sceneSetId} has no text`);
    // CS.4b adds the own scenes to `SceneRecord`: the switch on `origin` is exhaustive on purpose, so the compiler names the case to map there
    // (an own scene's slot is `{ kind: "own", shot, pose }`, which the plan already holds).
    switch (scene.origin) {
      case "planned":
        return { sceneId: scene.sceneId, text: scene.text, slot: scene.slot };
    }
  });
}

/** The snapshot of every custom category the run's scenes use, as the set held it (the run never reads the category library). */
export function runSnapshots(set: StoredSceneSet, sources: readonly SceneRunSource[]): CategorySnapshot[] {
  const used = new Set(sources.flatMap(({ slot }) => (!("kind" in slot) && isCustomCategory(slot.category) ? [slot.category] : [])));
  return (set.categories ?? []).filter((snapshot) => used.has(snapshot.ref));
}
