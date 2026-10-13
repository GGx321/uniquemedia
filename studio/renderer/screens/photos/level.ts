import { isBoldCategory, isCustomCategory, splitCount, type BoldCategory, type CategoryRef, type SceneLevel } from "../../../shared/engine";
import { flirtyCountOf, levelCountsOf } from "../../../shared/scenes/level";
import { countOf } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import type { LaunchPlanCounts } from "./launchPlanCounts";

// S5.7c (plan s5a2 §6.3, I5.28; mockups 24–25, 30): «Подача» on the window's side. The angle no longer has a control: it comes from the scene, and «Ракурсы»
// gave way to this row. The card and «Автопилот» share the words below; the card remembers the choice per avatar (owner: «Обычная» by default, remembered per
// avatar), «Автопилот» per launch form. S5.9g (plan s5a3 §13.1; mockups 47–48, 52): «Смелая» is live, with the two categories it draws.

/** The three faces of the row. */
export const LEVEL_OPTIONS = [
  { value: "ordinary", label: "Обычная" },
  { value: "flirty", label: "Кокетливая" },
  { value: "bold", label: "Смелая" },
] as const satisfies readonly { value: SceneLevel; label: string }[];

/** Where the toggles were: the angle comes from the scene (mockups 24–27). */
export const ANGLE_FROM_SCENE = "Ракурс берётся из сцены: «через плечо», «со спины», «в профиль». Со спины и в профиль — без проверки сходства, не больше 1 кадра из 5.";

/** «Автопилот»'s row caption, lower-case like every caption of that column (README «S5.2», not literal 5). */
export const ANGLE_FROM_SCENE_SHORT = "ракурс берётся из сцены";

/**
 * How many of `count` photos over `categories` «Кокетливая» makes flirty: round-half-up(0.6 × n) of each built-in category's n (I5.28), split as the planner
 * splits (`splitCount`). A custom category stays ordinary. The per-category rule is the planner's own, `flirtyCountOf` (`shared/scenes/level.ts`).
 */
export function flirtyFrames(count: number, categories: readonly CategoryRef[]): number {
  return levelFrames(count, categories, "flirty").flirty;
}

/** The bold and flirty frames of a run, and the «Смелая» categories that draw any photo of it. */
export interface LevelFrames {
  readonly bold: number;
  readonly flirty: number;
  /** The «Смелая» categories the split gives a photo, in the run's order. */
  readonly boldCategories: readonly BoldCategory[];
}

/**
 * S5.9g (I5.36): how `count` photos over `categories` divide at `level`, by the planner's own rules over the planner's own split (`splitCount`): in a «Смелая»
 * category at «Смелая», `levelCountsOf` (20 / 40 / 40); in one of the five at «Кокетливая» or «Смелая», `flirtyCountOf` at «Кокетливая» (the five draw «Смелая»
 * as «Кокетливая»); a custom category stays ordinary. Nothing is counted here that the shared rules do not count.
 */
export function levelFrames(count: number, categories: readonly CategoryRef[], level: SceneLevel): LevelFrames {
  let bold = 0;
  let flirty = 0;
  const boldCategories: BoldCategory[] = [];
  if (level === "ordinary" || categories.length === 0) return { bold, flirty, boldCategories };
  for (const { ref, count: n } of splitCount(count, categories)) {
    if (isCustomCategory(ref)) continue;
    if (isBoldCategory(ref)) {
      // A «Смелая» category under «Кокетливая» is never asked for (the window leaves it out of the request): it draws nothing to count.
      if (level !== "bold") continue;
      const counts = levelCountsOf(n);
      bold += counts.bold;
      flirty += counts.flirty;
      if (n > 0) boldCategories.push(ref);
      continue;
    }
    flirty += flirtyCountOf(n, "flirty");
  }
  return { bold, flirty, boldCategories };
}

/** What «Кокетливая» says when the run has only custom categories: no frame can be flirty, and «0 из N» would read as a fault. */
export const FLIRTY_BUILTIN_ONLY = "Подача — только во встроенных категориях";

/** «12 из 20 кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.» (mockup 25). */
export function flirtyCaption(flirty: number, count: number): string {
  return `${flirty} из ${countOf(count, ["кадра", "кадров", "кадров"])} — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.`;
}

