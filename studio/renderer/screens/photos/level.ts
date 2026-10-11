import { isCustomCategory, splitCount, type CategoryRef, type SceneLevel } from "../../../shared/engine";
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

/** The share of a built-in category's photos «Кокетливая» makes flirty, in tenths (I5.28). */
const FLIRTY_TENTHS = 6;

/**
 * How many of `count` photos over `categories` «Кокетливая» makes flirty: round-half-up(0.6 × n) of each built-in category's n (I5.28), split as the planner
 * splits (`splitCount`). A custom category stays ordinary. 0.6 × n is 6n / 10, which never ends in .5: integers only, no half-way case.
 * S5.7b puts the same rule in `shared/scenes/level.ts` (`flirtyCountOf`) for the planner; once it lands, this sums that instead.
 */
export function flirtyFrames(count: number, categories: readonly CategoryRef[]): number {
  if (categories.length === 0) return 0;
  return splitCount(count, categories).reduce((sum, { ref, count: n }) => sum + (isCustomCategory(ref) ? 0 : Math.floor((FLIRTY_TENTHS * n + 5) / 10)), 0);
}

/** «12 из 20 кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.» (mockup 25). */
export function flirtyCaption(flirty: number, count: number): string {
  return `${flirty} из ${countOf(count, ["кадра", "кадров", "кадров"])} — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.`;
}

// ---------- remembered per avatar ----------

/** «Подача» of each avatar in the viewer's localStorage: `studio.photos.level.<avatarId>` holds «flirty»; «Обычная», the default, is not stored. */
export const LEVEL_KEY_PREFIX = "studio.photos.level.";

type LevelStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The viewer's storage, or null where reading it throws (a blocked profile). */
export function levelStorage(): LevelStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
