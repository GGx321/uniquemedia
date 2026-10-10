import { formatUsd, formatUsdTiered } from "../../lib/money";
import { countOf, NBSP, plural } from "../../lib/format";
import type { SettingsFocus } from "../../navigation";
import { isFree, limitUsd } from "./launchMoney";
import type { LaunchPreview, LaunchPreviewAvatar, LaunchStatus, LaunchView, MonthFit } from "../../../shared/engine";

// S4.9a: the «Автопилот» plan card and the avatar rows worded from the engine's own figures (AutopilotS4.dc.html, LaunchStates «Бюджет месяца», «Почему не
// собрать», «Музыка»). The renderer computes no money (plan §4.2): every sum here is `autopilot.estimate`'s, only formatted («Деньги на экране»: below $0.10
// three decimals, a ceiling rounded up, an estimate to the nearest) and laid on the month's bar.

const MB = 1_000_000;
const GB = 1_000_000_000;

/** «до $4.14»: a ceiling, rounded up. */
export const ceilingUsd = (micros: number): string => formatUsdTiered(micros, "up");
/** «≈ $1.34»: an estimate, to the nearest. */
export const aboutUsd = (micros: number): string => `≈ ${formatUsdTiered(micros, "nearest")}`;
/** «$8.36»: what is left (the month's room, a balance), rounded down: never overstated. */
export const leftUsd = (micros: number): string => formatUsdTiered(micros, "down");
/** «$21»: a sum the engine answered in whole dollars (the raise of the budget), said without its cents. */
export const wholeUsd = (micros: number): string => {
  const text = formatUsd(micros);
  return text.endsWith(".00") ? text.slice(0, -3) : text;
};

// ---------- the tiles ----------

export type TileTone = "text" | "ok" | "acc" | "warn" | "faint";

export interface PlanTile {
  readonly label: string;
  readonly value: string;
  readonly tone: TileTone;
}

const DASH = "—";

/** The avatars the plan counts: blocked ones count for nothing (the contract's totals). */
export function countedAvatars(preview: LaunchPreview): LaunchPreviewAvatar[] {
  return preview.avatars.filter((a) => a.blocked === null);
}

/**
 * The preview whose figures the card shows, or null when every chosen avatar is blocked: its totals are then all zero, and «0 видео · бесплатно» would read
 * as a launch that costs nothing rather than one that cannot be built. The tiles show dashes and the button plain «Запустить» instead; the blockers say why.
 */
export function figuresOf(preview: LaunchPreview | null): LaunchPreview | null {
  return preview !== null && countedAvatars(preview).length > 0 ? preview : null;
}

/** «≈ 12 мин», «≈ 1 ч 05 мин»: the engine's time estimate, in whole minutes rounded up. */
export function timeLabel(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `≈ ${minutes}${NBSP}мин`;
  const rest = minutes % 60;
  const hours = (minutes - rest) / 60;
  return rest === 0 ? `≈ ${hours}${NBSP}ч` : `≈ ${hours}${NBSP}ч ${String(rest).padStart(2, "0")}${NBSP}мин`;
}

/**
 * The six tiles (Видео, Нужно фото, Из библиотеки, Сгенерировать, Ожидаемая, Время). «Видео» reads «12 из 30» in amber when the library cannot fill every
 * video of the avatars that count; without a preview every tile is a dash.
 */
export function planTiles(preview: LaunchPreview | null, videosPerAvatar: number): PlanTile[] {
  if (preview === null) {
    return ["Видео", "Нужно фото", "Из библиотеки", "Сгенерировать", "Ожидаемая", "Время"].map((label) => ({ label, value: DASH, tone: "faint" }));
  }
  const { totals, estimate } = preview;
  const planned = countedAvatars(preview).length * videosPerAvatar;
  const short = totals.videos < planned;
  return [
    { label: "Видео", value: short ? `${totals.videos} из ${planned}` : String(totals.videos), tone: short ? "warn" : "text" },
    { label: "Нужно фото", value: String(totals.photosNeeded), tone: "text" },
    { label: "Из библиотеки", value: String(totals.fromLibrary), tone: "ok" },
    { label: "Сгенерировать", value: String(totals.toGenerate), tone: totals.toGenerate > 0 ? "acc" : "faint" },
    { label: "Ожидаемая", value: estimate.expectedMicros > 0 ? aboutUsd(estimate.expectedMicros) : "$0", tone: "text" },
    { label: "Время", value: timeLabel(preview.timeSeconds), tone: "text" },
  ];
}

