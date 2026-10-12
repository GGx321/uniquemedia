import {
  isCustomCategory,
  orderCategories,
  ORDINARY_SCENE_CATEGORIES,
  SceneCategory,
  splitCount,
  type CategorySummary,
  type CustomCategoryId,
  type LegsShare,
  type PhotoSummary,
  type RunRequest,
  type SceneLevel,
} from "../../../shared/engine";
import { covers } from "../../../shared/scenes/custom";
import type { EngineView } from "../../engine/store";
import { paidStop, restartStopText } from "../../lib/paidStop";
import { hasBuiltIn } from "./legs";

export type RunCategory = RunRequest["categories"][number];

/** The Photos form (Photos.dc.html's generation card): what a run asks for, before it becomes a `RunRequest`. */
export interface RunForm {
  count: number;
  categories: readonly RunCategory[];
  /** «Подача» (S5.7c): the angle comes from the scene, so the form holds no poses. */
  level: SceneLevel;
  /** «Ножки» (S5.8b): the owner's pick, kept while no built-in category is on (the request then asks for none). */
  legs: LegsShare;
}

/** The mockup's stepper: 5 to 100 photos in steps of 5 (the contract allows 1–100). */
export const COUNT_MIN = 5;
export const COUNT_MAX = 100;
export const COUNT_STEP = 5;

/** The stepper's own clamp: `count + delta`, never outside 5–100 whatever `count` already was (an off-grid value included). */
export function clampCount(count: number, delta: number): number {
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, count + delta));
}

/** The mockup's opening state: 20 photos in every category, «Подача» «Обычная» (the owner's default), «Ножки» «Нет» (mockups 35, 36). */
export const DEFAULT_RUN_FORM: RunForm = {
  count: 20,
  categories: ORDINARY_SCENE_CATEGORIES,
  level: "ordinary",
  legs: 0,
};

/** The mockup's own labels for the five built-ins; the scene tags and the gallery use them too. */
export const CATEGORY_LABEL: Record<SceneCategory, string> = {
  home: "Дом",
  travel: "Виды",
  shoot: "Улица",
  glam: "Гламур",
  fit: "Фитнес",
  nightwear: "Ночнушки и бельё",
  beach: "Пляж и бассейн",
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

/** Who writes a run's scenes (S5.7c, mockup 26): the app's template for some of them, and the model for the named categories. */
export interface SceneWriters {
  readonly app: boolean;
  /** The custom categories the template does not cover, by name, in the run's order. */
  readonly model: readonly string[];
}

/**
 * Who writes the scenes of `count` photos over `categories` (S5.7c, mockup 26): the app's template writes a built-in category and a custom one whose pool
 * it covers (`covers`, the engine's own test, I5.30); the model writes the others. A category with no photo in the split writes nothing; one the library
 * does not hold is nobody's (the run would not ask for it).
 */
export function sceneWriters(count: number, categories: readonly RunCategory[], customs: readonly CategorySummary[]): SceneWriters {
  let app = false;
  const model: string[] = [];
  for (const [ref, n] of photosPerCategory(count, categories)) {
    if (n === 0) continue;
    if (!isCustomCategory(ref)) {
      app = true;
      continue;
    }
    const custom = customs.find((c) => c.categoryId === ref);
    if (custom === undefined) continue;
    if (covers(custom.pool)) app = true;
    else model.push(custom.name);
  }
  return { app, model };
}

/**
 * The form's categories as a run asks for them (CS.3): the built-ins that are on, in their canonical order, then the custom
 * ones that are on, in the library's creation order (`customOrder`, as `categories.list` answers it). `runRequest` keeps the
 * form's order for custom refs and the engine splits the count in that order, so a chip clicked last must not take a
 * remainder photo from one made earlier. A custom ref the library does not hold (deleted, or another library's) is dropped:
 * a run naming it would be refused.
 */
export function arrangeCategories(on: readonly RunCategory[], customOrder: readonly CustomCategoryId[]): RunCategory[] {
  const wanted = new Set<string>(on);
  // 5a.3 (S5.9b2): the five only; the «Смелая» two are offered with their chips and their gating (S5.9g).
  return [...ORDINARY_SCENE_CATEGORIES.filter((c) => wanted.has(c)), ...customOrder.filter((id) => wanted.has(id))];
}

/** A chip clicked: `ref` on or off, the rest arranged as `arrangeCategories` does. */
export function toggleCategory(categories: readonly RunCategory[], ref: RunCategory, customOrder: readonly CustomCategoryId[]): RunCategory[] {
  return arrangeCategories(categories.includes(ref) ? categories.filter((c) => c !== ref) : [...categories, ref], customOrder);
}

/** Whether two category lists are the same, element by element (order included). */
export function sameCategories(a: readonly RunCategory[], b: readonly RunCategory[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/**
 * The exact request a price is asked for and a run is started with; categories in the contract's order, so equal forms give equal requests. S5.7c: no
 * poses (the angle comes from the scene), and `level` only when it is not the default — a stored request then carries it only when it differs (I5.27).
 * S5.8b: `legsShare` likewise, and only with a built-in category on: legs are drawn from those alone, and a run of the owner's own categories that asked
 * for them would be refused (`legs-built-in-only`).
 */
export function runRequest(avatarId: string, form: RunForm): RunRequest {
  return {
    avatarId,
    count: form.count,
    categories: orderCategories(form.categories),
    ...(form.level === "flirty" ? { level: "flirty" as const } : {}),
    ...(form.legs !== 0 && hasBuiltIn(form.categories) ? { legsShare: form.legs } : {}),
  };
}

/** A stable identity for a request: an estimate belongs to exactly one. Poses are not in it: they change no plan (I5.26). */
export function requestKey(request: RunRequest): string {
  return JSON.stringify([request.avatarId, request.count, request.categories, request.level ?? "ordinary", request.legsShare ?? 0]);
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
