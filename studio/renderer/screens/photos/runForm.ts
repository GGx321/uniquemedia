import { isCustomCategory, orderCategories, SceneCategory, splitCount, type PhotoSummary, type RunRequest } from "../../../shared/engine";
import type { EngineView } from "../../engine/store";
import { paidStop, restartStopText } from "../../lib/paidStop";

export type RunCategory = RunRequest["categories"][number];

/** The Photos form (Photos.dc.html's generation card): what a run asks for, before it becomes a `RunRequest`. */
export interface RunForm {
  count: number;
  categories: readonly RunCategory[];
  /** Beyond front and three-quarter, which are always on (T5c, owner decision). */
  poses: RunRequest["poses"];
}

/** The mockup's stepper: 5 to 100 photos in steps of 5 (the contract allows 1–100). */
export const COUNT_MIN = 5;
export const COUNT_MAX = 100;
export const COUNT_STEP = 5;

/** The stepper's own clamp: `count + delta`, never outside 5–100 whatever `count` already was (an off-grid value included). */
export function clampCount(count: number, delta: number): number {
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, count + delta));
}

/** The mockup's opening state: 20 photos in every category, profile and back not allowed. */
export const DEFAULT_RUN_FORM: RunForm = {
  count: 20,
  categories: SceneCategory.options,
  poses: { profile: false, back: false },
};

/** The mockup's own labels for the five built-ins; the scene tags and the gallery use them too. */
export const CATEGORY_LABEL: Record<SceneCategory, string> = {
  home: "Дом",
  travel: "Путешествия",
  shoot: "Фотосессия",
  glam: "Гламур 18+",
  fit: "Фитнес",
};

/** What a custom category's photo is called when its sidecar kept no name, and an own scene's default name. */
const CUSTOM_CATEGORY_FALLBACK = "Своя категория";
const OWN_SCENE_LABEL = "Своя сцена";

/**
 * A photo's category as the gallery, the viewer and the montage bin show it: a
 * built-in by the renderer's own label; a custom category or an own scene by the
 * name its photo kept (a snapshot, so a rename or a delete later changes nothing),
 * or a fixed fallback when the sidecar kept none.
 */
export function photoCategoryLabel(photo: Pick<PhotoSummary, "category" | "categoryName">): string {
  const { category, categoryName } = photo;
  if (category === "own") return categoryName ?? OWN_SCENE_LABEL;
  if (isCustomCategory(category)) return categoryName ?? CUSTOM_CATEGORY_FALLBACK;
  return CATEGORY_LABEL[category];
}

/**
 * How many photos each chosen category gets: the engine planner's own split,
 * the contract's shared `splitCount` (the planner calls the very same function),
 * so a chip's count can never drift from what the engine draws.
 */
export function photosPerCategory(count: number, categories: readonly RunCategory[]): Map<RunCategory, number> {
  return new Map(splitCount(count, categories).map(({ ref, count: n }) => [ref, n]));
}

/** The exact request a price is asked for and a run is started with; categories in the contract's order, so equal forms give equal requests. */
export function runRequest(avatarId: string, form: RunForm): RunRequest {
  return {
    avatarId,
    count: form.count,
    categories: orderCategories(form.categories),
    poses: { profile: form.poses.profile, back: form.poses.back },
  };
}

/** A stable identity for a request: an estimate belongs to exactly one. */
export function requestKey(request: RunRequest): string {
  return JSON.stringify([request.avatarId, request.count, request.categories, request.poses.profile, request.poses.back]);
}

/** Why a paid photo command cannot be sent right now (the wizard's own order and wording), or null. */
export function paidBlockedReason(view: EngineView): string | null {
  const stop = paidStop(view);
  const key = view.settings?.apiKey;
  if (stop?.kind === "offline") return "Нет связи с движком — дождитесь, пока он снова ответит.";
  if (key === undefined || !key.stored || key.rejected) return "Нужен рабочий ключ OpenRouter — добавьте его в Настройках.";
  if (stop?.kind === "reconcile") return "Платные запросы остановлены до сверки расходов.";
  if (stop?.kind === "restart") return restartStopText(stop.code);
  return null;
}

/** "x-ai/grok-4.3" → "grok-4.3": the mockup names a model without its vendor. */
export function modelName(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf("/") + 1);
}
