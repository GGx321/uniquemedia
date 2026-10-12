import { isCustomCategory, splitCount, type CategoryRef, type SceneLevel } from "../../../shared/engine";
import { flirtyCountOf } from "../../../shared/scenes/level";
import { countOf } from "../../lib/format";

// S5.7c (plan s5a2 §6.3, I5.28; mockups 24–25, 30): «Подача» on the window's side. The angle no longer has a control: it comes from the scene, and «Ракурсы»
// gave way to this row. The card and «Автопилот» share the words below; the card remembers the choice per avatar (owner: «Обычная» by default, remembered per
// avatar), «Автопилот» per launch form.

/** The three faces of the row; «Смелая» is drawn disabled until 5a.3. */
export const LEVEL_OPTIONS = [
  { value: "ordinary", label: "Обычная" },
  { value: "flirty", label: "Кокетливая" },
] as const satisfies readonly { value: SceneLevel; label: string }[];
export const BOLD_LABEL = "Смелая";

/** The owner's wording of 2026-10-11 for the disabled «Смелая» (README «S5.2», decisions). */
export const BOLD_LATER = "Смелая — ночнушки, бельё и пляж — появится позже.";

/** Where the toggles were: the angle comes from the scene (mockups 24–27). */
export const ANGLE_FROM_SCENE = "Ракурс берётся из сцены: «через плечо», «со спины», «в профиль». Со спины и в профиль — без проверки сходства, не больше 1 кадра из 5.";

/** «Автопилот»'s row caption, lower-case like every caption of that column (README «S5.2», not literal 5). */
export const ANGLE_FROM_SCENE_SHORT = "ракурс берётся из сцены";

/**
 * How many of `count` photos over `categories` «Кокетливая» makes flirty: round-half-up(0.6 × n) of each built-in category's n (I5.28), split as the planner
 * splits (`splitCount`). A custom category stays ordinary. The per-category rule is the planner's own, `flirtyCountOf` (`shared/scenes/level.ts`).
 */
export function flirtyFrames(count: number, categories: readonly CategoryRef[]): number {
  if (categories.length === 0) return 0;
  return splitCount(count, categories).reduce((sum, { ref, count: n }) => sum + (isCustomCategory(ref) ? 0 : flirtyCountOf(n, "flirty")), 0);
}

/** What «Кокетливая» says when the run has only custom categories: no frame can be flirty, and «0 из N» would read as a fault. */
export const FLIRTY_BUILTIN_ONLY = "Подача — только во встроенных категориях";

/** «12 из 20 кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.» (mockup 25). */
export function flirtyCaption(flirty: number, count: number): string {
  return `${flirty} из ${countOf(count, ["кадра", "кадров", "кадров"])} — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.`;
}

/** «Автопилот» before its plan has new photos to count: the share itself (owner: «Кокетливая» is 6 of 10 frames). */
const FLIRTY_SHARE = "6 из 10 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.";

/** What `launchFlirtyCaption` reads of a launch's plan (`LaunchPreview`). */
interface LaunchPlanCounts {
  readonly avatars: readonly { readonly toGenerate: number; readonly blocked: unknown }[];
  readonly totals: { readonly toGenerate: number };
}

/**
 * «Автопилот»'s «Подача» caption (mockup 30): «≈ {F} из {M} новых кадров — …». Each avatar composes its own new photos, so F sums `flirtyFrames` per
 * avatar that is not blocked (the plan's totals leave those out); «≈», since the engine splits an avatar's photos by video. With no plan yet, or nothing new
 * to draw, the share itself.
 */
export function launchFlirtyCaption(plan: LaunchPlanCounts | null, categories: readonly CategoryRef[]): string {
  // Only custom categories on (S5.7R, LOW): no frame can be flirty, and «≈ 0 из N» (or a share of 6 in 10) would read as a fault; it says where «Подача» works, as the card does.
  if (categories.length > 0 && categories.every(isCustomCategory)) return FLIRTY_BUILTIN_ONLY;
  if (plan === null || plan.totals.toGenerate === 0) return FLIRTY_SHARE;
  const flirty = plan.avatars.reduce((sum, avatar) => sum + (avatar.blocked === null ? flirtyFrames(avatar.toGenerate, categories) : 0), 0);
  return `≈ ${flirty} из ${countOf(plan.totals.toGenerate, ["нового кадра", "новых кадров", "новых кадров"])} — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.`;
}

// ---------- remembered per avatar ----------

/** «Подача» of each avatar in the viewer's localStorage: `studio.photos.level.<avatarId>` holds «flirty»; «Обычная», the default, is not stored. */
export const LEVEL_KEY_PREFIX = "studio.photos.level.";

type LevelStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The avatar's «Подача»: «Кокетливая» only when it was chosen on this machine; anything else, or a storage that cannot be read, reads «Обычная». */
export function readLevel(storage: LevelStorage | null, avatarId: string): SceneLevel {
  if (storage === null) return "ordinary";
  try {
    return storage.getItem(`${LEVEL_KEY_PREFIX}${avatarId}`) === "flirty" ? "flirty" : "ordinary";
  } catch {
    return "ordinary";
  }
}

/** Keeps the avatar's «Подача». A storage that throws keeps nothing, silently: the choice holds for this window anyway. */
export function writeLevel(storage: LevelStorage | null, avatarId: string, level: SceneLevel): void {
  if (storage === null) return;
  try {
    if (level === "flirty") storage.setItem(`${LEVEL_KEY_PREFIX}${avatarId}`, "flirty");
    else storage.removeItem(`${LEVEL_KEY_PREFIX}${avatarId}`);
  } catch {
    // Blocked, full or gone: the choice holds for this window only.
  }
}
