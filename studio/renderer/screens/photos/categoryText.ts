import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX,
  CATEGORY_REASONS_RU,
  CategoryDescription,
  CategoryName,
  categoryNameKey,
  MAX_CUSTOM_CATEGORIES,
  POOL_OUTFITS_MIN,
  POOL_PLACES_MIN,
  POOL_SHOTS,
  type CategoryInterrupted,
  type CategoryPool,
  type CategoryStyle,
  type CategorySummary,
  type EngineError,
  type PoolShot,
  type PoolTime,
} from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { afterColon, countOf, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";

// CS.3: what the create dialog and the «Мои категории» sheet say (the CS.0 artboards: PhotosCS.dc.html, CategoryStates.dc.html), built from
// the contract's own fields. Pure, so every wording is pinned by categoryText.test.ts. Money follows the design's «Деньги на экране»:
// three decimals below $0.10, a ceiling rounded up, an estimate and money spent to the nearest (`formatUsdTiered`).

/** A place's times of day as the sheet and the dialog say them (the pool keeps them in English, as the prompts take them). */
const TIME_RU: Record<PoolTime, string> = {
  morning: "утро",
  midday: "день",
  "golden hour": "золотой час",
  evening: "вечер",
  night: "ночь",
  "studio lighting": "студийный свет",
};

export function timeLabel(time: PoolTime): string {
  return TIME_RU[time];
}

/** Who takes the photo, as the generate card's shot legend names it. */
export const SHOT_LABEL: Record<PoolShot, string> = {
  friend: "Подруга снимает",
  selfie: "Селфи",
  mirror: "Зеркало",
  candid: "Кэндид",
  photographer: "Фотограф",
};

/** The shot deck as the bar and the legend show it: each shot the deck holds, in the legend's order, with its share of the deck. */
export function shotShares(deck: readonly PoolShot[]): { shot: PoolShot; label: string; percent: number }[] {
  return POOL_SHOTS.flatMap((shot) => {
    const n = deck.filter((s) => s === shot).length;
    return n === 0 ? [] : [{ shot, label: SHOT_LABEL[shot], percent: Math.round((n * 100) / deck.length) }];
  });
}

const PLACE_FORMS = ["место", "места", "мест"] as const;
const OUTFIT_FORMS = ["наряд", "наряда", "нарядов"] as const;

/** «6 мест · 4 наряда»: a category's row in the sheet's list. */
export function poolCounts(pool: CategoryPool): string {
  return `${countOf(pool.locations.length, PLACE_FORMS)} · ${countOf(pool.outfits.length, OUTFIT_FORMS)}`;
}

const STYLE_RU: Record<CategoryStyle, string> = { phone: "телефон", editorial: "редакционный" };

/** The line under the shot shares: which finish the deck gives (three photographer shots or more make it editorial, as the photoshoot). */
export function styleNote(style: CategoryStyle): string {
  return style === "phone"
    ? "Стиль «телефон», как у Дома. С тремя кадрами «Фотограф» был бы «редакционный», как у Фотосессии."
    : "Стиль «редакционный», как у Фотосессии: в наборе не меньше трёх кадров «Фотограф».";
}

const SHORT_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

function shortDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : SHORT_DATE.format(time);
}

/**
 * What this window knows of a category's regenerations: none (`created`), at least one that answered (`regenerated`), or only
 * failed ones, which cost but kept the old pool (`retried`).
 */
export type RegenState = "created" | "regenerated" | "retried";

/**
 * The line under a category's name in the sheet: its English label for the model, its style, its day and its whole spend. Segments, which
 * the sheet joins with « · » and never breaks inside (a label is at most 24 characters, so none is too long for a line).
 */
export function categoryMeta(category: CategorySummary, state: RegenState): string[] {
  const day = state === "regenerated" ? `пересоздана ${shortDate(category.updatedAt)}` : `создана ${shortDate(category.createdAt)}`;
  const spent = `${state === "created" ? "потрачено" : "всего потрачено"} ${formatUsdTiered(category.spentMicros, "nearest")}`;
  return [`для модели «${category.label}»`, STYLE_RU[category.style], day, spent];
}

