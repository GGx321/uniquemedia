import { impliedNudityOf, isCustomCategory, splitCount, type CategoryRef, type CategorySummary, type LegsShare, type SceneLevel } from "../../../shared/engine";
import { flirtyCountOf, levelCountsOf, tierSpreadOf } from "../../../shared/scenes/level";
import { countOf } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { captionWordsOf, clothingText, drawsLingerie, impliedText, placesText } from "./captionWords";
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

/** The tiers of a run, and the categories that draw any photo of it at «Смелая». */
export interface LevelFrames {
  /** «Смелая»'s most revealing frames (0 below «Смелая»). */
  readonly bold: number;
  readonly flirty: number;
  /** The plain frames of a «Смелая» run (0 below «Смелая», where this card does not count them). */
  readonly ordinary: number;
  /** At «Смелая», every category the split gives a photo, in the run's order (any category draws «Смелая», r2.2); empty at the other levels. */
  readonly drawing: readonly CategoryRef[];
}

/**
 * How `count` photos over `categories` divide at `level`, by the planner's own rules over the planner's own split (`splitCount`). At «Смелая» (5a.4, r2.2 D1) the tiers are counted over the
 * whole request and spread over its categories, `tierSpreadOf` (8 / 8 / 4 of 20), the very function the planner and the mock call; every category draws, a custom one too. At «Кокетливая»
 * each built-in category's `flirtyCountOf`, a custom category staying ordinary. Nothing is counted here that the shared rules do not count.
 */
