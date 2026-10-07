import { isCustomCategory, MAX_COMPOSE_SCENES, type CategorySnapshot, type EngineError } from "../../shared/engine";
import type { SceneRecord, StoredSceneSet } from "../library/sceneSets";
import type { SceneRunSource } from "../runs/plan";
import { sentenceProblems } from "../scenes";

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

/** How many scene ids a refusal names; SafeText holds 500 characters, and a set may have 100 such scenes. */
const NAMED_SCENES = 10;

function namedScenes(ids: readonly number[]): string {
  const head = ids.slice(0, NAMED_SCENES).join(", ");
  return ids.length > NAMED_SCENES ? `${head} (+${ids.length - NAMED_SCENES} more)` : head;
}

/**
 * Why this set may not become a run now, or null. The order is the contract, and every refusal is free: the revision moved (the window approved
 * something else), an active scene has no text, none or more than `MAX_COMPOSE_SCENES` are active, an active text now breaks the word rules (an app update
 * may have changed them since the text was accepted: it would fail at the assembler, forever resumable), a job of the set runs, the set is already used.
 */
export function approvalRefusal(set: StoredSceneSet, ctx: ApprovalContext): ApprovalRefusal | null {
  if (set.revision !== ctx.revision) return { code: "SCENES_CHANGED", detail: `scene set ${set.sceneSetId} is at revision ${set.revision}, not ${ctx.revision}` };
  const active = activeScenes(set);
  const empty = active.filter((scene) => scene.text === null).map((scene) => scene.sceneId);
  if (empty.length > 0) return { code: "VALIDATION", detail: `scene(s) ${namedScenes(empty)} of set ${set.sceneSetId} have no text: write, type or remove them first` };
  if (active.length === 0) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} has no scene to draw: every scene is removed` };
  if (active.length > MAX_COMPOSE_SCENES) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} has ${active.length} active scenes; a run draws at most ${MAX_COMPOSE_SCENES}` };
  const unfit = active.find((scene) => scene.text !== null && sentenceProblems(scene.text).length > 0);
  if (unfit !== undefined) return { code: "VALIDATION", detail: `the text of scene ${unfit.sceneId} of set ${set.sceneSetId} breaks today's word rules: edit or remove it first` };
  if (ctx.live) return { code: "IN_FLIGHT", detail: `scene set ${set.sceneSetId} is being written; wait for that to end (or cancel it)` };
  if (ctx.used) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} is already used by run ${set.runId}` };
  return null;
}

/** What the run is made of: each active scene's text and its slot, in the set's order. A scene with no text is a bug of the caller (`approvalRefusal` first). */
export function runSources(set: StoredSceneSet): SceneRunSource[] {
  return activeScenes(set).map((scene): SceneRunSource => {
    if (scene.text === null) throw new RangeError(`scene ${scene.sceneId} of set ${set.sceneSetId} has no text`);
    // The switch on `origin` is exhaustive on purpose: a new kind of scene must name its slot here (an own scene's slot is `{ kind: "own", shot, pose }`).
    switch (scene.origin) {
      case "planned":
        return { sceneId: scene.sceneId, text: scene.text, slot: scene.slot };
      case "own":
        return { sceneId: scene.sceneId, text: scene.text, slot: { kind: "own", shot: scene.shot, pose: scene.pose } };
    }
  });
}

/** The snapshot of every custom category the run's scenes use, as the set held it (the run never reads the category library). */
export function runSnapshots(set: StoredSceneSet, sources: readonly SceneRunSource[]): CategorySnapshot[] {
  const used = new Set(sources.flatMap(({ slot }) => (!("kind" in slot) && isCustomCategory(slot.category) ? [slot.category] : [])));
  return (set.categories ?? []).filter((snapshot) => used.has(snapshot.ref));
}