/** «Автопилот» before its plan has new photos to count: the share itself (owner: «Кокетливая» is 6 of 10 frames). */
const FLIRTY_SHARE = "6 из 10 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.";

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

// ---------- «Смелая» (S5.9g; plan s5a3 §13.1, mockups 47–48, 52) ----------

/** The word each «Смелая» category gives the caption (mockups 47, 47a: the words of the chosen categories, README «5a.3», item 13). */
const BOLD_WORD: Readonly<Record<BoldCategory, string>> = { nightwear: "бельё", beach: "купальники" };

/** The caption's tail: which model draws the bold frames (mockup 47; README «5a.3», item 13). */
const BOLD_TAIL = "Смелые кадры рисует Seedream 5 Pro · 2K.";

/** «Смелая» with only the five ordinary built-ins on (mockup 47b, plan §13.1): they draw as «Кокетливая». */
export const BOLD_FIVE = "Смелые кадры — только в «Ночнушки и бельё» и «Пляж и бассейн». Остальные категории — как «Кокетливая».";

/** Under the caption while Seedream frames are planned (plan §13.1, r3.1: P-5a3 measured 43–108 s a 2K frame). */
export const BOLD_SLOW = "Кадры «Смелой» рисуются дольше — около минуты каждый.";

/** A «Смелая» category's chip while another «Подача» is on: its title, and the start of the note under the chips (mockup 48). */
export const BOLD_ONLY = "Только со «Смелой»";

/** The note under the chips while «Смелая» is off (mockups 48, 48#kept): which picks wait for it. `kept` names the picked ones, in the row's order. */
export function gatedNote(kept: readonly string[]): string {
  if (kept.length === 0) return `${BOLD_ONLY}: «Ночнушки и бельё» и «Пляж и бассейн».`;
  if (kept.length === 1) return `${BOLD_ONLY}: выбранная «${kept[0]}» вернётся вместе с ней.`;
  return `${BOLD_ONLY}: выбранные вернутся вместе с ней.`;
}

/** «{B} из {N} кадров — смелые: бельё, купальники; {F} — кокетливые. Смелые кадры рисует Seedream 5 Pro · 2K.» (mockup 47), `total` already worded. */
function boldCaption(frames: LevelFrames, total: string): string {
  return `${frames.bold} из ${total} — смелые: ${frames.boldCategories.map((ref) => BOLD_WORD[ref]).join(", ")}; ${frames.flirty} — кокетливые. ${BOLD_TAIL}`;
}

/**
 * «Смелая» with no «Смелая» category to count: the five draw as «Кокетливая», custom categories as ever. With no category picked at all neither sentence names the
 * cause, and no other string fits: nothing is said.
 */
function boldWithout(categories: readonly CategoryRef[]): string | null {
  if (categories.length === 0) return null;
  return categories.some((ref) => !isCustomCategory(ref)) ? BOLD_FIVE : FLIRTY_BUILTIN_ONLY;
}

/**
 * The card's «Подача» caption (mockups 25, 47, 47a, 47b): none at «Обычная» or with nothing to draw; «Кокетливая»'s count of flirty frames; at «Смелая» the
 * bold and flirty frames with the words of the «Смелая» categories that draw any, or what the others do without them. `categories` are the request's.
 */
export function cardLevelCaption(level: SceneLevel, count: number, categories: readonly CategoryRef[]): string | null {
  if (level === "ordinary" || count === 0) return null;
  const frames = levelFrames(count, categories, level);
  const total = countOf(count, ["кадра", "кадров", "кадров"]);
  if (level === "flirty") return frames.flirty === 0 && categories.length > 0 ? FLIRTY_BUILTIN_ONLY : flirtyCaption(frames.flirty, count);
  if (frames.boldCategories.length === 0) return boldWithout(categories);
  // A «Смелая» category that gets photos but no bold frame (one photo): «0 из N» would read as a fault, and no other string fits.
  return frames.bold > 0 ? boldCaption(frames, total) : null;
}

/**
 * Whether the card's run draws Seedream frames: «Смелая» with a «Смелая» category that gets photos (the slow-frames line follows it). Not the bold count: Seedream also
 * draws every «Пляж и бассейн» frame and the flirty satin in «Ночнушки», so a run of one photo with 0 bold frames is still slow.
 */
