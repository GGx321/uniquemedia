import { isBoldCategory, splitCount, type CategoryRef } from "../../shared/engine";

// 5a.3 (S5.9f, plan s5a3 §10, §12): what the mock knows of the «Смелая» route, once, for the run, the set and the launch. The engine's own functions are `isBoldLook`, `boldPhotosOf` and the
// price book's 2K tier (`engine/runs/plan.ts`, `engine/money/prices.ts`); the renderer cannot import them, so these are the same rules over the mock's flat prices.

/** One attempt on the «Смелая» route (Seedream at 2K, one reference): the engine's price book gives 90 000 µ$ for the tier and 3 000 µ$ for the reference, no float. */
export const MOCK_BOLD_IMAGE = 93_000;

/**
 * Whether a request, a set or a launch draft is «Смелая» AND names a «Смелая» category (the engine's `isBoldLook`). Only then are its photos priced on the 2K route; «Смелая» with the five
 * ordinary categories draws as «Кокетливая» on the owner's model, priced as it always was.
 */
export function isBoldLook(look: { level?: string | undefined; categories: readonly string[] }): boolean {
  return look.level === "bold" && look.categories.some(isBoldCategory);
}

/** The photos of a run request that belong to a «Смелая» category: the figure its estimate prices on the 2K route (the engine's `requestBoldPhotos`). */
export function requestBoldPhotos(request: { count: number; categories: readonly CategoryRef[] }): number {
  return splitCount(request.count, request.categories).reduce((sum, entry) => (isBoldCategory(entry.ref) ? sum + entry.count : sum), 0);
}

/** One attempt as a bold slot is reserved: never below the owner's model (the engine's `max(bold, dearest)`). */
export function boldAttemptWorst(image: number): number {
  return Math.max(MOCK_BOLD_IMAGE, image);
}