/** The create dialog's line once the category is made: its label, its style, and what this call cost. */
export function createdTime(category: CategorySummary, spentMicros: number): string {
  return `для модели «${category.label}» · ${STYLE_RU[category.style]} · потрачено ${formatUsdTiered(spentMicros, "nearest")}`;
}

const NO_MIRROR_DECK = (pool: CategoryPool): boolean => !pool.shotDeck.includes("mirror");

/** Why the place at `index` cannot be removed (the × is unavailable, this is its title), or null when it can (free). */
export function placeRemoval(pool: CategoryPool, index: number): string | null {
  if (pool.locations.length <= POOL_PLACES_MIN) return `Мест уже ${POOL_PLACES_MIN} — меньше нельзя`;
  const place = pool.locations[index];
  if (place?.mirror === true && !NO_MIRROR_DECK(pool) && pool.locations.filter((l) => l.mirror).length === 1) {
    return "Единственное место с зеркалом — без него не будет кадров в зеркале";
  }
  return null;
}

/** The line under the places: the rule, or why none can go. */
export function placesNote(pool: CategoryPool): string {
  if (pool.locations.length <= POOL_PLACES_MIN) return `Мест уже ${POOL_PLACES_MIN} — меньше нельзя. Пересоздайте категорию, если места не нравятся.`;
  return NO_MIRROR_DECK(pool)
    ? `Убрать место можно, пока их не меньше ${POOL_PLACES_MIN}.`
    : `Убрать место можно, пока их не меньше ${POOL_PLACES_MIN} и есть хотя бы одно с зеркалом — для кадров в зеркале.`;
}

/** The line under the outfits, only when none can go. */
export function outfitsNote(pool: CategoryPool): string | null {
  return pool.outfits.length <= POOL_OUTFITS_MIN ? `Нарядов уже ${POOL_OUTFITS_MIN} — меньше нельзя. Пересоздайте категорию, если наряды не нравятся.` : null;
}

function overLength(length: number, max: number): string {
  return `Не больше ${max} знаков — уберите ${length - max}.`;
}

const HIDDEN_CHARS = "Уберите невидимые и управляющие символы.";

/**
 * What is wrong with a category's name before anything is sent (free; the button waits meanwhile), or null. A blank name is only called
 * out once the field was `touched`. `others` are the library's other categories: names are unique whatever their case and edge spaces.
 */
export function nameProblem(name: string, others: readonly CategorySummary[], touched: boolean): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return touched ? "Введите название." : null;
  if (trimmed.length > CATEGORY_NAME_MAX) return overLength(trimmed.length, CATEGORY_NAME_MAX);
  if (!CategoryName.safeParse(trimmed).success) return HIDDEN_CHARS;
  const key = categoryNameKey(trimmed);
  if (others.some((c) => categoryNameKey(c.name) === key)) return CATEGORY_REASONS_RU["name-taken"];
  return null;
}

/** What is wrong with a description before anything is sent (free), or null. Line breaks are allowed; a blank one only once `touched`. */
export function descriptionProblem(description: string, touched: boolean): string | null {
  if (description.trim().length === 0) return touched ? "Введите описание." : null;
  if (description.length > CATEGORY_DESCRIPTION_MAX) return overLength(description.length, CATEGORY_DESCRIPTION_MAX);
  if (!CategoryDescription.safeParse(description).success) return HIDDEN_CHARS;
  return null;
}

const POOL_REJECTED_TEXT = "Модель дважды вернула неподходящий набор — переформулируйте описание.";
const MODERATION_TEXT = "Модель отказалась составлять набор по этому описанию — переформулируйте его.";
const LIMIT_TEXT = `В библиотеке уже ${MAX_CUSTOM_CATEGORIES} категорий — это предел. Удалите ненужную, потом создайте новую.`;
const NOT_STORED_TEXT = "Набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и создайте категорию снова.";

