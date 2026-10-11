import { BANKS } from "../../../shared/scenes/banks";
import type { PlanSlot } from "../../scenes";
import type { SceneRecord } from "../sceneSets";

// 5a.2 (S5.6c1): a planned slot the code template renders. The planner's own draw from the banks is S5.6b's, so tests name a bank place, moment and
// outfit by hand: a glamour place whose moment a friend's shot takes, in the first outfit no moment has to pin. No test-runner import, like sampleData.ts.

/** The glamour place, moment and outfit a friend's front-facing shot renders from. */
export function bankDraw(): { location: string; activity: string; outfit: string } {
  for (const place of BANKS.glamour.places) {
    const moment = place.moments.find((m) => m.captures.includes("friend") && !m.twoHanded && m.angle === undefined && m.level === undefined && m.outfits === undefined && m.legs === undefined);
    const outfit = BANKS.glamour.outfits.find((o) => o.pinOnly !== true);
    if (moment !== undefined && outfit !== undefined) return { location: place.name, activity: moment.text, outfit: outfit.text };
  }
  throw new Error("no glamour draw for a friend's shot");
}

/** The slot, moved onto the banks: it keeps its index, attempt id base and time, and renders from the template. */
export function onTheBanks(slot: PlanSlot): PlanSlot {
  return { ...slot, category: "glamour", shot: "friend", pose: "front", ...bankDraw() };
}

/** The set with the scenes whose ids are in `sceneIds` moved onto the banks. */
export function sceneSetOnTheBanks<T extends { scenes: readonly SceneRecord[] }>(set: T, sceneIds: readonly number[]): Omit<T, "scenes"> & { scenes: SceneRecord[] } {
  return { ...set, scenes: set.scenes.map((scene) => (scene.origin === "planned" && sceneIds.includes(scene.sceneId) ? { ...scene, slot: onTheBanks(scene.slot) } : scene)) };
}
