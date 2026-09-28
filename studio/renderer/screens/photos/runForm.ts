import { SceneCategory, type RunRequest } from "../../../shared/engine";
import type { EngineView } from "../../engine/store";
import { paidStop, restartStopText } from "../../lib/paidStop";

export type RunCategory = RunRequest["categories"][number];
export type RunResolution = RunRequest["resolution"];

/** The Photos form (Photos.dc.html's generation card): what a run asks for, before it becomes a `RunRequest`. */
export interface RunForm {
  count: number;
  categories: readonly RunCategory[];
  resolution: RunResolution;
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

/** The mockup's opening state: 20 photos at 1K in every category, profile and back not allowed. */
export const DEFAULT_RUN_FORM: RunForm = {
  count: 20,
  categories: SceneCategory.options,
  resolution: "1k",
  poses: { profile: false, back: false },
};

/** The mockup's own labels; the scene tags and the gallery use them too. */
export const CATEGORY_LABEL: Record<RunCategory, string> = {
  home: "Дом",
  travel: "Путешествия",
  shoot: "Фотосессия",
  glam: "Гламур 18+",
  fit: "Фитнес",
};

/**
 * How many photos each chosen category gets: the engine planner's own split
 * (scenes/planner.ts's `distribute`) — as even as possible, the remainder to
 * the categories earliest in the contract's canonical order.
 */
export function photosPerCategory(count: number, categories: readonly RunCategory[]): Map<RunCategory, number> {
  const ordered = SceneCategory.options.filter((c) => categories.includes(c));
  const split = new Map<RunCategory, number>();
  if (ordered.length === 0) return split;
  const base = Math.floor(count / ordered.length);
  const remainder = count % ordered.length;
  ordered.forEach((category, i) => split.set(category, base + (i < remainder ? 1 : 0)));
  return split;
}

/** The exact request a price is asked for and a run is started with; categories in canonical order, so equal forms give equal requests. */
export function runRequest(avatarId: string, form: RunForm): RunRequest {
  return {
    avatarId,
    count: form.count,
    categories: SceneCategory.options.filter((c) => form.categories.includes(c)),
    resolution: form.resolution,
    poses: { profile: form.poses.profile, back: form.poses.back },
  };
}

/** A stable identity for a request: an estimate belongs to exactly one. */
export function requestKey(request: RunRequest): string {
  return JSON.stringify([request.avatarId, request.count, request.categories, request.resolution, request.poses.profile, request.poses.back]);
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