/**
 * A paid pool that cost money and was not stored: the engine answers INTERNAL with the call's cost (the pool is kept in raw/). A `library-unreadable`
 * refusal that carries a spend is the same case (its own text says nothing was spent, which would be false).
 */
const paidNotStored = (error: EngineError): boolean =>
  (error.code === "INTERNAL" || (error.code === "VALIDATION" && error.categoryReason === "library-unreadable")) && error.spentMicros !== undefined && error.spentMicros > 0;

const spentLine = (error: EngineError, spent: number): string => `${error.code} · потрачено ${formatUsdTiered(spent, "nearest")}`;

/**
 * A failed create, as its dialog says it: the text, the mono line with the code and what the call cost (from the moment it started:
 * `spentMicros`), and where the owner goes to fix it, if anywhere («Мои категории» for the limit, Settings for a folder it cannot write).
 */
export function callFailure(error: EngineError): { text: string; code: string | null; action?: "sheet" | "settings" } {
  const spent = error.spentMicros;
  if (error.code === "POOL_REJECTED") return { text: POOL_REJECTED_TEXT, code: spent === undefined ? null : `${spentLine(error, spent)} — обе попытки учтены` };
  if (error.code === "MODERATION_REFUSED") {
    const why = spent !== undefined && spent > 0 ? "первая попытка, отклонённая проверкой, оплачена" : "отказ на первой попытке не списан";
    return { text: MODERATION_TEXT, code: `${spentLine(error, spent ?? 0)} — ${why}` };
  }
  if (error.code === "VALIDATION" && error.categoryReason === "limit") return { text: LIMIT_TEXT, code: spent !== undefined && spent > 0 ? spentLine(error, spent) : null, action: "sheet" };
  if (paidNotStored(error)) return { text: NOT_STORED_TEXT, code: spentLine(error, spent ?? 0), action: "settings" };
  return { text: errorText(error), code: spent === undefined ? null : spentLine(error, spent) };
}

/**
 * A failed regenerate, in the sheet's box: the old pool stays, what the call cost (`spent`, which the title ends with as «· потрачено $…»
 * in mono; null when nothing is known), why, and the mono line where the design has one.
 */
export function regenFailure(error: EngineError): { title: string; spent: string | null; text: string; code: string | null } {
  const title = "Старый набор остался";
  const spent = error.spentMicros === undefined ? null : formatUsdTiered(error.spentMicros, "nearest");
  if (error.code === "POOL_REJECTED") return { title, spent, text: "Модель дважды вернула неподходящий набор — переформулируйте описание и пересоздайте снова.", code: "POOL_REJECTED · обе попытки учтены" };
  if (error.code === "MODERATION_REFUSED") {
    const paid = (error.spentMicros ?? 0) > 0;
    return { title, spent, text: MODERATION_TEXT, code: paid ? "MODERATION_REFUSED · отказ не списан, оплачена первая попытка" : "MODERATION_REFUSED · отказ на первой попытке не списан" };
  }
  if (paidNotStored(error)) {
    return { title, spent, text: "Новый набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и пересоздайте снова.", code: null };
  }
  return { title, spent, text: errorText(error), code: null };
}

/**
 * The notice under the generate card when the dialog was hidden and the create failed: which category and why, and what it cost (`spent`,
 * which the notice adds as «Потрачено $….» in mono; null when nothing is known).
 */
export function hiddenFailure(name: string, error: EngineError): { text: string; spent: string | null } {
  const reason = error.code === "PRICE_CHANGED" ? "цена выросла, ничего не отправлено — подтвердите новую цену в окне." : callFailure(error).text;
  return { text: `Категория «${name}» не создана: ${afterColon(reason)}`, spent: error.spentMicros === undefined ? null : formatUsdTiered(error.spentMicros, "nearest") };
}

