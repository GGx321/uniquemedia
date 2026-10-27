import type { SceneLevel } from "../../shared/engine";

// 5a.3 (S5.9f, plan s5a3 §10, §12): what the mock knows of the «Смелая» route, once, for the run, the set and the launch. The engine's own functions are `isBoldLook`, `requestBoldPhotos` and the
// price book's 2K tier (`engine/runs/plan.ts`, `engine/money/prices.ts`); the renderer cannot import them, so these are the same rules over the mock's flat prices.
// 5a.4 (S5.BA7, plan s5a4 I5.77, §5.7; BA5 review L-5): «Смелая» is every category's, so a request or a draft at «Смелая» is priced on the route whatever its categories, as the engine's
// `isBoldLook` and `requestBoldPhotos` price it; anything stored (a set, a launch whose set exists) is priced by its own scenes' routes, never by these.

/** One attempt on the «Смелая» route (Seedream at 2K, one reference): the engine's price book gives 90 000 µ$ for the tier and 3 000 µ$ for the reference, no float. */
export const MOCK_BOLD_IMAGE = 93_000;

/** Whether a request or a launch draft not yet planned is «Смелая» (the engine's `isBoldLook`): then the planner puts every slot it plans on the route, of every category. */
export function isBoldLook(look: { level?: SceneLevel | undefined }): boolean {
  return look.level === "bold";
}

/** The photos of a run request that are drawn on the «Смелая» route: every photo at «Смелая», none below (the engine's `requestBoldPhotos`). `level` is a required key (plan s5a4 M3). */
export function requestBoldPhotos(request: { count: number; level: SceneLevel | undefined }): number {
  return isBoldLook(request) ? request.count : 0;
}

/** One attempt as a bold slot is reserved: never below the owner's model (the engine's `max(bold, dearest)`). */
export function boldAttemptWorst(image: number): number {
  return Math.max(MOCK_BOLD_IMAGE, image);
}