/** Where the prices came from: the live list, or the dated fallback table. */
export function priceSourceLabel(preview: LaunchPreview | null): { text: string; fallback: boolean } {
  if (preview === null) return { text: "цены OpenRouter", fallback: false };
  if (preview.estimate.prices === "live") return { text: "цены OpenRouter · сейчас", fallback: false };
  const day = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(`${preview.estimate.pricesAsOf}T00:00:00Z`));
  return { text: `резервные цены · ${day}`, fallback: true };
}

// ---------- the month ----------

export interface MonthMeter {
  readonly fit: MonthFit;
  /** «$8.36»: the room left this month, rounded down. */
  readonly free: string;
  readonly budget: string;
  readonly used: string;
  readonly expected: string;
  readonly worst: string;
  /** Percent of the month's budget: committed already, the launch's expected cost after it, the hatch up to its worst case. */
  readonly usedPct: number;
  readonly expectedPct: number;
  readonly worstLeftPct: number;
  readonly worstPct: number;
  /** The worst case runs past the budget: a mark on the bar's edge. */
  readonly over: boolean;
  readonly label: string;
}

const pctOf = (micros: number, budget: number): number => (budget <= 0 ? (micros > 0 ? 100 : 0) : Math.max(0, Math.min(100, (micros / budget) * 100)));
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * The month's bar (the design's decision 5): the whole bar is the month's budget; grey is what is committed already, solid the launch's expected cost, the
 * hatch its worst case. Null when the launch pays for nothing (no new photos): there is nothing to fit.
 */
export function monthMeter(preview: LaunchPreview | null): MonthMeter | null {
  if (preview === null || preview.estimate.worstMicros === 0) return null;
  const { budgetMicros, committedMicros, freeMicros, fit } = preview.month;
  const { expectedMicros, worstMicros } = preview.estimate;
  const used = pctOf(committedMicros, budgetMicros);
  const afterExpected = pctOf(committedMicros + expectedMicros, budgetMicros);
  const expectedPct = Math.min(pctOf(expectedMicros, budgetMicros), 100 - used);
  const worstPct = Math.max(0, Math.min(pctOf(Math.max(0, worstMicros - expectedMicros), budgetMicros), 100 - afterExpected));
  const budget = formatUsdTiered(budgetMicros, "nearest");
  const committed = formatUsdTiered(committedMicros, "nearest");
  return {
    fit,
    free: leftUsd(freeMicros),
    budget,
    used: committed,
    expected: formatUsdTiered(expectedMicros, "nearest"),
    worst: ceilingUsd(worstMicros),
    usedPct: round1(used),
    expectedPct: round1(expectedPct),
    worstLeftPct: round1(Math.min(100, afterExpected)),
    worstPct: round1(worstPct),
    over: fit !== "fits",
    label: `Месячный бюджет ${budget}: занято ${committed}, ожидаемая цена запуска ${formatUsdTiered(expectedMicros, "nearest")}, предел ${ceilingUsd(worstMicros)}`,
  };
}

// ---------- the notes over «Запустить» ----------

/** Where a note's link goes: a Settings card, or an avatar's «Фото». */
export type NoteLink = { readonly kind: "settings"; readonly focus: SettingsFocus; readonly label: string } | { readonly kind: "photos"; readonly avatarId: string; readonly label: string };

/** A sentence with at most one link inside it. */
export interface NoteText {
  readonly before: string;
  readonly link: NoteLink | null;
  readonly after: string;
}

export interface NoteItem extends NoteText {
  /** The avatar the line is about, in bold before it; null for a line about the launch. */
  readonly name: string | null;
}

export type NoteTone = "warn" | "danger" | "info";

export interface PlanNote {
  /** Stable among the notes: React's key and the tests' handle. */
  readonly id: string;
  readonly tone: NoteTone;
  readonly title: string | null;
  readonly text: NoteText | null;
  readonly items: readonly NoteItem[];
}

