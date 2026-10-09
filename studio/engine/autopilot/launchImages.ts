import { drawAllocationLeft, type LaunchScopeMoney } from "../../shared/autopilot/money";
import type { SliceStatus } from "../sceneSets/launchDraw";

// S4.6p: what `runs.estimateImages { launchId, avatarId }` is made of, pure. The engine reads the set and the slices' statuses; this says how many photos are still to draw and how many of
// them the money the launch has for them buys. The price of those photos is the real draw's own (`runEstimateFromScenes`): nothing here prices anything.
//
// Whose money pays which photo (plan §4.3, N1). A slice is made with a cap taken out of the avatar's draw allocation, and its open slots are paid from THAT cap, whatever it has
// spent so far: they must not be priced against what is left for new slices, which is the allocation less every live slice's whole cap (the open slots would be counted twice).
// The scenes not yet in a slice are paid from what is left. So: open slots of a slice fit its own cap; scenes not yet in a slice fit the allocation left.

/** The part of a launch's scene set that decides what is left to draw. */
export interface LaunchSetFacts {
  scenes: readonly { removed: boolean; text: string | null; origin: "planned" | "own" }[];
  launchDraw?: { sceneIds: readonly number[]; slices: readonly { runId: string; sceneIds: readonly number[]; capMicros: number }[] } | undefined;
}

/** The photos still to draw, apart: those no slice has taken, and the open slots of each slice that began and is not finished. */
function split(set: LaunchSetFacts, statuses: ReadonlyMap<string, SliceStatus>): { undrawn: number; open: { capMicros: number; slots: number }[] } {
  const draw = set.launchDraw;
  // Before the owner's «Продолжить запуск» the draw is not frozen: it is the planned scenes with a text (what the button would draw, as `approveLaunchSet` takes them). A scene
  // without one is taken out, and an own scene the owner added is not the launch's to draw.
  if (draw === undefined) return { undrawn: set.scenes.filter((scene) => !scene.removed && scene.origin === "planned" && scene.text !== null).length, open: [] };
  const taken = new Set(draw.slices.flatMap((slice) => slice.sceneIds));
  const open: { capMicros: number; slots: number }[] = [];
  for (const slice of draw.slices) {
    const status = statuses.get(slice.runId);
    if (status !== undefined && !status.finished && (status.openSlots ?? 0) > 0) open.push({ capMicros: slice.capMicros, slots: status.openSlots ?? 0 });
  }
  return { undrawn: draw.sceneIds.filter((id) => !taken.has(id)).length, open };
}

/**
 * The photos the launch still has to draw for the set. Before the owner's «Продолжить запуск» the draw is not frozen: it is the planned scenes with a text. Once frozen: the scenes of
 * the frozen list that no slice has taken, plus the open slots of the slices that began and are not finished.
 */
export function launchPhotosLeft(set: LaunchSetFacts, statuses: ReadonlyMap<string, SliceStatus>): number {
  const { undrawn, open } = split(set, statuses);
  return undrawn + open.reduce((sum, slice) => sum + slice.slots, 0);
}

/**
 * The draw allocation left for scenes not yet in a slice (plan §4.3 item 4): the avatar's `drawMicros` less what its finished slices committed and what its live slices still hold at
 * their caps. A slice with no status has no run yet and holds nothing, as the slice sizing counts it.
 */
export function launchDrawLeft(drawMicros: number, set: LaunchSetFacts, statuses: ReadonlyMap<string, SliceStatus>): number {
  const scopes: LaunchScopeMoney[] = [];
  for (const slice of set.launchDraw?.slices ?? []) {
    const status = statuses.get(slice.runId);
    if (status === undefined) continue;
    scopes.push(status.finished ? { state: "finished", committedMicros: status.committedMicros } : { state: "live", capMicros: slice.capMicros });
  }
  return drawAllocationLeft(drawMicros, scopes);
}

/**
 * How many of the photos still to draw the money buys at `photoWorstMicros` a photo: `left` is all of them, `photos` those that fit — the open slots of each slice within its own cap,
 * the scenes not yet in a slice within the allocation left. When the price rose since the plan `photos` is below `left`; the figure for `photos` then never passes what the launch may spend.
 */
export function launchDrawFit(set: LaunchSetFacts, statuses: ReadonlyMap<string, SliceStatus>, drawMicros: number, photoWorstMicros: number): { left: number; photos: number } {
  const { undrawn, open } = split(set, statuses);
  const left = undrawn + open.reduce((sum, slice) => sum + slice.slots, 0);
  if (photoWorstMicros <= 0) return { left, photos: left };
  const undrawnFit = Math.min(undrawn, Math.floor(launchDrawLeft(drawMicros, set, statuses) / photoWorstMicros));
  const openFit = open.reduce((sum, slice) => sum + Math.min(slice.slots, Math.floor(slice.capMicros / photoWorstMicros)), 0);
  return { left, photos: undrawnFit + openFit };
}
