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
  type ScenePose,
} from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { afterColon, countOf, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { POSE_WORD, posesText } from "./angles";

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

/** The line under the shot shares: the stored style. A new pool is always a phone photo, and the style no longer changes the prompt (S5.1b). */
export function styleNote(style: CategoryStyle): string {
  return style === "phone"
    ? "Стиль «телефон», как у Дома."
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
    : "Категория уже включена в запуск. Убрать место или наряд, поменять ракурсы — в «Мои категории».";
}

// ---------- CS.8b: a category's angles ----------
// README «CS.8 — angles from descriptions», «Copy»: a category whose description names an angle keeps the list (`pool.poses`); its scenes draw from it
// evenly, whatever the card's «Ракурсы» say, and a selfie or a mirror shot that would turn away becomes another shot of its deck.

/** The create form's hint under «Описание»: it names the pose and the angle, so the owner learns they can be set in words. */
export const DESCRIPTION_HINT =
  "Где она бывает, что там делает и в какой позе, во что одета, с какого ракурса снимать («вид сзади», «в профиль»). Модель составит 5–7 мест, 3–6 нарядов и набор кадров. Наряды — только неоткровенные, как во всех категориях.";

/** The regenerate box's hint (CatSheetRegen): the angles are re-read from the new description, and ⟳ in an open set takes the new pool. */
export const REGEN_HINT =
  "Новый набор заменит места, наряды, кадры и ракурсы — ракурсы снова возьмутся из описания; название останется. Составленные сцены и идущие запуски не изменятся; «Другая сцена» возьмёт уже новый.";

/** A regenerate that answered (CatSheetRegenDone): what moved, what stayed, what ⟳ takes now. */
export const REGEN_DONE_TEXT =
  "Ниже — новые места, наряды, кадры и ракурсы. Они идут в следующие наборы и запуски. Уже составленные сцены остались как были; «Другая сцена» в открытом наборе возьмёт новые. Идущий запуск — со старым, у него своя копия.";

/** The sheet's hint for a category with no angles of its own: what the card gives it. */
export const ANGLES_NONE_HINT = "Как в карточке генерации: анфас и три четверти всегда, профиль и со спины — если они включены там.";

/** «× Как в карточке»'s title. */
export const ANGLES_CLEAR_TITLE = "Убрать свои ракурсы — сцены этой категории возьмут их из «Ракурсов» карточки генерации";

/** The design re-check (LOW 2): ⟳ in an open set draws from the category as it is now (README contract note 4), so an angle edit moves it too. */
const ANGLES_OPEN_SET = "Правка меняет и «Другую сцену» в открытом наборе; уже составленные сцены остаются как были.";

/** Who the phone shots of a deck are, as the second sentence names them: subject (with «станет меньше»), and the one with «у неё не будет». */
function phoneWords(phones: readonly PoolShot[]): { fewer: string; none: string } {
  const selfie = phones.includes("selfie");
  const mirror = phones.includes("mirror");
  if (selfie && mirror) return { fewer: "Селфи и кадров в зеркале", none: "Селфи и зеркала" };
  return selfie ? { fewer: "Селфи", none: "Селфи" } : { fewer: "Кадров в зеркале", none: "Зеркала" };
}

/**
 * The second sentence, only when the list holds profile or back (README «CS.8d round 1» M2): the deck's phone shots face the camera, so they keep only the
 * list's front or three-quarter — and there are fewer of them (the design re-check's LOW 1, «селфи станет меньше») — or none at all; and the face gate does not
 * check those angles. Empty without profile or back.
 */
function anglesConsequences(poses: readonly ScenePose[], deck: readonly PoolShot[]): string {
  const away = (["profile", "back"] as const).filter((pose) => poses.includes(pose));
  if (away.length === 0) return "";
  const facing = (["front", "three-quarter"] as const).filter((pose) => poses.includes(pose)).map((pose) => POSE_WORD[pose]);
  const phones = (["selfie", "mirror"] as const).filter((shot) => deck.includes(shot));
  const unchecked = `${away.map((pose) => (pose === "back" ? "со спины" : "в профиль")).join(" и ")} — без проверки сходства.`;
  if (phones.length === 0) return `${unchecked.charAt(0).toUpperCase()}${unchecked.slice(1)}`;
  const words = phoneWords(phones);
  const phone = facing.length > 0 ? `${words.fewer} станет меньше: только ${facing.join(" или ")}` : `${words.none} у неё не будет`;
  return `${phone}; ${unchecked}`;
}

/** The line under a category's angles (the «готово» dialog's note, the sheet's hint): how its scenes draw them, and — only with profile or back — what that costs. */
export function anglesNote(poses: readonly ScenePose[], deck: readonly PoolShot[]): string {
  const what = `${poses.length === 1 ? "Все её сцены — в этом ракурсе" : "Её сцены — поровну в этих ракурсах"}; «Ракурсы» карточки их не касаются.`;
  const consequences = anglesConsequences(poses, deck);
  return consequences === "" ? what : `${what} ${consequences}`;
}

/** The sheet's hint under the chips; `openSetScenes` (the category's scenes in the open set) adds that an edit also moves ⟳ there. */
export function anglesHint(poses: readonly ScenePose[] | undefined, deck: readonly PoolShot[], openSetScenes: number): string {
  const hint = poses === undefined ? ANGLES_NONE_HINT : anglesNote(poses, deck);
  return openSetScenes > 0 ? `${hint} ${ANGLES_OPEN_SET}` : hint;
}

/** The title of a dimmed-on chip (no angles of its own): what the card gives, and what a press does. */
export function impliedChipTitle(pose: "front" | "three-quarter"): string {
  return `Как в карточке: анфас и три четверти всегда. Нажмите — свои ракурсы ${pose === "front" ? "без анфаса" : "без трёх четвертей"}`;
}

/** A save that did not go through: the chip flipped back, and why («Не сохранилось: {причина} — ракурсы остались прежними.»). */
export function anglesSaveFailure(error: EngineError): string {
  return `Не сохранилось: ${afterColon(errorText(error)).replace(/[.\s]+$/u, "")} — ракурсы остались прежними.`;
}

/** Why the chips wait: the category is being regenerated or deleted (the engine would answer IN_FLIGHT). */
export function anglesLockedTitle(why: "regenerate" | "delete"): string {
  return `Пока идёт ${why === "regenerate" ? "пересоздание" : "удаление"}, эту категорию не изменить`;
}

/** A category of the run with angles of its own, as the card's line names it. */
export interface AngleOwner {
  readonly name: string;
  readonly poses: readonly ScenePose[];
}

/** The line under the card's «Ракурсы»: which of the run's categories its toggles do not govern. */
export interface OwnAnglesLine {
  /** The first such category's name. */
  readonly name: string;
  /** Its angles, when it is the only one; with others the line names none. */
  readonly list: string | null;
  /** How many others, behind the «ещё N категорий» button. */
  readonly more: number;
  readonly moreLabel: string;
  /** What the line says on screen, the button's words included. */
  readonly visible: string;
  /** Each category with its angles: the list the button opens. */
  readonly rows: readonly { readonly name: string; readonly list: string }[];
  /** What a screen reader hears instead of the visible line, every category named. */
  readonly full: string;
  readonly title: string;
}

/**
 * README «Copy», «Card line»: one category — «… «{имя}» — у неё свои ракурсы: {список}.»; several — «… «{имя}» и [ещё N категорий] — у них свои ракурсы.»,
 * the button opening every category with its angles. The message comes first, so an ellipsis never cuts the point; a screen reader hears every name.
 */
export function ownAnglesLine(owners: readonly AngleOwner[]): OwnAnglesLine | null {
  const [first] = owners;
  if (first === undefined) return null;
  const rows = owners.map((owner) => ({ name: owner.name, list: posesText(owner.poses) }));
  const more = owners.length - 1;
  const moreLabel = more === 0 ? "" : `ещё ${countOf(more, ["категории", "категорий", "категорий"])}`;
  const lead = `Эти переключатели не касаются «${first.name}»`;
  const list = more === 0 ? posesText(first.poses) : null;
  return {
    name: first.name,
    list,
    more,
    moreLabel,
    visible: list !== null ? `${lead} — у неё свои ракурсы: ${list}.` : `${lead} и ${moreLabel} — у них свои ракурсы.`,
    rows,
    full: `Эти переключатели не касаются категорий со своими ракурсами: ${rows.map((row) => `«${row.name}» — ${row.list}`).join("; ")}.`,
    title: `Свои ракурсы — ${rows.map((row) => `${row.name}: ${row.list}`).join("; ")}`,
  };
}

/** Readable categories past the 50th: the list leaves them out, the disk keeps them, a delete brings one back. */
export function overLimitNote(n: number): string {
  const one = plural(n, ["one", "few", "many"]) === "one";
  return one
    ? `Ещё ${countOf(n, ["категория", "категории", "категорий"])} сверх ${MAX_CUSTOM_CATEGORIES} здесь не показана — она появится, когда вы удалите ненужную.`
    : `Ещё ${countOf(n, ["категория", "категории", "категорий"])} сверх ${MAX_CUSTOM_CATEGORIES} здесь не показаны — они появятся, когда вы удалите ненужные.`;
}
