import type { CategoryPool, CategoryRef, SceneLevel } from "../../shared/engine";
import { covers } from "../../shared/scenes/custom";
import { coversAt, type CoversOf } from "../../shared/scenes/writerBound";
import { poolOf } from "./poolGen";

// 5a.2 (S5.6c2, plan s5a2 §5.6): which custom categories the code template covers, for the money. A covered category reserves no writer, so its slots
// cost nothing to write; an uncovered one is priced at `writerChunksWorst`. The answer comes from the category's stored pool as it is NOW, so an estimate,
// a launch's compose and a run's start each read the library once and agree with the slots the planner will draw from that same read.

/**
 * `covers` of each stored category's pool, at the level the split is drawn at. A ref the list lacks is not covered: the price never assumes a free writer for a category it cannot
 * see. 5a.4 (S5.BA5, I5.77, BA3 review M-1): at «Смелая» none is (`coversAt`): its slots are on the route and the bold writer writes every one. `level` is required (plan s5a4 M3).
 */
export function coversOfStored(custom: readonly { categoryId: CategoryRef; pool: CategoryPool }[], level: SceneLevel | undefined): CoversOf {
  const answers = new Map<CategoryRef, boolean>();
  for (const category of custom) answers.set(category.categoryId, covers(poolOf(category.pool)));
  return coversAt((ref) => answers.get(ref) ?? false, level);
}
