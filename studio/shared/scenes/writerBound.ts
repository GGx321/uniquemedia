import { isCustomCategory, SCENE_CHUNK_SIZE, type CategoryRef, type SceneLevel } from "../engine";

// 5a.2 (S5.6c2, plan s5a2 §5.6, I5.30): the one bound on the writer's requests, read by every estimate site, `remaining`, the launch's unit prices and the
// mock. A built-in category, and a custom category whose pool the template covers (`covers`, custom.ts), renders every slot in code and asks the model for
// nothing. Only the slots of an uncovered custom category can go to the model, and a chunk costs a request exactly when it holds one of them.

/** One category's share of a plan: its ref and how many slots it draws. */
export interface SplitEntry {
  ref: CategoryRef;
  count: number;
}

/** Whether the code template renders every slot a custom category can draw. Asked for custom categories only: a built-in always does. */
export type CoversOf = (ref: CategoryRef) => boolean;

const NONE_COVERED: CoversOf = () => false;

/**
 * 5a.4 (S5.BA5, plan s5a4 I5.77, BA3 review M-1): the covers a split is priced with at a level. At «Смелая» no custom category is covered: every slot of it is on the route,
 * drawn from the shared «Смелая» banks, and the template renders none of them (shared/scenes/template.ts: a routed custom slot is the writer's), whatever its pool reads. A
 * built-in is still covered (the template renders its routed slots). Below «Смелая» the covers are the pool's own.
 */
export function coversAt(covers: CoversOf, level: SceneLevel | undefined): CoversOf {
  return level === "bold" ? NONE_COVERED : covers;
}

/**
 * 5a.4 (S5.BA5, I5.77): the scene writer's mode for a request not yet planned (engine/money/estimate.ts `writerCallOf`): «bold» at «Смелая», where every slot the model writes is a
 * custom category's routed slot, «ordinary» below it.
 */
export function writerModeAt(level: SceneLevel | undefined): "ordinary" | "bold" {
  return level === "bold" ? "bold" : "ordinary";
}

function uncoveredOf(split: readonly SplitEntry[], covers: CoversOf): SplitEntry[] {
  return split.filter((entry) => entry.count > 0 && isCustomCategory(entry.ref) && !covers(entry.ref));
}

/** How many slots can go to the model: those of the uncovered custom categories. */
export function llmPossibleSlots(split: readonly SplitEntry[], covers: CoversOf): number {
  return uncoveredOf(split, covers).reduce((sum, entry) => sum + entry.count, 0);
}

/**
 * The most writer requests a plan of this split can need (each is then retried up to the writer's attempts). The planner draws each category as one block
 * of slots and the writer cuts the plan every `SCENE_CHUNK_SIZE`; the bound does not see the order, so a block of m slots may touch ⌈m/25⌉ + 1 chunks.
 * Summed over the uncovered custom categories and capped at the plan's own chunk count. Brute-forced in writerBound.test.ts.
 */
export function writerChunksWorst(split: readonly SplitEntry[], covers: CoversOf, chunkSlots: number = SCENE_CHUNK_SIZE): number {
  const total = split.reduce((sum, entry) => sum + entry.count, 0);
  const touched = uncoveredOf(split, covers).reduce((sum, entry) => sum + Math.ceil(entry.count / chunkSlots) + 1, 0);
  return Math.min(touched, Math.ceil(total / chunkSlots));
}