const plain = (before: string): NoteText => ({ before, link: null, after: "" });

export interface NotesInput {
  readonly preview: LaunchPreview | null;
  readonly videosPerAvatar: number;
  readonly generate: boolean;
  readonly nameOf: (avatarId: string) => string;
}

const AVATAR_BLOCKERS = new Set(["open-set", "too-many-photos", "usage-unknown"]);

/** The lines of «Запуск не собрать»: one per blocked avatar, then an unreadable launch entry. */
function blockerItems(preview: LaunchPreview, nameOf: (avatarId: string) => string): NoteItem[] {
  const items: NoteItem[] = [];
  for (const avatar of preview.avatars) {
    const name = nameOf(avatar.avatarId);
    if (avatar.blocked === "open-set") items.push({ name, before: ": открыт набор сцен — завершите или удалите его на ", link: { kind: "photos", avatarId: avatar.avatarId, label: "«Фото»" }, after: "." });
    if (avatar.blocked === "too-many-photos") items.push({ name, ...plain(`: нужно ${avatar.toGenerate} новых фото, больше 100 за запуск нельзя — уменьшите слайды или число видео.`) });
    if (avatar.blocked === "usage-unknown") items.push({ name, ...plain(`: не читается, какие её фото заняты, — из библиотеки её не собрать. Уберите ${name} из запуска.`) });
  }
  if (preview.blockers.some((b) => b.code === "launch-unreadable")) items.push({ name: null, ...plain("Одна запись запуска не читается — уберите её в «Истории запусков».") });
  return items;
}

/** Whether the launch has blockers of its avatars (or an unreadable entry), which the plan card lists. */
export function hasListedBlockers(preview: LaunchPreview): boolean {
  return preview.blockers.some((b) => AVATAR_BLOCKERS.has(b.code) || b.code === "launch-unreadable");
}

/**
 * The notes over «Запустить», most pressing first: what blocks the launch (a list), the month («Хватит, если без повторов» or «Бюджета не хватит»), the
 * OpenRouter balance, the library falling short with generation off, the music, and a chosen avatar that is busy. Warnings never close the launch; the
 * budget notes give way to a list of blockers, as on the design's sheets.
 */