export function levelFrames(count: number, categories: readonly CategoryRef[], level: SceneLevel): LevelFrames {
  if (level === "ordinary" || categories.length === 0) return { bold: 0, flirty: 0, ordinary: 0, drawing: [] };
  const split = splitCount(count, categories);
  if (level === "bold") {
    const parts = tierSpreadOf(split);
    return {
      bold: parts.reduce((sum, part) => sum + part.bold, 0),
      flirty: parts.reduce((sum, part) => sum + part.flirty, 0),
      ordinary: parts.reduce((sum, part) => sum + part.ordinary, 0),
      drawing: split.filter(({ count: n }) => n > 0).map(({ ref }) => ref),
    };
  }
  let flirty = 0;
  for (const { ref, count: n } of split) {
    if (!isCustomCategory(ref)) flirty += flirtyCountOf(n, "flirty");
  }
  return { bold: 0, flirty, ordinary: 0, drawing: [] };
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

/** Where the model is named: its words joined by non-breaking spaces (§5.9). */
const MODEL_NAME = "Seedream 5 Pro · 2K";

/** The line under «Тип кадра» at «Смелая» (§5.9 row 23; mockup 65): Seedream draws every «Смелая» frame in 2K (Q-A2), whatever the settings' image model. */
export const BOLD_SHOT_LINE = `${MODEL_NAME} · 9:16 · референс — мастер-портрет`;

/** What an avatar made from a photo cannot be drawn with, and what its prompt says instead (r2.4 N3): one wording on the card and in «Автопилот». */
const IMPORTED_TAIL = "без простыни, полотенца и пены; в промпте бельё плотное.";

/** What the card needs of the run beyond its categories: the avatar's origin (the cover clause is a Studio-created avatar's only), «Ножки» and the library's own categories. */
export interface CardCaptionContext {
  /** The run's avatar; null while it cannot be read (the imported side, fail-closed, I5.74). */
  readonly avatar: { readonly name?: string; readonly origin?: unknown } | null;
  readonly legs: LegsShare;
  readonly customs: readonly CategorySummary[];
}

/** What «Автопилот» needs: the avatars the launch is for (in the order they were picked), «Ножки» and the library's own categories. */
export interface LaunchCaptionContext {
  readonly avatars: readonly { readonly name: string; readonly origin?: unknown }[];
  readonly legs: LegsShare;
  readonly customs: readonly CategorySummary[];
}

/** A sentence's first letter, capitalised. */
const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** «откровеннее всего — 8, кокетливо — 8, скромнее — 4», a tier whose count is 0 left out; «≈» in place of the dash for «Автопилот». */
function tiersText(frames: { readonly bold: number; readonly flirty: number; readonly ordinary: number }, sign: "—" | "≈"): string {
  const tiers: readonly (readonly [string, number])[] = [
    ["откровеннее всего", frames.bold],
    ["кокетливо", frames.flirty],
    ["скромнее", frames.ordinary],
  ];
  return tiers
    .filter(([, n]) => n !== 0)
    .map(([label, n]) => `${label} ${sign} ${n}`)
    .join(", ");
}

interface BoldCaptionInput {
  /** «Все 20 кадров», «Кадр», «Новые кадры»: what the caption is about. */
  readonly lead: string;
  /** The sentence about the tiers, without its full stop and in its final case («Откровеннее всего — 8, …», «Из каждых 10: откровеннее всего ≈ 4, …»). */
  readonly tiers: string;
  readonly categories: readonly CategoryRef[];
  readonly context: { readonly legs: LegsShare; readonly customs: readonly CategorySummary[] };
  /** Whether a Studio-created avatar is in the run: only then can a frame be a sheet, a towel or foam (r2.3 M2). */
  readonly studio: boolean;
  /** One frame: «Рисует его», not «Рисует их». */
  readonly single: boolean;
}

/** §5.9 rows 1, 19, 19a: «{lead} — {одежда}{; часть смелых — …}. {tiers}. Места — {места}. Рисует их Seedream 5 Pro · 2K.»; null when the categories have nothing to say. */
function boldCaption(input: BoldCaptionInput): string | null {
  const words = captionWordsOf(input.categories, input.context);
  if (words.clothing.length === 0) return null;
  const clause = input.studio ? impliedText(words.implied) : null;
  const places = placesText(words.places);
  return [
    `${input.lead} — ${clothingText(words.clothing)}${clause === null ? "" : `; часть смелых — ${clause}`}.`,
    `${input.tiers}.`,
    ...(places === null ? [] : [`Места — ${places}.`]),
    `${input.single ? "Рисует его" : "Рисует их"} ${MODEL_NAME}.`,
  ].join(" ");
}

/**
 * The card's «Подача» caption (§5.9 row 1; mockups 25, 47): none at «Обычная» or with nothing to draw; «Кокетливая»'s count of flirty frames; at «Смелая» what every category of the request
 * draws — the clothing, the cover clause for a Studio-created avatar, the tiers over the whole request, the places — all read from the bank data. `categories` are the request's.
 */
export function cardLevelCaption(level: SceneLevel, count: number, categories: readonly CategoryRef[], context: CardCaptionContext): string | null {
  if (level === "ordinary" || count === 0) return null;
  const frames = levelFrames(count, categories, level);
  if (level === "flirty") return frames.flirty === 0 && categories.length > 0 ? FLIRTY_BUILTIN_ONLY : flirtyCaption(frames.flirty, count);
  if (frames.drawing.length === 0) return null;
  return boldCaption({
    lead: count === 1 ? "Кадр" : `Все ${countOf(count, ["кадр", "кадра", "кадров"])}`,
    tiers: capitalised(tiersText(frames, "—")),
    categories: frames.drawing,
    context,
    studio: impliedNudityOf(context.avatar),
    single: count === 1,
  });
}

/** The card's line of its own for an avatar made from a photo (§5.9 row 2, r2.4 N2, N3): «Аватар из фото — …», only at «Смелая» and only when a chosen category draws lingerie or a cover. */
export function cardImportedLine(level: SceneLevel, count: number, categories: readonly CategoryRef[], context: CardCaptionContext): string | null {
  if (level !== "bold" || count === 0 || impliedNudityOf(context.avatar)) return null;
  return drawsLingerie(levelFrames(count, categories, level).drawing, context.customs) ? `Аватар из фото — ${IMPORTED_TAIL}` : null;
}

/**
 * Whether the card's run draws Seedream frames: «Смелая» with any category that gets a photo (the slow-frames line follows it): every «Смелая» frame is Seedream (5a.4, r2.2). Not the
 * bold count: a run of one photo with 0 bold frames is still slow.
 */
export function drawsBoldFrames(level: SceneLevel, count: number, categories: readonly CategoryRef[]): boolean {
  return level === "bold" && count > 0 && levelFrames(count, categories, level).drawing.length > 0;
}

/** The new frames «Автопилот» says the share of before its plan has any to count: ten (as «Кокетливая» says its 6 of 10). */
const SHARE_PHOTOS = 10;

/**
 * «Автопилот»'s «Подача» caption (§5.9 rows 19, 19a; mockups 30, 52, 67): «Кокетливая» as before; at «Смелая» «Все {N} новых кадров — {одежда}…. Откровеннее всего ≈ {B}, кокетливо ≈ {F},
 * скромнее ≈ {O}. …», the tiers summed per avatar that is not blocked over its new photos (each avatar's compose is one request, r2.2 D1); with no plan yet, «Новые кадры — … Из каждых 10: …»;
 * with no new frame to draw, nothing. The cover clause is there only if a Studio-created avatar is in the launch (r2.3 M2).
 */
export function launchLevelCaption(level: SceneLevel, plan: LaunchPlanCounts | null, categories: readonly CategoryRef[], context: LaunchCaptionContext): string | null {
  if (level === "ordinary") return null;
  if (level === "flirty") return launchFlirtyCaption(plan, categories);
  if (categories.length === 0) return null;
  const studio = context.avatars.some((avatar) => impliedNudityOf(avatar));
  if (plan === null) {
    return boldCaption({ lead: "Новые кадры", tiers: `Из каждых ${SHARE_PHOTOS}: ${tiersText(levelCountsOf(SHARE_PHOTOS), "≈")}`, categories, context, studio, single: false });
  }
  const total = plan.totals.toGenerate;
  if (total === 0) return null;
  const sum = { bold: 0, flirty: 0, ordinary: 0 };
  const drawing = new Set<CategoryRef>();
  for (const avatar of plan.avatars) {
    if (avatar.blocked !== null) continue;
    const frames = levelFrames(avatar.toGenerate, categories, "bold");
    sum.bold += frames.bold;
    sum.flirty += frames.flirty;
    sum.ordinary += frames.ordinary;
    for (const ref of frames.drawing) drawing.add(ref);
  }
  return boldCaption({
    lead: total === 1 ? "Новый кадр" : `Все ${countOf(total, ["новый кадр", "новых кадра", "новых кадров"])}`,
    tiers: capitalised(tiersText(sum, "≈")),
    categories: categories.filter((ref) => drawing.has(ref)),
    context,
    studio,
    single: total === 1,
  });
}

/** «Автопилот»'s line for the avatars made from a photo (§5.9 row 19b, r2.4 N2, N3): «Аватар из фото (Bea) — …», «Аватары из фото (Bea, Cleo) — …»; not shown when «Пляж и бассейн» is the only category. */
export function launchImportedLine(level: SceneLevel, categories: readonly CategoryRef[], avatars: LaunchCaptionContext["avatars"], customs: readonly CategorySummary[]): string | null {
  if (level !== "bold" || !drawsLingerie(categories, customs)) return null;
  const names = avatars.filter((avatar) => !impliedNudityOf(avatar)).map((avatar) => avatar.name);
  if (names.length === 0) return null;
  return `${names.length === 1 ? "Аватар" : "Аватары"} из фото (${names.join(", ")}) — ${IMPORTED_TAIL}`;
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
