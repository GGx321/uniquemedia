import type { StoredSceneSet } from "../library/sceneSets";
import type { PlanSlot } from "../scenes";
import { localSentences } from "../scenes/localSentences";

// 5a.2 (S5.6c1, plan s5a2 r1.5 §5.4): the template's side of a scene set's writer seam. One list serves the compose, «Дописать», a planned review write
// and the question «can the template write this chunk?» (`pendingChunks`): every planned scene that is not removed, in scene order, drawn on the key
// `${sceneSetId}:${sceneId}:${k}` (`k` = 0 for the set's own writes, the write's number for a review write), with the set's category snapshots.

/**
 * 5a.4 (S5.BA5, plan s5a4 I5.74): `impliedNudity` is the avatar's origin, the coverage a «Смелая» sentence ends with. Required: the job that writes the sentences passes the
 * avatar's (`studioCreated`); a caller that only asks which scenes the template can write (the money's `pendingChunks`, `writeEstimate`) says false, the answer being the same.
 */
export function setLocal(set: StoredSceneSet, k: number, impliedNudity: boolean): (slot: PlanSlot) => string | null {
  const slots = set.scenes.flatMap((scene) => (scene.origin === "planned" && !scene.removed ? [scene.slot] : []));
  return localSentences({ slots, keyOf: (slot) => `${set.sceneSetId}:${slot.slotIndex}:${k}`, snapshots: set.categories, impliedNudity });
}