export function planNotes({ preview, videosPerAvatar, generate, nameOf }: NotesInput): PlanNote[] {
  if (preview === null) return [];
  const notes: PlanNote[] = [];
  const items = blockerItems(preview, nameOf);
  if (items.length > 0) {
    const onlyTooMany = preview.avatars.every((a) => a.blocked === null || a.blocked === "too-many-photos") && !preview.blockers.some((b) => b.code === "launch-unreadable");
    notes.push({ id: "blocked", tone: "danger", title: onlyTooMany ? "Больше 100 новых фото на аватара" : "Запуск не собрать", text: null, items });
  }
  const paid = preview.estimate.worstMicros > 0;
  if (items.length === 0 && paid && preview.month.fit === "fits-expected") {
    // The raise is the engine's (`month.raiseToMicros`, ⌈W − R + B⌉ in whole dollars): the window only says it.
    const raise = preview.month.raiseToMicros;
    notes.push({
      id: "fits-expected",
      tone: "warn",
      title: "Хватит, если без повторов",
      text: {
        before: "При неудачах запуск встанет на паузу по бюджету. Чтобы такого не было, ",
        link: { kind: "settings", focus: "money", label: raise === null ? "поднимите бюджет" : `поднимите бюджет до ${wholeUsd(raise)}` },
        after: ".",
      },
      items: [],
    });
  }
  if (items.length === 0 && paid && preview.month.fit === "short") {
    notes.push({
      id: "short",
      tone: "danger",
      title: "Бюджета не хватит",
      text: {
        before: `Не хватит даже на ожидаемую цену: свободно ${leftUsd(preview.month.freeMicros)}, нужно ${aboutUsd(preview.estimate.expectedMicros)}. Уменьшите число видео или `,
        link: { kind: "settings", focus: "money", label: "поднимите бюджет" },
        after: ".",
      },
      items: [],
    });
  }
  if (paid && preview.balance !== null && preview.balance.micros < preview.estimate.worstMicros) {
    notes.push({
      id: "balance",
      tone: "info",
      title: null,
      text: plain(`На балансе OpenRouter ${leftUsd(preview.balance.micros)} — меньше предела запуска ${ceilingUsd(preview.estimate.worstMicros)}. При нехватке запуск встанет на паузу.`),
      items: [],
    });
  }
  const shortOf = countedAvatars(preview).filter((a) => a.videos < videosPerAvatar);
  if (!generate && shortOf.length > 0) {
    const planned = countedAvatars(preview).length * videosPerAvatar;
    notes.push({
      id: "library-short",
      tone: "warn",
      title: `Видео: ${preview.totals.videos} из ${planned} — не хватает фото`,
      text: null,
      items: shortOf.map((a) => ({
        name: nameOf(a.avatarId),
        ...plain(a.free > 0 ? `: ${a.videos} из ${videosPerAvatar} — свободных фото в этих категориях ${a.free}.` : `: 0 из ${videosPerAvatar} — свободных фото нет. Включите «Догенерировать».`),
      })),
    });
  }
  if (preview.totals.videos > 0 && preview.music.candidates === 0 && preview.music.autoRefresh !== "will") {
    notes.push({
      id: "music",
      tone: "warn",
      title: "Подходящей музыки нет — видео будут ждать",
      text: { before: "Обновите тренды в ", link: { kind: "settings", focus: "music", label: "Настройках" }, after: " или отметьте свои треки «для автопилота»." },
      items: [],
    });
  }
  const busy = countedAvatars(preview).filter((a) => a.busy);
  if (busy.length > 0) {
    const names = busy.map((a) => nameOf(a.avatarId)).join(", ");
    notes.push({
      id: "busy",
      tone: "info",
      title: null,
      text: plain(
        busy.length === 1
          ? `${names} занята вашей генерацией на «Фото». Запуск начнёт её, когда генерация закончится.`
          : `${names} заняты вашей генерацией на «Фото». Запуск начнёт каждую, когда её генерация закончится.`,
      ),
      items: [],
    });
  }
  return notes;
}

// ---------- «Запустить» ----------

/** Why «Запустить» is closed, one line under it (the design's «почему»): the first that applies, in this order. */
export const GO_WHY = {
  noAvatars: "Нет активных аватаров — создайте первого на экране «Аватары».",
  noneChosen: "Выберите хотя бы одного аватара.",
  noCategory: "Выберите хотя бы одну категорию.",
  nothingEnabled: "Включите хотя бы одно: свободные фото или догенерацию.",
  launchActive: "Уже идёт запуск — новый можно после «Стоп» или конца этого.",
  blocked: "Сначала уберите причины выше. Пока они есть, запуск не начнётся и ничего не потратит.",
  tooMany: "Один набор сцен на аватара за запуск — до 100 сцен.",
  noKey: "Нужен рабочий ключ OpenRouter — добавьте его в Настройках. Или выключите «Догенерировать»: видео соберутся из библиотеки бесплатно.",
  reconcile: "Сначала сверка: в журнале остались запросы прошлого запуска Studio.",
  halt: "Расходы остановлены — нужна сверка в Настройках.",
  ledger: "Журнал расходов не читается — откройте деньги в Настройках.",
  export: "Папка «Готовые видео» недоступна — выберите её в Настройках.",
  noVideos: "Собрать нечего: в выбранных категориях нет свободных фото. Включите «Догенерировать» или выберите другие категории.",
  short: "Свободного бюджета в этом месяце меньше ожидаемой цены.",
} as const;

export interface GoInput {
  readonly activeCount: number;
  readonly chosen: number;
  readonly categories: number;
  readonly library: boolean;
  readonly generate: boolean;
  /** The preview of exactly the current form, or null while it is asked (or when there is nothing to ask). */
  readonly preview: LaunchPreview | null;
}