export function drawsBoldFrames(level: SceneLevel, count: number, categories: readonly CategoryRef[]): boolean {
  return level === "bold" && count > 0 && levelFrames(count, categories, level).boldCategories.length > 0;
}

/** The share «Автопилот» says before its plan has new photos to count: a «Смелая» category's ten frames (as «Кокетливая» says its 6 of 10). */
const SHARE_PHOTOS = 10;

/**
 * «Автопилот»'s «Подача» caption (mockups 30, 52): «Кокетливая» as before; at «Смелая» «≈ {B} из {M} новых кадров — смелые: …; {F} — кокетливые. …», B and F
 * summed per avatar that is not blocked over its new photos; with no plan yet, «≈» the share of a «Смелая» category's ten frames; with no new frame to draw,
 * nothing (no bold frame to speak of).
 */
export function launchLevelCaption(level: SceneLevel, plan: LaunchPlanCounts | null, categories: readonly CategoryRef[]): string | null {
  if (level === "ordinary") return null;
  if (level === "flirty") return launchFlirtyCaption(plan, categories);
  const bolds = categories.filter((ref): ref is BoldCategory => isBoldCategory(ref));
  if (bolds.length === 0) return boldWithout(categories);
  if (plan !== null && plan.totals.toGenerate === 0) return null;
  if (plan === null) {
    const share = levelCountsOf(SHARE_PHOTOS);
    return `≈ ${boldCaption({ bold: share.bold, flirty: share.flirty, boldCategories: bolds }, countOf(SHARE_PHOTOS, ["нового кадра", "новых кадров", "новых кадров"]))}`;
  }
  let bold = 0;
  let flirty = 0;
  for (const avatar of plan.avatars) {
    if (avatar.blocked !== null) continue;
    const frames = levelFrames(avatar.toGenerate, categories, "bold");
    bold += frames.bold;
    flirty += frames.flirty;
  }
  // No bold frame among the new photos (one per avatar): «≈ 0 из N» would read as a fault, and no other string fits.
  if (bold === 0) return null;
  return `≈ ${boldCaption({ bold, flirty, boldCategories: bolds }, countOf(plan.totals.toGenerate, ["нового кадра", "новых кадров", "новых кадров"]))}`;
}

/**
 * «Seedream 2K — до $X за попытку по прайсу» (mockup 47; plan gap C): the most one Seedream attempt costs, the engine's `Estimate.boldAttemptMicros` rounded
 * up. «по прайсу»: P-5a3 was billed about half of it, and the line promises no bill.
 */
export function boldAttemptLine(micros: number): string {
  return `Seedream 2K — до ${formatUsdTiered(micros, "up")} за попытку по прайсу`;
}

// ---------- remembered per avatar ----------

/** «Подача» of each avatar in the viewer's localStorage: `studio.photos.level.<avatarId>` holds «flirty» or «bold»; «Обычная», the default, is not stored. */
export const LEVEL_KEY_PREFIX = "studio.photos.level.";

type LevelStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The avatar's «Подача»: «Кокетливая» or «Смелая» only when it was chosen on this machine; anything else, or a storage that cannot be read, reads «Обычная». */
export function readLevel(storage: LevelStorage | null, avatarId: string): SceneLevel {
  if (storage === null) return "ordinary";
  try {
    const stored = storage.getItem(`${LEVEL_KEY_PREFIX}${avatarId}`);
    return stored === "flirty" || stored === "bold" ? stored : "ordinary";
  } catch {
    return "ordinary";
  }
}

/** Keeps the avatar's «Подача». A storage that throws keeps nothing, silently: the choice holds for this window anyway. */
export function writeLevel(storage: LevelStorage | null, avatarId: string, level: SceneLevel): void {
  if (storage === null) return;
  try {
    if (level === "ordinary") storage.removeItem(`${LEVEL_KEY_PREFIX}${avatarId}`);
    else storage.setItem(`${LEVEL_KEY_PREFIX}${avatarId}`, level);
  } catch {
    // Blocked, full or gone: the choice holds for this window only.
  }
}
