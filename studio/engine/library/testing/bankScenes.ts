import type { PoolShot } from "../../../shared/engine";
import { BANKS } from "../../../shared/scenes/banks";
import { BANK_CATEGORIES, type BankCategory } from "../../../shared/scenes/banks/types";
import { templateSentence } from "../../../shared/scenes/template";
import type { PlanSlot } from "../../scenes";
import type { SceneRecord } from "../sceneSets";

// 5a.2 (S5.6c1): a planned slot the code template renders. The planner's own draw from the banks is S5.6b's, so tests name a bank place, moment and
// outfit by hand: the first one the template itself accepts. No test-runner import, like sampleData.ts.

const SHOTS: readonly PoolShot[] = ["friend", "candid", "selfie", "mirror"];

/** The place, moment, outfit and shot of the first draw in the category the template renders, facing the camera. */
export function bankDraw(category: BankCategory = "home"): { location: string; activity: string; outfit: string; shot: PoolShot } {
  const bank = BANKS[category];
  for (const shot of SHOTS) {
    for (const place of bank.places) {
      for (const moment of place.moments) {
        const outfit = moment.outfits?.[0] ?? bank.outfits.find((o) => o.pinOnly !== true)?.text;
        if (outfit === undefined) continue;
        const draw = { location: place.name, activity: moment.text, outfit, shot };
        if (templateSentence({ route: undefined, category, pose: "front", ...draw }, { key: "probe" }) !== null) return draw;
      }
    }
  }
  throw new Error(`no ${category} draw the template renders`);
}

/** The slot, moved onto the banks of its own category (a custom one onto glamour): it keeps its index, attempt id base and time. */
export function onTheBanks(slot: PlanSlot): PlanSlot {
  const category = BANK_CATEGORIES.find((c) => c === slot.category) ?? "glamour";
  return { ...slot, category, pose: "front", ...bankDraw(category) };
}

/** The set with the scenes whose ids are in `sceneIds` moved onto the banks. */
export function sceneSetOnTheBanks<T extends { scenes: readonly SceneRecord[] }>(set: T, sceneIds: readonly number[]): Omit<T, "scenes"> & { scenes: SceneRecord[] } {
  return { ...set, scenes: set.scenes.map((scene) => (scene.origin === "planned" && sceneIds.includes(scene.sceneId) ? { ...scene, slot: onTheBanks(scene.slot) } : scene)) };
}