/** The first reason «Запустить» is closed, or null when it is open. */
export function goWhy({ activeCount, chosen, categories, library, generate, preview }: GoInput): string | null {
  if (activeCount === 0) return GO_WHY.noAvatars;
  if (chosen === 0) return GO_WHY.noneChosen;
  if (categories === 0) return GO_WHY.noCategory;
  if (!library && !generate) return GO_WHY.nothingEnabled;
  if (preview === null) return null;
  const has = (code: string): boolean => preview.blockers.some((b) => b.code === code);
  if (has("nothing-enabled")) return GO_WHY.nothingEnabled;
  if (has("launch-active")) return GO_WHY.launchActive;
  if (hasListedBlockers(preview)) {
    const onlyTooMany = !has("launch-unreadable") && preview.avatars.every((a) => a.blocked === null || a.blocked === "too-many-photos");
    return onlyTooMany ? GO_WHY.tooMany : GO_WHY.blocked;
  }
  if (has("no-key")) return GO_WHY.noKey;
  if (has("reconcile-required")) return GO_WHY.reconcile;
  if (has("halt")) return GO_WHY.halt;
  if (has("ledger")) return GO_WHY.ledger;
  if (has("export-unavailable")) return GO_WHY.export;
  if (preview.totals.videos === 0) return GO_WHY.noVideos;
  if (preview.estimate.worstMicros > 0 && preview.month.fit === "short") return GO_WHY.short;
  return null;
}

/** «Запустить: 30 видео · до $4.14», «Запустить: 12 видео · бесплатно», or «Запустить» while there is no plan. */
export function goTitle(preview: LaunchPreview | null): string {
  if (preview === null) return "Запустить";
  const price = preview.estimate.worstMicros > 0 ? `до ${ceilingUsd(preview.estimate.worstMicros)}` : "бесплатно";
  return `Запустить: ${preview.totals.videos}${NBSP}видео · ${price}`;
}

/** «Предел запуска» in the settings column: the plan's worst case, «бесплатно» with nothing to pay, a dash with no plan. */
export function limitText(worstMicros: number | null): string {
  if (worstMicros === null) return DASH;
  return worstMicros > 0 ? `до ${ceilingUsd(worstMicros)}` : "бесплатно";
}

// ---------- the music and the disk ----------

const TRACK_FORMS = ["трек", "трека", "треков"] as const;

export interface MusicLine {
  readonly chip: string;
  readonly sub: string;
  readonly warn: boolean;
}

/** The «Музыка» row: the chip counts the candidates (trends without E and own tracks marked «для автопилота»), the line under it says how the trends refresh. */
export function musicLine(music: LaunchPreview["music"] | null, refreshing = false): MusicLine {
  if (music === null) return { chip: "Тренды + мои", sub: "тренды и свои треки с отметкой «для автопилота»", warn: false };
  const chip = `Тренды + мои · ${countOf(music.candidates, TRACK_FORMS)}`;
  // A refresh is running now (the music status says so; the plan was asked before it began or while it ran): its tracks are on the way, so the list is neither «свежие» nor a warning.
  if (refreshing) return { chip, sub: "тренды обновляются…", warn: false };
  const left = music.quotaRemaining === null ? "" : ` — осталось ${music.quotaRemaining} из 30`;
  switch (music.autoRefresh) {
    case "will":
      return { chip, sub: `обновим тренды при запуске${left}`, warn: false };
    case "not-needed":
      return { chip, sub: "тренды свежие — обновлять не нужно", warn: false };
    case "no-quota":
      return { chip, sub: `тренды не обновим сами${music.quotaRemaining === null ? "" : `: осталось ${music.quotaRemaining} из 30`} — бережём для вас`, warn: true };
    case "no-key":
      return { chip, sub: "нет ключа музыки — тренды не обновить", warn: true };
  }
}