/** What an interrupted call is counted at, as the ledger knows it now. */
function interruptedSpend(call: CategoryInterrupted): string {
  if (call.spentMicros === null || call.openReserveMicros === null) return "Сколько стоил запрос, неизвестно: журнал расходов сейчас не читается.";
  if (call.openReserveMicros > 0) return `Запрос учтён по худшей цене — до ${formatUsdTiered(call.openReserveMicros, "up")} — до сверки расходов.`;
  if (call.spentMicros > 0) return `Запрос учтён: потрачено ${formatUsdTiered(call.spentMicros, "nearest")}.`;
  return "Запрос не успел уйти — ничего не потрачено.";
}

/** A create or a regenerate a closed Studio left unanswered (`categories.list`'s `interrupted`). */
export function interruptedText(call: CategoryInterrupted): { title: string; text: string } {
  return call.kind === "create"
    ? {
        title: "Создание прервано — Studio закрылась",
        text: `Модель составляла набор для «${call.name}», когда Studio закрылась. Категория не создана; описание сохранено. ${interruptedSpend(call)}`,
      }
    : { title: "Пересоздание прервано", text: `Studio закрылась, пока модель составляла новый набор. Старый набор остался. ${interruptedSpend(call)}` };
}

/** How many of the library's 50 places are held: every category file, readable or not (a create is refused at 50). */
export function libraryHeld(list: { readonly categories: readonly unknown[]; readonly unreadable: number; readonly overLimit: number }): number {
  return list.categories.length + list.unreadable + list.overLimit;
}

/** The note at the foot of the sheet's list: files that could not be read are counted, and kept. */
export function unreadableNote(n: number): string {
  return n % 10 === 1 && n % 100 !== 11
    ? `${countOf(n, ["файл", "файла", "файлов"])} категории не читается — он не удалён`
    : `${countOf(n, ["файл", "файла", "файлов"])} категорий не читаются — они не удалены`;
}

/**
 * CS.7 M1: the delete confirm (CatSheetDelete; phase 2, ReviewStates E): what stays, and — only when the open scene set draws `openSetScenes` of its
 * scenes from it — that «Другая сцена» goes for them: a new place cannot be drawn from a deleted category.
 */
export function deleteConfirmText(openSetScenes: number): string {
  const lead = "Фото этой категории останутся в галерее с её названием. Запуски, где она уже есть, не изменятся.";
  if (openSetScenes === 0) return `${lead} Вернуть категорию нельзя.`;
  const one = plural(openSetScenes, ["one", "few", "many"]) === "one";
  const scenes = countOf(openSetScenes, ["сцена", "сцены", "сцен"]);
  return `${lead} В открытом наборе сцен её ${scenes} ${one ? "останется" : "останутся"} как есть, но «Другая сцена» для ${one ? "неё" : "них"} станет недоступна — новое место из удалённой категории не взять. Вернуть категорию нельзя.`;
}

/** CS.7 M1: the create dialog's «готово» line (decision 17): in the run at once, or — a scene set already composed — in the next set. */
export function createdLine(setOpen: boolean): string {
  return setOpen
    ? "Набор сцен уже составлен — категория войдёт в следующий набор. Открытый набор не меняется."
    : "Категория уже включена в запуск. Убрать место или наряд — в «Мои категории».";
}

/** Readable categories past the 50th: the list leaves them out, the disk keeps them, a delete brings one back. */
export function overLimitNote(n: number): string {
  const one = plural(n, ["one", "few", "many"]) === "one";
  return one
    ? `Ещё ${countOf(n, ["категория", "категории", "категорий"])} сверх ${MAX_CUSTOM_CATEGORIES} здесь не показана — она появится, когда вы удалите ненужную.`
    : `Ещё ${countOf(n, ["категория", "категории", "категорий"])} сверх ${MAX_CUSTOM_CATEGORIES} здесь не показаны — они появятся, когда вы удалите ненужные.`;
}