const bytesLabel = (bytes: number, round: "up" | "down"): string => {
  const step = round === "up" ? Math.ceil : Math.floor;
  if (bytes < GB) return `${step(bytes / MB)}${NBSP}МБ`;
  const tenths = step((bytes * 10) / GB);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}${NBSP}ГБ`;
};

/** «Диск: нужно ≈ 140 МБ · свободно 212 ГБ»; `short` when the folder has less room than the videos need. */
export function diskLine(disk: LaunchPreview["disk"]): { text: string; short: boolean } {
  const need = `Диск: нужно ≈ ${bytesLabel(disk.neededBytes, "up")}`;
  if (disk.freeBytes === null) return { text: need, short: false };
  return { text: `${need} · свободно ${bytesLabel(disk.freeBytes, "down")}`, short: disk.freeBytes < disk.neededBytes };
}

// ---------- the avatar rows ----------

export interface AvatarRowTag {
  readonly text: string;
  readonly tone: "warn" | "danger";
  readonly title: string;
}

export interface AvatarRowFacts {
  /** «31 своб.», «— своб.» when the avatar's usage cannot be read, or null when nothing is known yet. */
  readonly free: string | null;
  /** The count in red: no free photo, or none that can be trusted (ApPlanBlocked's «— своб.»). */
  readonly freeWarn: boolean;
  readonly tag: AvatarRowTag | null;
}

/**
 * One row of the avatar list. `planned` is the avatar's line of the current plan (a chosen avatar), `probed` its line of the free-photo probe (every active
 * avatar): the plan's own words win, so a chosen avatar's tag says why it will not go («набор сцен», «> 100 фото») before why it waits («занята»).
 */
export function avatarRow(name: string, planned: LaunchPreviewAvatar | undefined, probed: LaunchPreviewAvatar | undefined): AvatarRowFacts {
  const row = planned ?? probed;
  if (row === undefined) return { free: null, freeWarn: false, tag: null };
  const unknown = row.usage.state !== "ok";
  const free = unknown ? "— своб." : `${row.free} своб.`;
  const base = { free, freeWarn: unknown || row.free === 0 };
  if (planned?.blocked === "open-set") return { ...base, tag: { text: "набор сцен", tone: "warn", title: "Открыт набор сцен — завершите или удалите его на «Фото»" } };
  if (planned?.blocked === "too-many-photos") return { ...base, tag: { text: "> 100 фото", tone: "danger", title: `Нужно ${planned.toGenerate} новых фото — больше 100 за запуск нельзя` } };
  if (unknown) return { ...base, tag: { text: "нет данных", tone: "warn", title: `Не читается, какие фото ${name} заняты` } };
  if (row.busy) return { ...base, tag: { text: "занята", tone: "warn", title: "Идёт ваша генерация на «Фото» — запуск её подождёт" } };
  return { ...base, tag: null };
}

// ---------- a launch that runs ----------

const TIME = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** «14:02»: a moment of the launch, in the viewer's own time. */
export function clockLabel(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : TIME.format(at);
}

const isEnded = (status: LaunchStatus): boolean => status === "done" || status === "stopped";

/** A launch that still holds the form read-only: not done, not stopped. */
export function isUnfinished(launch: LaunchView | null): launch is LaunchView {
  return launch !== null && !isEnded(launch.status);
}

/** «План запуска», folded to one line of numbers (the design's decision 3): what the click accepted. */
export function launchPlanBits(launch: LaunchView): string[] {
  const { plan } = launch;
  const free = launch.plannedWorstMicros === 0;
  return [
    countOf(plan.videos, ["видео", "видео", "видео"]),
    `${plan.photos}${NBSP}фото: ${plan.fromLibrary} из библиотеки, ${plan.toGenerate} ${plan.toGenerate === 1 ? "новое" : "новых"}`,
    free ? "бесплатно" : aboutUsd(launch.plannedExpectedMicros),
    ...(free ? [] : [`предел до ${ceilingUsd(launch.plannedWorstMicros)}`]),
  ];
}

const TITLES: Record<LaunchStatus, string> = {
  running: "Идёт запуск",
  pausing: "Ставим на паузу…",
  paused: "Запуск на паузе",
  stopping: "Останавливаем…",
  done: "Запуск завершён",
  stopped: "Запуск остановлен",
};

export function launchTitle(status: LaunchStatus): string {
  return TITLES[status];
}

/** Videos done over the launch, and its plan. */
export function videosOf(launch: LaunchView): { done: number; planned: number } {
  return { done: launch.avatars.reduce((sum, a) => sum + a.videos.done, 0), planned: launch.plan.videos };
}

// ---------- «Стоп» ----------

/** A sentence in runs of words, the figures among them drawn in the mono face (ApStopConfirm: «(2)», «6 готовых видео», «$0.33 из $4.14»). */
export type Words = readonly (string | { readonly mono: string })[];

/** The sentence as one string: what a screen reader hears and a test reads. */
export function wordsText(words: Words): string {
  return Array.from(words, (run) => (typeof run === "string" ? run : run.mono)).join("");
}

/**
 * «Остановить запуск?» (ApStopConfirm): that nothing new starts and nothing is cut off, what stays, and what was spent of W′; the lines for each set are
 * liveModel's `stopSetLines` (S4.9b). Every figure is the launch view's, and each is a mono run, as the mockup draws them (S4.9b L4). A launch that pays for
 * nothing says nothing of money; an A2 breach of a free one says its figures (S4.9c N2, N3).
 */
export function stopTexts(launch: LaunchView): { readonly lead: Words; readonly stays: readonly Words[]; readonly spent: Words | null } {
  const requests = launch.inFlight.requests;
  const { done } = videosOf(launch);
  return {
    lead:
      requests > 0
        ? ["Новых запросов и рендеров не будет. Запросы, что уже в работе (", { mono: String(requests) }, "), закончатся сами — ничего не обрывается. Вернуть запуск после «Стоп» нельзя."]
        : ["Новых запросов и рендеров не будет. Вернуть запуск после «Стоп» нельзя."],
    stays: [
      [{ mono: String(done) }, `${NBSP}${plural(done, ["готовое видео", "готовых видео", "готовых видео"])} — в «Готовых видео»;`],
      ["все новые фото — в библиотеке, свободными для следующего запуска."],
    ],
    spent: isFree(launch.spentMicros, launch.plannedWorstMicros)
      ? null
      : ["Потрачено ", { mono: formatUsdTiered(launch.spentMicros, "nearest") }, " из ", { mono: limitUsd(launch.plannedWorstMicros) }, " — остальное запуск уже не потратит."],
  };
}

/** Under «Останавливаем…» (LaunchStates «Пауза и стоп»): nothing new is spent, and how long the requests in flight may take. */
export function stoppingLine(launch: LaunchView): string {
  const requests = launch.inFlight.requests;
  return requests > 0
    ? `Новых трат не будет. Ждём ответов на ${countOf(requests, ["запрос", "запроса", "запросов"])} — обычно до минуты, не дольше 3 минут.`
    : "Новых трат не будет.";
}

// ---------- the sidebar's mark ----------

export type MarkTone = "run" | "review" | "paused" | "hold" | "done";

export interface SidebarMark {
  /** What the item shows: «14 / 30», «сцены», «пауза», «ждёт», «стоп», «готово». */
  readonly text: string;
  readonly tone: MarkTone;
  /** What a screen reader hears with the item (its description). */
  readonly description: string;
}

/**
 * The mark at «Автопилот» in the sidebar (the design's decision 12), seen from any screen: the count while the launch runs, «сцены» while an avatar's scenes
 * wait for the owner, «ждёт» while paid work or a video waits for a cause, «пауза» from «Пауза» to «Продолжить», «стоп» while it stops, «готово» once it is
 * done until the owner has opened the screen (`seen`: the launch already looked at there). A stopped launch has no mark: the owner stopped it.
 */
export function sidebarMark(launch: LaunchView | null, seen: string | null): SidebarMark | null {
  if (launch === null) return null;
  switch (launch.status) {
    case "done":
      return seen === launch.launchId ? null : { text: "готово", tone: "done", description: "запуск завершён" };
    case "stopped":
      return null;
    case "pausing":
    case "paused":
      return { text: "пауза", tone: "paused", description: "запуск на паузе" };
    case "stopping":
      return { text: "стоп", tone: "hold", description: "запуск останавливается" };
    case "running": {
      if (launch.avatars.some((a) => a.phase === "awaiting-review")) return { text: "сцены", tone: "review", description: "сцены ждут проверки" };
      if (launch.paidHold !== null || launch.freeHold !== null || launch.waitingMusic > 0) return { text: "ждёт", tone: "hold", description: "запуск ждёт" };
      const { done, planned } = videosOf(launch);
      return { text: `${done} / ${planned}`, tone: "run", description: `идёт: готово ${done} из ${planned} видео` };
    }
  }
}
