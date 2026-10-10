import type {
  DropReason,
  ExportUnavailableReason,
  LaunchAvatarView,
  LaunchStatus,
  LaunchView,
  LogLine,
  PaidHold,
  ResumeBlockedBy,
  SkipReason,
  VideoShape,
} from "../../../shared/engine";
import { countOf, NBSP, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import type { SettingsFocus } from "../../navigation";
import { isFree, limitUsd } from "./launchMoney";
import { ceilingUsd, clockLabel, leftUsd, stoppingLine, videosOf } from "./planModel";

// S4.9b: the live launch card of «Автопилот» worded from the engine's view (AutopilotS4.dc.html states review-wait … paused-reviewed; LaunchStates
// «Продолжить», «Пока ждём», «Пауза и стоп», «Аватары», «Журнал»). Every sum is the view's own (`spentMicros`, `remainingMicros`, the holds' figures),
// only formatted («Деньги на экране»); the renderer computes no money. Counts (videos, photos, requests) are only said, or added up for a sentence.

const REQUESTS = ["запрос", "запроса", "запросов"] as const;
/** «за 1 прерванный запрос», «за 4 прерванных запроса», «за 5 прерванных запросов» (ApPausedReconcile). */
const CUT_OFF_REQUESTS = ["прерванный запрос", "прерванных запроса", "прерванных запросов"] as const;
const VIDEOS = ["видео", "видео", "видео"] as const;
const PHOTOS = ["фото", "фото", "фото"] as const;
const SCENES = ["сцена", "сцены", "сцен"] as const;
const SCENES_ACC = ["сцену", "сцены", "сцен"] as const;
const TIMES = ["раз", "раза", "раз"] as const;
const TRACKS = ["трек", "трека", "треков"] as const;
const MB = 1_000_000;

/** «$1.25»: money already spent, to the nearest. */
export const spentUsd = (micros: number): string => formatUsdTiered(micros, "nearest");

const SECONDS = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** «14:04:43»: a log line's moment, in the viewer's own time. */
export function clockSeconds(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : SECONDS.format(at);
}

/** «2:41», «1:05:12»: how long the launch has worked. */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** The names of a few avatars for a sentence: «Mia», «Mia и Elena», «Mia, Elena и Nora». */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} и ${names.at(-1) ?? ""}`;
}

// ---------- the header ----------

/** The status the card shows: the engine's, or what this window asked for while the engine's word on it is on its way. */
export function shownStatus(launch: LaunchView, asked: { pause: boolean; stop: boolean }): LaunchStatus {
  if (asked.stop && (launch.status === "running" || launch.status === "pausing" || launch.status === "paused")) return "stopping";
  if (asked.pause && launch.status === "running") return "pausing";
  return launch.status;
}

/**
 * The card's launch while the H1 interim stands: the engine's last announcement, with what decides «Продолжить» taken from the engine's direct answer
 * (`autopilot.get`) — what closes it, and R with the spend it is made of (one R everywhere, round 1 L10) — and the open reserves that spend holds, `inFlight`
 * and `unsettled`, from the same answer (S4.9d review L1): «Потрачено» is one view's, so a reconcile done no longer reads «до сверки».
 */
export function askedView(announced: LaunchView, answer: LaunchView): LaunchView {
  return {
    ...announced,
    resumeBlockedBy: answer.resumeBlockedBy,
    spentMicros: answer.spentMicros,
    remainingMicros: answer.remainingMicros,
    inFlight: answer.inFlight,
    unsettled: answer.unsettled,
  };
}

/** The mono line beside the title: since when and how long it worked, the requests a pause or a stop waits for, why it is paused, or its span. */
export function headerMeta(launch: LaunchView, status: LaunchStatus, activeMs: number): string | null {
  switch (status) {
    case "running":
      return `с ${clockLabel(launch.createdAt)} · ${durationLabel(activeMs)}`;
    case "pausing":
    case "stopping":
      return launch.inFlight.requests > 0 ? `${countOf(launch.inFlight.requests, REQUESTS)} в работе` : null;
    case "paused": {
      const paused = launch.paused;
      if (paused === null) return null;
      if (paused.cause === "quit") return `Studio был закрыт в ${clockLabel(paused.at)}`;
      if (paused.cause === "engine-restart") return `движок перезапустился в ${clockLabel(paused.at)}`;
      return `с ${clockLabel(paused.at)} · в работе ${durationLabel(activeMs)}`;
    }
    case "done":
    case "stopped":
      return launch.endedAt === null ? `с ${clockLabel(launch.createdAt)}` : `${clockLabel(launch.createdAt)}–${clockLabel(launch.endedAt)}`;
  }
}

/** The line under the header when no notice stands for the state: a pause on its way, a paused launch, a stop on its way, the outcome. */
export function headerSub(launch: LaunchView, status: LaunchStatus, nameOf: (avatarId: string) => string): string | null {
  switch (status) {
    case "pausing":
      return "Новые запросы и рендеры не начнутся. Ждём ответов на те, что уже ушли, — обычно до минуты, не дольше 3 минут; рендеры, что идут, доделаются.";
    case "stopping":
      return stoppingLine(launch);
    case "paused": {
      const approved = launch.avatars.filter((a) => a.phase === "approved-waiting");
      if (approved.length > 0) {
        const photos = approved.reduce((sum, a) => sum + (a.continuePhotos ?? 0), 0);
        const names = namesList(approved.map((a) => nameOf(a.avatarId)));
        return `Ничего не тратится и не рендерится. Сцены ${names} приняты — ${countOf(photos, PHOTOS)} нарисуем после «Продолжить».`;
      }
      // «бесплатный» by the one rule (S4.9d review L10): an A2 breach of a launch planned free has spent, and may spend nothing more.
      if (isFree(launch.spentMicros, launch.plannedWorstMicros)) return "Ничего не рендерится. «Продолжить» соберёт остальные видео — запуск бесплатный.";
      if (launch.remainingMicros === 0) return `Ничего не тратится и не рендерится. «Продолжить» не разрешит новых трат — от предела ${limitUsd(launch.plannedWorstMicros)} ничего не осталось.`;
      return `Ничего не тратится и не рендерится. «Продолжить» разрешит запуску потратить ещё до ${ceilingUsd(launch.remainingMicros)} — остаток предела ${limitUsd(launch.plannedWorstMicros)}.`;
    }
    case "done":
      return doneLine(launch, nameOf);
    case "stopped": {
      const { done, planned } = videosOf(launch);
      const spent = isFree(launch.spentMicros, launch.plannedWorstMicros) ? "" : ` Потрачено ${spentUsd(launch.spentMicros)} из ${limitUsd(launch.plannedWorstMicros)}.`;
      return `${done} из ${planned}${NBSP}видео готовы.${spent}`;
    }
    case "running":
      return null;
  }
}

/** At 1200 the ended card folds to a line (decision 1), so «Запустить» stays on screen: «28 из 30 видео · $1.69 из $4.14». */
export function endedLine(launch: LaunchView): string {
  const { done, planned } = videosOf(launch);
  const spent = isFree(launch.spentMicros, launch.plannedWorstMicros) ? "бесплатно" : `${spentUsd(launch.spentMicros)} из ${limitUsd(launch.plannedWorstMicros)}`;
  // S4.9c fix round 1 (ApDone at 1200): the span joins the line, so the header keeps the title and «Результаты · N» on one row.
  const span = launch.endedAt === null ? null : `${clockLabel(launch.createdAt)}–${clockLabel(launch.endedAt)}`;
  return [`${done} из ${planned} видео`, spent, span].filter((part) => part !== null).join(" · ");
}

const DROP_TEXT: Record<DropReason, string> = {
  "not-enough-photos": "не хватило фото",
  "render-failed": "рендер не удался",
  "avatar-gone": "аватара больше нет",
  "launch-stopped": "запуск остановлен",
  "avatar-skipped": "аватар пропущен",
};

/** «28 из 30 видео в «Готовых видео». 2 видео меньше: у Sofia — не хватило фото.» */
function doneLine(launch: LaunchView, nameOf: (avatarId: string) => string): string {
  const { done, planned } = videosOf(launch);
  const dropped = launch.avatars.filter((a) => a.dropped !== null);
  const head = `${done} из ${planned}${NBSP}видео в «Готовых видео».`;
  if (dropped.length === 0) return head;
  const fewer = dropped.reduce((sum, a) => sum + (a.dropped?.count ?? 0), 0);
  const why = dropped.map((a) => `у ${nameOf(a.avatarId)} — ${a.dropped === null ? "" : DROP_TEXT[a.dropped.reason]}`).join("; ");
  return `${head} ${countOf(fewer, VIDEOS)} меньше: ${why}.`;
}

// ---------- «Потрачено» ----------

export interface SpentBlock {
  /** «$1.25», or null for a launch that pays for nothing (it reads «бесплатно»). */
  readonly spent: string | null;
  readonly of: string;
  /** Percent of W′: settled, then the open reserves hatched after it. */
  readonly settledPct: number;
  readonly openPct: number;
  readonly sub: string | null;
  /** «Правки сцен $0.002 отдельно», or null with none. */
  readonly reviewWrites: string | null;
  readonly label: string;
}

const pctOf = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.round(Math.max(0, Math.min(100, (part / whole) * 100)) * 10) / 10);

/** Whether the launch is live (working, or finishing a pause or a stop): only then does the card show `inFlight`; a paused launch shows `unsettled` instead. */
const isLive = (launch: LaunchView): boolean => launch.status === "running" || launch.status === "pausing" || launch.status === "stopping";

/** The launch's requests in flight now: the view's `inFlight` while it is live, none otherwise (round 1 M1: never summed with anything). */
export function liveRequests(launch: LaunchView): { requests: number; openMicros: number } {
  return isLive(launch) ? launch.inFlight : { requests: 0, openMicros: 0 };
}

/**
 * S4.6v: the requests that got no answer and wait for a reconcile: the view's `unsettled` (open reserves no request of the engine is out for, disjoint from `inFlight`), on a paused
 * launch and under a network hold alike. A view from before `unsettled` has none, and its in-flight requests are the only open reserves it names (the old reading).
 */
export function unansweredRequests(launch: LaunchView): { requests: number; openMicros: number } {
  return launch.unsettled ?? liveRequests(launch);
}

/**
 * The open part of «Потрачено»: what is hatched and how it is worded. Never the sum of the two figures (round 1 M1): requests in flight while the launch is live,
 * else the unanswered ones. Those a quit or an engine restart cut off are «прерванные» (S4.9d, ApPausedReconcile); those a drop left — under a network hold, kept
 * over a restart too, or on the owner's own pause — had no answer («без ответа», ApHoldNetwork).
 */
function openPart(launch: LaunchView): { requests: number; openMicros: number; word: "working" | "unanswered" | "cut-off" } {
  const flight = liveRequests(launch);
  if (launch.unsettled === undefined) return { ...flight, word: launch.paidHold?.reason === "network" ? "unanswered" : "working" };
  if (flight.requests > 0) return { ...flight, word: "working" };
  const restarted = launch.status === "paused" && (launch.paused?.cause === "quit" || launch.paused?.cause === "engine-restart");
  return { ...launch.unsettled, word: restarted && launch.paidHold?.reason !== "network" ? "cut-off" : "unanswered" };
}

/** «за 4 запроса без ответа», «за 1 прерванный запрос»: the open requests a reconcile is to close, after their ceiling. */
function awaitingReconcile(requests: number, word: "unanswered" | "cut-off"): string {
  return word === "cut-off" ? `за ${requests}${NBSP}${plural(requests, CUT_OFF_REQUESTS)}` : `за ${countOf(requests, REQUESTS)} без ответа`;
}

/**
 * The reasons a paused launch waits for a reconcile of requests left without an answer: their open reserves are inside «Потрачено» at worst until then. Not a
 * halt: that is a settle above its worst case or a ledger line not written, and its own notice says so.
 */
const RECONCILE_FIRST = new Set<ResumeBlockedBy>(["reconcile-required", "network"]);

/**
 * «Потрачено $S из $W′» (§4.8: the ledger's, open reserves at worst), the bar with the open part hatched, and what the open part is. While the launch is live
 * and requests are out, the open part is `inFlight`: «вкл. до $0.28 — 4 запроса в работе…». Paused, or under a network hold with nothing out, it is `unsettled`,
 * in the mockup's words (S4.9d): «вкл. до $0.28 за 4 прерванных запроса — до сверки» after a quit or a restart (ApPausedReconcile), «вкл. до $0.28 за 4 запроса
 * без ответа — до сверки» otherwise (ApHoldNetwork); the two figures are disjoint and never added (round 1 M1). The bar's label says what the line says. A
 * reconcile that is required in a view from before `unsettled` keeps one plain line saying the open reserves are already inside «Потрачено».
 */
export function spentBlock(launch: LaunchView): SpentBlock {
  // «бесплатно» only when nothing was planned AND nothing spent (S4.9c fix round 1, the one rule of launchMoney): a spend above a W′ of 0 is an A2 breach, shown as it is.
  const free = isFree(launch.spentMicros, launch.plannedWorstMicros);
  const part = openPart(launch);
  // The hatched part, said by the line and by the bar's label alike: the contract keeps it inside «Потрачено», and a view that does not is capped there.
  const open = Math.min(part.openMicros, launch.spentMicros);
  /** What the open part is, after its ceiling: the line under the bar and the bar's label say it alike. */
  const what = part.word === "working" ? null : `${awaitingReconcile(part.requests, part.word)} — до сверки`;
  let sub: string | null = null;
  if (part.requests > 0 && open > 0) {
    sub =
      what === null
        ? `вкл. до ${ceilingUsd(open)} — ${countOf(part.requests, REQUESTS)} в работе, по худшей цене до ответа`
        : `вкл. до ${ceilingUsd(open)} ${what}`;
  } else if (launch.unsettled === undefined && launch.status === "paused" && launch.resumeBlockedBy !== null && RECONCILE_FIRST.has(launch.resumeBlockedBy)) {
    // Only a view from before `unsettled` has no better word: with it, a reconcile that is required while nothing is unsettled is for something else (a torn line, another job), and no reserve is claimed.
    const restart = launch.paused !== null && launch.paused.cause !== "owner" && launch.resumeBlockedBy === "reconcile-required";
    sub = `${restart ? "Прерванные запросы" : "Запросы без ответа"} уже в «Потрачено» по худшей цене — до сверки.`;
  }
  const spent = free ? null : spentUsd(launch.spentMicros);
  const of = free ? "бесплатно" : `из ${limitUsd(launch.plannedWorstMicros)}`;
  const openLabel = open === 0 ? "" : what === null ? `, из них до ${ceilingUsd(open)} — запросы в работе` : `, из них до ${ceilingUsd(open)} ${what}`;
  // The bar is W′ wide; a spend over it (an A2 breach, «$0.30 из $0» too) fills it, split as the spend is (S4.9d review L11), as the month's bar does.
  const width = Math.max(launch.plannedWorstMicros, launch.spentMicros);
  return {
    spent,
    of,
    settledPct: pctOf(launch.spentMicros - open, width),
    openPct: pctOf(open, width),
    sub,
    reviewWrites: launch.reviewWritesMicros > 0 ? spentUsd(launch.reviewWritesMicros) : null,
    label: free ? "Потрачено: ничего — запуск бесплатный" : `Потрачено ${spentUsd(launch.spentMicros)} ${of}${openLabel}`,
  };
}

// ---------- the avatar rows ----------

export type RowTone = "act" | "calm" | "info" | "warn" | "ok" | "off" | "danger";

export type RowAction = { readonly kind: "photos"; readonly label: string } | { readonly kind: "avatars"; readonly label: string };

export interface RowCell {
  readonly text: string;
  readonly pct: number;
}

export interface AvatarLine {
  readonly avatarId: string;
  readonly name: string;
  readonly phase: string;
  readonly tone: RowTone;
  readonly action: RowAction | null;
  /** Фото, Монтаж, Готово. */
  readonly cells: readonly [RowCell, RowCell, RowCell];
}

const SKIP_ROW: Record<SkipReason, string> = {
  archived: "пропущена: аватар в архиве",
  "master-unusable": "пропущена: мастер-портрет не годится для проверки лица",
  "face-gate-unavailable": "пропущена: проверка лица недоступна",
  "descriptor-invalid": "пропущена: проверка лица недоступна",
  "failure-rate": "пропущена: много неудачных фото",
  "set-unreadable": "пропущена: набор сцен не читается",
};

const of = (done: number, total: number): string => `${done} / ${total}`;
const cell = (done: number, total: number): RowCell => ({ text: of(done, total), pct: pctOf(done, total) });

/** «9 из 14 фото» after a row's phase: how far its photos got, when the draw has begun. */
function photosSoFar(row: LaunchAvatarView): string {
  return row.photos.total > 0 && row.photos.done > 0 && row.photos.done < row.photos.total ? ` · ${row.photos.done} из ${row.photos.total} фото` : "";
}

/** What a row waiting for the launch's paid hold says, by the hold. */
function heldPhase(hold: PaidHold | null, row: LaunchAvatarView): string {
  const soFar = photosSoFar(row);
  if (hold === null) return `ждёт${soFar}`;
  switch (hold.reason) {
    case "budget":
      return `ждёт бюджета${soFar}`;
    case "network":
      return hold.detail.nextAt === null ? `ждёт сверки${soFar}` : `ждём связь · повтор в ${clockLabel(hold.detail.nextAt)}`;
    case "halt":
      return `ждёт сверки${soFar}`;
    case "key":
      return `ждёт ключ OpenRouter${soFar}`;
    case "credits":
      return `ждёт пополнения${soFar}`;
    case "price":
      return `цена выросла${soFar}`;
    case "price-unavailable":
      return "ждёт цены";
    case "internal":
      return `платная часть остановлена${soFar}`;
  }
}

/**
 * One avatar's row (LaunchStates «Аватары», the rows of the running artboards): its phase in words and colour, its photos, montage and finished videos,
 * and the one action the row offers («Открыть «Фото»» for scenes to review, an open set or a failure-rate skip; «Открыть аватар» for a master portrait).
 */
export function avatarLine(launch: LaunchView, row: LaunchAvatarView, name: string): AvatarLine {
  const library = row.photos.total === 0;
  const photosCell: RowCell =
    library && row.sceneSetId === null
      ? { text: "библиотека", pct: 100 }
      : row.phase === "planned" || row.phase === "composing" || row.phase === "awaiting-review"
        ? { text: `— / ${row.photos.total}`, pct: 0 }
        : row.phase === "approved-waiting"
          ? { text: `— / ${row.continuePhotos ?? row.photos.total}`, pct: 0 }
          : cell(row.photos.done, row.photos.total);
  const cells: [RowCell, RowCell, RowCell] = [photosCell, cell(row.montage.done, row.montage.total), cell(row.videos.done, row.videos.total)];
  const line = (phase: string, tone: RowTone, action: RowAction | null = null): AvatarLine => ({ avatarId: row.avatarId, name, phase, tone, action, cells });
  const paused = launch.status === "paused";

  switch (row.phase) {
    case "skipped": {
      const reason = row.skipped?.reason ?? "failure-rate";
      const action: RowAction | null =
        reason === "failure-rate" ? { kind: "photos", label: "Открыть «Фото»" } : reason === "master-unusable" ? { kind: "avatars", label: "Открыть аватар" } : null;
      return line(SKIP_ROW[reason], "danger", action);
    }
    case "done":
      return line("готово", "ok");
    case "awaiting-review": {
      const counts = row.scenes === null ? "" : ` · ${row.scenes}${row.scenesWithoutText !== null && row.scenesWithoutText > 0 ? `, у ${row.scenesWithoutText} нет текста` : ""}`;
      return line(`ждёт проверки сцен${counts}`, "info", { kind: "photos", label: "Открыть «Фото»" });
    }
    case "approved-waiting":
      return line(`проверено — ждёт «Продолжить»${row.continuePhotos === null ? "" : ` · ${countOf(row.continuePhotos, PHOTOS)}`}`, "info");
    default:
      break;
  }
  if (paused) return line(`на паузе${photosSoFar(row)}`, "off");
  switch (row.phase) {
    case "planned":
      return line("в очереди", "off");
    case "composing":
      return line(`пишем сцены · ${row.photos.total}`, "act");
    case "drawing":
      return line(
        row.slice !== null ? `рисуем фото · партия ${row.slice.index} из ${row.slice.total}` : `рисуем фото · ${row.photos.done} из ${row.photos.total}`,
        "act",
      );
    case "montage":
      if (row.waitingMusic > 0) return line(`${countOf(row.waitingMusic, VIDEOS)} ${row.waitingMusic === 1 ? "ждёт" : "ждут"} музыку`, "warn");
      return line(library ? "монтаж · фото из библиотеки" : "монтаж", "calm");
    case "waiting": {
      const reason = row.waiting?.reason ?? "paid-hold";
      if (reason === "avatar-busy") return line("ждёт: идёт ваша генерация на «Фото» — продолжим сами", "warn");
      if (reason === "open-set") return line("ждёт: открыт ваш набор сцен — завершите его на «Фото»", "warn", { kind: "photos", label: "Открыть «Фото»" });
      if (reason === "library-unknown") return line("ждёт: не читается, какие фото свободны — продолжим, когда библиотека ответит", "warn");
      return line(heldPhase(launch.paidHold, row), "warn");
    }
    default:
      return line("", "calm");
  }
}

// ---------- «Продолжить · до $R» ----------

/** «Продолжить · до $2.93»: always with its sum (after a restart the click is the consent to spend, invariant 4); «бесплатно» by the one rule (S4.9d review L10). */
export function resumeTitle(remainingMicros: number, plannedWorstMicros: number, spentMicros = 0): string {
  if (isFree(spentMicros, plannedWorstMicros)) return "Продолжить · бесплатно";
  if (remainingMicros === 0) return "Продолжить · без трат";
  return `Продолжить · до ${ceilingUsd(remainingMicros)}`;
}

/** The first of next month in UTC, after `iso`: «1 ноября» — when a monthly budget opens again. */
export function nextMonthStart(iso: string): string {
  const at = new Date(Date.parse(iso));
  const first = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(first);
}

/** Why «Продолжить» stays closed, the line under the notice it is described by (LaunchStates «Продолжить»). */
export function resumeWhy(launch: LaunchView, blocked: ResumeBlockedBy): string {
  switch (blocked) {
    case "reconcile-required":
      return "Сверить можно через 2 минуты после последнего запроса. Потом «Продолжить» покажет новый остаток.";
    case "halt":
      return "Сначала сверка — потом «Продолжить» покажет новый остаток.";
    case "ledger":
      return "«Продолжить» откроется, когда журнал расходов снова прочитается.";
    case "key":
      return "«Продолжить» откроется, когда ключ проверен.";
    case "budget": {
      const hold = launch.paidHold;
      if (hold === null || hold.reason !== "budget") return "«Продолжить» откроется, когда в месяце будет место для следующей партии.";
      const need = ceilingUsd(hold.detail.needMicros);
      return hold.detail.kind === "new-slice"
        ? `«Продолжить» откроется, когда в месяце будет свободно ${need}; партия будет по месту.`
        : `«Продолжить» откроется, когда в месяце будет свободно ${need}.`;
    }
    case "network": {
      const unanswered = unansweredRequests(launch);
      const which = unanswered.requests > 0 ? `эти ${countOf(unanswered.requests, REQUESTS)}` : "запросы без ответа";
      return `Сначала сверка — она закроет ${which}. Потом «Продолжить» покажет новый остаток.`;
    }
    case "internal":
      return "Продолжить нельзя: выход — «Стоп».";
  }
}

// ---------- the notice under the header ----------

export type NoteAction =
  | { readonly kind: "settings"; readonly focus: SettingsFocus; readonly label: string }
  | { readonly kind: "photos"; readonly avatarId: string; readonly label: string }
  | { readonly kind: "avatars"; readonly label: string }
  | { readonly kind: "continue"; readonly avatarId: string; readonly sceneSetId: string; readonly revision: number; readonly label: string }
  | { readonly kind: "stop"; readonly label: string }
  /** S4.9c: «Мои треки…» opens «Музыка для автопилота», where an own track is marked «для автопилота». */
  | { readonly kind: "music"; readonly label: string };

export interface LiveNote {
  /** Stable for one cause: React's key, the tests' handle, and what announces a new one. */
  readonly id: string;
  readonly tone: "info" | "warn" | "danger";
  readonly icon: "info" | "alert" | "pause";
  readonly title: string;
  readonly text: string;
  readonly actions: readonly NoteAction[];
  /** «Продолжить · до $R» lives in this notice (a paid hold of a running launch, decision 7), not in the header. */
  readonly resume: boolean;
  /** The line under the actions: why «Продолжить» is closed, or what to expect. */
  readonly why: string | null;
}

const toSettings = (focus: SettingsFocus, label: string): NoteAction => ({ kind: "settings", focus, label });
const RECONCILE = toSettings("money", "Перейти к сверке");
const MONEY = toSettings("money", "Открыть Настройки");
const FREE_GOES_ON = " Монтаж из готовых фото идёт дальше.";

/** The requests a quit or a crash cut off, from the log's restart line (the view keeps no figure of its own for them). */
function cutOffRequests(launch: LaunchView): number | null {
  for (const line of [...launch.logTail].reverse()) {
    if (line.kind === "app-restarted" || line.kind === "host-quit") return line.requests > 0 ? line.requests : null;
  }
  return null;
}

/** The avatar a paid hold holds (the first that waits for it), for a sentence that names whose batch it is. */
function heldAvatar(launch: LaunchView, nameOf: (avatarId: string) => string): string | null {
  const row = launch.avatars.find((a) => a.phase === "waiting" && a.waiting?.reason === "paid-hold");
  return row === undefined ? null : nameOf(row.avatarId);
}

/** When an automatic retry goes: at its time while the launch runs, after «Продолжить» while it is paused (nothing runs by itself then). */
function retryWhen(nextAt: string, paused: boolean): string {
  return paused ? "после «Продолжить»" : `в ${clockLabel(nextAt)}`;
}

/**
 * The notice of a paid hold (LaunchStates «Продолжить» and «Пока ждём»). `running`: free work goes on, said so, and the click lives in the notice. Its `why`
 * is the reason «Продолжить» is closed whenever one is (round 1 M3: a hold's own line never replaces it).
 */
function holdNote(launch: LaunchView, hold: PaidHold, running: boolean, nameOf: (avatarId: string) => string): LiveNote {
  const goesOn = running ? FREE_GOES_ON : "";
  const paused = launch.status === "paused";
  const blocked = launch.resumeBlockedBy;
  const blockWhy = blocked === null ? null : resumeWhy(launch, blocked);
  const base = { resume: running, why: blockWhy };
  const who = heldAvatar(launch, nameOf);
  switch (hold.reason) {
    case "budget": {
      const need = ceilingUsd(hold.detail.needMicros);
      const free = leftUsd(hold.detail.freeMicros);
      const batch = who === null ? "" : ` ${who}`;
      const lead =
        hold.detail.kind === "resume-slice"
          ? `Доделать партию${batch}: нужно до ${need}, свободно ${free}.`
          : `Начать новую партию${batch}: нужно хотя бы ${need} — одно фото, свободно ${free}.`;
      return { ...base, id: `hold-budget-${hold.detail.kind}`, tone: "warn", icon: "alert", title: "Ждёт бюджета", text: `${lead} Поднимите бюджет или дождитесь ${nextMonthStart(hold.at)} (UTC).${goesOn}`, actions: [MONEY] };
    }
    case "credits":
      return {
        ...base,
        why: blockWhy ?? "Если денег всё ещё нет, запуск снова встанет здесь — без лишних трат.",
        id: "hold-credits",
        tone: "warn",
        icon: "alert",
        title: "Пополните баланс OpenRouter",
        text: `OpenRouter ответил: денег на счёте нет. Пополните баланс на openrouter.ai и нажмите «Продолжить».${goesOn}`,
        actions: [],
      };
    case "key":
      return {
        ...base,
        id: "hold-key",
        tone: "warn",
        icon: "alert",
        title: "Ключ OpenRouter отклонён",
        text: running ? `OpenRouter не принял ключ посреди партии. Замените его в Настройках — потом «Продолжить».${goesOn}` : "OpenRouter не принял ключ. Замените его в Настройках — потом «Продолжить».",
        actions: [toSettings("key", "Открыть Настройки")],
      };
    case "halt":
      return {
        ...base,
        id: "hold-halt",
        tone: "danger",
        icon: "alert",
        title: "Расходы остановлены",
        text:
          (hold.detail.code === "LEDGER_WRITE_FAILED"
            ? "Строка журнала расходов не записалась — Studio остановил все платные запросы."
            : "Запрос стоил больше своей худшей цены — Studio остановил все платные запросы.") + ` Сверка проверит журнал и снимет остановку.${goesOn}`,
        actions: [RECONCILE],
      };
    case "network": {
      if (hold.detail.nextAt !== null) {
        // L6: a retry that goes by itself is information, not an alarm.
        const batch = who === null ? "Запросы партии остались без ответа." : `Партия ${who} осталась без ответа.`;
        const goes = paused ? "После «Продолжить» повторим её в пределах той же партии" : "Продолжим её сами в пределах той же партии";
        return {
          id: `hold-network-retry-${hold.detail.attempt}`,
          tone: "info",
          icon: "info",
          title: paused ? "Нет ответа — повтор после «Продолжить»" : `Нет ответа — повторим ${retryWhen(hold.detail.nextAt, false)}`,
          text: `${batch} ${goes} — повтор ${hold.detail.attempt} из 2. Если связь пропадёт в третий раз, платная часть встанет до сверки.`,
          actions: [],
          resume: false,
          why: blockWhy ?? "Каждый обрыв сжигает по одной оплаченной попытке у фото в работе — до 6.",
        };
      }
      const drops = hold.detail.drops;
      const lead = drops >= 3 ? `Связь пропала ${countOf(drops, TIMES)}: 2 повтора (через 1 и 5 мин) не помогли — платная часть ждёт.` : "Связь пропала — платная часть ждёт.";
      const unanswered = unansweredRequests(launch);
      const open =
        unanswered.requests > 0 && unanswered.openMicros > 0
          ? ` ${countOf(unanswered.requests, REQUESTS)} без ответа до сверки считаются по худшей цене, до ${ceilingUsd(unanswered.openMicros)}.`
          : " Запросы без ответа до сверки считаются по худшей цене.";
      return { ...base, id: "hold-network", tone: "warn", icon: "alert", title: "Нет ответа от OpenRouter", text: `${lead}${open}${goesOn}`, actions: [RECONCILE] };
    }
    case "price-unavailable":
      if (hold.detail.nextAt !== null) {
        return {
          id: `hold-prices-retry-${hold.detail.attempt}`,
          tone: "info",
          icon: "info",
          title: paused ? "Цены не загрузились — повтор после «Продолжить»" : `Цены не загрузились — повторим ${retryWhen(hold.detail.nextAt, false)}`,
          text: paused ? `Без цены запуск не тратит. Повтор ${hold.detail.attempt} из 3 — после «Продолжить».` : `Без цены запуск не тратит. Повтор ${hold.detail.attempt} из 3.${goesOn}`,
          actions: [],
          resume: false,
          why: blockWhy,
        };
      }
      return {
        ...base,
        id: "hold-prices",
        tone: "warn",
        icon: "alert",
        title: "Цены OpenRouter не загрузились",
        text: `Пробовали через 5, 15 и 60 минут — список цен не пришёл. Без цены запуск не тратит.${goesOn}`,
        actions: [],
      };
    case "price":
      return {
        ...base,
        id: `hold-price-${hold.detail.stage}`,
        tone: "warn",
        icon: "alert",
        title: "Цена выросла",
        text:
          (hold.detail.stage === "slice"
            ? "Следующая партия не помещается в остаток запуска даже из одного фото."
            : "Сцены по новой цене не помещаются в то, что осталось им от предела запуска.") +
          " «Продолжить» попробует по текущей цене в пределах остатка; заплатить больше — только новым запуском.",
        actions: [],
      };
    case "internal":
      if (hold.detail.kind === "job-failed") {
        // S4.6r: a paid job ended in a way no row of the table covers. The click is open and runs the job again; the job's own words say what it met.
        const met = hold.detail.message === undefined ? "" : ` Она ответила: ${hold.detail.message}.`;
        const job = who === null ? "Платная задача" : `Платная задача ${who}`;
        return {
          ...base,
          id: "hold-internal-job",
          tone: "danger",
          icon: "alert",
          title: "Задача остановилась с ошибкой",
          text: `${job} закончилась ошибкой, которой нет в таблице известных.${met} «Продолжить» запустит её снова; «Стоп» сохранит всё, что готово.${goesOn}`,
          actions: [],
        };
      }
      return {
        ...base,
        id: "hold-internal",
        tone: "danger",
        icon: "alert",
        title: "Внутренняя ошибка учёта",
        text: `Запуск насчитал по своим задачам больше, чем позволяет его предел, — платная часть остановлена. Продолжить нельзя: «Стоп» сохранит всё, что готово.${goesOn}`,
        actions: [{ kind: "stop", label: "Стоп" }],
      };
  }
}

/** A hold in a few words, for the notice of another reason that closes «Продолжить» first (round 1 M3). */
function holdMention(hold: PaidHold, paused: boolean): string {
  switch (hold.reason) {
    case "budget":
      return "месячный бюджет";
    case "credits":
      return "пополнение баланса OpenRouter";
    case "key":
      return "новый ключ OpenRouter";
    case "halt":
      return "сверка — расходы остановлены";
    case "network":
      return hold.detail.nextAt === null ? "сверка — нет ответа от OpenRouter" : `нет ответа от OpenRouter — повтор ${retryWhen(hold.detail.nextAt, paused)}`;
    case "price-unavailable":
      return hold.detail.nextAt === null ? "цены OpenRouter" : `цены не загрузились — повтор ${retryWhen(hold.detail.nextAt, paused)}`;
    case "price":
      return "цена выросла";
    case "internal":
      return "внутренняя ошибка учёта";
  }
}

/**
 * The notice of what closes «Продолжить» (`resumeBlockedBy`): a reconcile left by a quit, the ledger, the key, a halt, the month, a network hold, the
 * launch's own check. A paid hold with the same reason speaks in its own words; a hold with another one is said in this notice, after the reason (M3).
 */
function blockNote(launch: LaunchView, blocked: ResumeBlockedBy, running: boolean, nameOf: (avatarId: string) => string): LiveNote {
  const hold = launch.paidHold;
  if (hold !== null && hold.reason === blocked) return holdNote(launch, hold, running, nameOf);
  const paused = launch.status === "paused";
  const also = hold === null ? "" : ` Ещё платная часть ждёт: ${holdMention(hold, paused)}.`;
  const why = resumeWhy(launch, blocked);
  const base = { resume: running, why };
  const note = (id: string, tone: LiveNote["tone"], title: string, text: string, actions: readonly NoteAction[]): LiveNote => ({ ...base, id, tone, icon: "alert", title, text: `${text}${also}`, actions });
  switch (blocked) {
    case "reconcile-required": {
      const requests = cutOffRequests(launch);
      const cause = launch.paused?.cause === "engine-restart" ? "Движок перезапустился" : "Studio закрылся";
      // ApPausedReconcile names the ceiling of what waits for the reconcile (S4.9d review L3), as the network hold's banner does; nothing unsettled claims no sum.
      const unsettled = unansweredRequests(launch);
      const atWorst = unsettled.requests > 0 && unsettled.openMicros > 0 ? `считаются по худшей цене — до ${ceilingUsd(unsettled.openMicros)}, —` : "считаются по худшей цене,";
      const text =
        requests !== null
          ? `${cause}, когда ${countOf(requests, REQUESTS)} ${requests === 1 ? "был" : "были"} в работе. Пока OpenRouter не сверен, они ${atWorst} и запуск не продолжить.`
          : `В журнале расходов остались запросы прошлого запуска Studio. Пока OpenRouter не сверен, они ${atWorst} и запуск не продолжить.`;
      return note("block-reconcile", "warn", "Сначала сверка", text, [RECONCILE]);
    }
    case "ledger":
      return note(
        "block-ledger",
        "danger",
        "Журнал расходов не читается",
        "Пока его не прочитать, Studio не знает, сколько потрачено, и платные запросы закрыты. Откройте Настройки → «OpenRouter и расходы».",
        [MONEY],
      );
    case "halt":
      return note("block-halt", "danger", "Расходы остановлены", "Studio остановил все платные запросы: журнал расходов требует сверки. Сверка проверит его и снимет остановку.", [RECONCILE]);
    case "key":
      return note("block-key", "warn", "Ключ OpenRouter отклонён", "OpenRouter не принял ключ. Замените его в Настройках — потом «Продолжить».", [toSettings("key", "Открыть Настройки")]);
    case "budget":
      return note("block-budget", "warn", "Ждёт бюджета", "В месяце не хватает места для следующей партии. Поднимите бюджет или дождитесь начала месяца (UTC).", [MONEY]);
    case "network":
      return note("block-network", "warn", "Нет ответа от OpenRouter", "Запросы без ответа до сверки считаются по худшей цене.", [RECONCILE]);
    case "internal":
      return { ...holdNote(launch, { reason: "internal", at: launch.createdAt, detail: { kind: "allocation-exceeded" } }, running, nameOf), why };
  }
}

const SKIP_TEXT: Record<SkipReason, (name: string, failed: string) => string> = {
  "failure-rate": (name, failed) => `${failed}новых фото не прошли проверки. Новых фото ${name} в этом запуске не будет — проверьте мастер-портрет. Её видео из библиотеки соберутся; остаток её доли предела не тратится.`,
  "master-unusable": (name) => `Мастер-портрет ${name} не годится для проверки лица — новых фото ${name} в этом запуске не будет. Её доля предела не тратится.`,
  archived: (name) => `${name} в архиве — в этом запуске её больше нет. Её доля предела не тратится.`,
  "face-gate-unavailable": (name) => `Проверка лица недоступна — новых фото ${name} в этом запуске не будет. Её доля предела не тратится.`,
  "descriptor-invalid": (name) => `Проверка лица недоступна — новых фото ${name} в этом запуске не будет. Её доля предела не тратится.`,
  "set-unreadable": (name) =>
    `Файл набора ${name} повреждён, а в журнале расходов по нему уже есть запросы. Новых фото ${name} в этом запуске не будет — иначе можно заплатить за сцены второй раз. Остальные аватары идут дальше.`,
};

/** The notice of the first skipped avatar (LaunchStates «Пока ждём»: «Elena пропущена»). */
function skipNote(row: LaunchAvatarView, name: string): LiveNote {
  const skipped = row.skipped;
  const reason = skipped?.reason ?? "failure-rate";
  const failed = skipped !== null && skipped.reason === "failure-rate" ? `${skipped.failed} из ${skipped.total} ` : "";
  const title = reason === "set-unreadable" ? `${name} пропущена: набор сцен не читается` : `${name} пропущена`;
  const actions: NoteAction[] =
    reason === "failure-rate" ? [{ kind: "photos", avatarId: row.avatarId, label: `Открыть «Фото» ${name}` }] : reason === "master-unusable" ? [{ kind: "avatars", label: "Открыть аватар" }] : [];
  return { id: `skipped-${row.avatarId}-${reason}`, tone: "warn", icon: "alert", title, text: SKIP_TEXT[reason](name, failed), actions, resume: false, why: null };
}

/** The notice of scenes waiting for the owner (ApReviewWait): what to look at, and «Продолжить запуск: M фото» from here. */
function reviewNote(launch: LaunchView, row: LaunchAvatarView, nameOf: (avatarId: string) => string): LiveNote {
  const name = nameOf(row.avatarId);
  const others = launch.avatars.filter((a) => a.avatarId !== row.avatarId && a.phase !== "done" && a.phase !== "skipped").map((a) => nameOf(a.avatarId));
  const scenes = row.scenes ?? row.photos.total;
  const without = row.scenesWithoutText ?? 0;
  const lead = `${countOf(scenes, SCENES)} на «Фото»${without > 0 ? `, у ${without} нет текста` : ""}.`;
  const meanwhile = others.length === 0 ? "" : others.length <= 2 ? ` Пока вы смотрите, ${namesList(others)} ${others.length === 1 ? "идёт" : "идут"} дальше.` : " Пока вы смотрите, остальные идут дальше.";
  const canContinue = row.sceneSetId !== null && row.setRevision !== null && row.continuePhotos !== null;
  const from = canContinue
    ? without > 0
      ? ` Продолжить можно и отсюда: ${without === 1 ? "сцену" : "сцены"} без текста уберём, фото будет ${row.continuePhotos ?? 0}.`
      : " Продолжить можно и отсюда."
    : "";
  const actions: NoteAction[] =
    canContinue && row.sceneSetId !== null && row.setRevision !== null
      ? [{ kind: "continue", avatarId: row.avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision, label: `Продолжить запуск: ${countOf(row.continuePhotos ?? 0, PHOTOS)}` }]
      : [{ kind: "photos", avatarId: row.avatarId, label: "Открыть «Фото»" }];
  return { id: `review-${row.avatarId}`, tone: "info", icon: "info", title: `Сцены ${name} ждут проверки`, text: `${lead}${meanwhile}${from}`, actions, resume: false, why: null };
}

const EXPORT_TEXT: Partial<Record<ExportUnavailableReason, string>> = {
  missing: "Диск отключён или папку переименовали.",
  "not-a-directory": "На месте папки теперь файл.",
  "not-writable": "В папку нельзя записать.",
};

/** The notice of the export folder (LaunchStates «Пока ждём»): renders wait, the paid part goes on; it clears by itself. */
function exportNote(launch: LaunchView): LiveNote | null {
  const hold = launch.freeHold;
  if (hold === null) return null;
  const { exportReason, neededBytes, freeBytes } = hold.detail;
  if (exportReason === "not-enough-space") {
    const need = neededBytes === null ? null : `${Math.max(1, Math.ceil(neededBytes / MB))}${NBSP}МБ`;
    const free = freeBytes === null ? null : `${Math.floor(freeBytes / MB)}${NBSP}МБ`;
    const figures = need !== null && free !== null ? `Для следующего видео нужно ≈ ${need}, свободно ${free}.` : "Для следующего видео не хватает места.";
    return { id: "free-space", tone: "warn", icon: "alert", title: "Мало места на диске", text: `${figures} Освободите место — рендеры продолжатся сами.`, actions: [], resume: false, why: null };
  }
  const cause = EXPORT_TEXT[exportReason] ?? "Studio не может записать в неё видео.";
  return {
    id: `free-export-${exportReason}`,
    tone: "warn",
    icon: "alert",
    title: "Папка «Готовые видео» недоступна",
    text: `${cause} Фото рисуются дальше, видео подождут папку.`,
    actions: [toSettings("export", "Открыть Настройки")],
    resume: false,
    why: null,
  };
}

/** The notice of videos with no track (ApWaitingMusic): no candidate, or all shorter than the videos; they wait, never silent. */
function musicNote(launch: LaunchView): LiveNote {
  const n = launch.waitingMusic;
  const refreshed = launch.logTail.some((l) => l.kind === "music-refresh");
  return {
    id: `music-${n}`,
    tone: "warn",
    icon: "alert",
    title: `${countOf(n, VIDEOS)} ${n === 1 ? "ждёт" : "ждут"} музыку`,
    text: "Подходящих треков нет: все тренды и отмеченные треки короче этих видео (или их нет совсем). Отметьте свои треки «для автопилота» или обновите тренды — видео соберутся сами.",
    actions: [{ kind: "music", label: "Мои треки…" }, toSettings("music", "Обновить тренды — в Настройках")],
    resume: false,
    why: refreshed ? "Автопилот уже обновлял тренды при старте — второй раз только вручную." : null,
  };
}

/** The notice of a launch the restart paused (ApPausedRestart; LaunchStates «Studio перезапустил движок после сбоя»). */
function restartNote(launch: LaunchView): LiveNote | null {
  const cause = launch.paused?.cause;
  if (cause !== "quit" && cause !== "engine-restart") return null;
  const spend = launch.plannedWorstMicros === 0 ? "" : ` «Продолжить» разрешит потратить ещё до ${ceilingUsd(launch.remainingMicros)} — остаток предела ${ceilingUsd(launch.plannedWorstMicros)}.`;
  return cause === "quit"
    ? { id: "restart-quit", tone: "info", icon: "pause", title: "Studio был закрыт — запуск ждёт вас", text: `После перезапуска автопилот ничего не делает сам: ни запросов, ни рендеров, ни музыки.${spend}`, actions: [], resume: false, why: null }
    : { id: "restart-engine", tone: "info", icon: "pause", title: "Studio перезапустил движок после сбоя", text: `Запуск на паузе и ничего не делает сам: ни запросов, ни рендеров, ни музыки.${spend}`, actions: [], resume: false, why: null };
}

/**
 * The one notice pinned under the card's header (decision 7, round 1 M6), most pressing first. A paused launch: what closes «Продолжить» (a hold waiting
 * beside it said in it, round 1 M3), else its hold, else the restart. A running one: its paid hold with «Продолжить · до $R» inside — or, when another reason
 * closes the button, that reason first — then the export folder, scenes waiting for the owner, videos waiting for music, a skipped avatar. None while a pause or
 * a stop is on its way, and none once it ended.
 */
export function liveNote(launch: LaunchView, status: LaunchStatus, nameOf: (avatarId: string) => string): LiveNote | null {
  const blocked = launch.resumeBlockedBy;
  const hold = launch.paidHold;
  if (status === "paused") {
    // What closes «Продолжить» comes first, the hold said in it (round 1 M3); else the hold; else the restart.
    if (blocked !== null) return blockNote(launch, blocked, false, nameOf);
    if (hold !== null) return holdNote(launch, hold, false, nameOf);
    return restartNote(launch);
  }
  if (status !== "running") return null;
  if (hold !== null) return blocked !== null && blocked !== hold.reason ? blockNote(launch, blocked, true, nameOf) : holdNote(launch, hold, true, nameOf);
  const exportHold = exportNote(launch);
  if (exportHold !== null) return exportHold;
  const review = launch.avatars.find((a) => a.phase === "awaiting-review");
  if (review !== undefined) return reviewNote(launch, review, nameOf);
  if (launch.waitingMusic > 0) return musicNote(launch);
  const skipped = launch.avatars.find((a) => a.phase === "skipped");
  if (skipped !== undefined) return skipNote(skipped, nameOf(skipped.avatarId));
  return null;
}

/** Where «Продолжить · до $R» stands: in the header (a paused launch), in the notice (a running launch's paid hold), or nowhere. */
export function resumePlace(launch: LaunchView, status: LaunchStatus, note: LiveNote | null): "header" | "note" | null {
  if (status === "paused") return "header";
  if (status === "running" && note !== null && note.resume) return "note";
  return null;
}

// ---------- the log ----------

export type LogTone = "plain" | "warn" | "info" | "ok" | "danger";

export interface LogRow {
  readonly key: string;
  readonly at: string;
  /** The avatar's name, or «—» for the launch as a whole. */
  readonly who: string;
  readonly text: string;
  readonly tone: LogTone;
}

const SHAPE: Record<VideoShape, string> = { single: "одно фото", collage: "коллаж", slides: "слайды" };

/** «видео 5 · коллаж 3», «видео 9 · одно фото»: the number of the video in its avatar's part of the launch, and its shape. */
function videoLabel(key: string): string {
  return `видео ${key.split("-")[1] ?? key}`;
}

function shapeLabel(shape: VideoShape, size: number): string {
  return shape === "single" ? SHAPE.single : `${SHAPE[shape]} ${size}`;
}

const seconds = (ms: number): string => `${(Math.round(ms / 100) / 10).toFixed(1)}${NBSP}с`;
const megabytes = (bytes: number): string => `${(Math.round(bytes / 100_000) / 10).toFixed(1)}${NBSP}МБ`;
const face = (cos: number | undefined): string => (cos === undefined ? "" : ` · лицо ${cos.toFixed(2)}`);
const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}${NBSP}мин`;

const FAILED_CAUSE: Record<Extract<LogLine, { kind: "photo-failed" }>["cause"], (cos: number | undefined) => string> = {
  face: (cos) => (cos === undefined ? "лицо не похоже" : `лицо ${cos.toFixed(2)} — не похоже`),
  duplicate: () => "повтор другого фото",
  age: () => "не прошло проверку возраста",
  moderation: () => "отказ модерации",
  provider: () => "отказ провайдера",
  limit: () => "лимит расходов",
  "no-answer": () => "нет ответа",
};

const SKIP_LOG: Record<SkipReason, string> = {
  archived: "пропущена: аватар в архиве",
  "master-unusable": "пропущена: мастер-портрет не годится для проверки лица",
  "face-gate-unavailable": "пропущена: проверка лица недоступна",
  "descriptor-invalid": "пропущена: проверка лица недоступна",
  "failure-rate": "пропущена: много неудачных фото",
  "set-unreadable": "пропущена: набор сцен не читается",
};

/** One log line in words (LaunchStates «Журнал»): the engine sends the kind and its numbers, the window says them. */
export function logText(line: LogLine, sceneReview: boolean): { text: string; tone: LogTone } {
  switch (line.kind) {
    case "start":
      return { text: line.acceptedMicros > 0 ? `запуск принят · до ${ceilingUsd(line.acceptedMicros)}` : "запуск принят · бесплатно", tone: "plain" };
    case "scenes-ready":
      return {
        text: `сцены готовы: ${line.scenes}${line.withoutText > 0 ? `, у ${line.withoutText} нет текста` : ""}${sceneReview ? " · ждут проверки" : ""}`,
        tone: sceneReview ? "info" : "plain",
      };
    case "review-continued":
      return { text: `сцены проверены: ${countOf(line.photos, PHOTOS)}${line.writtenByOwner > 0 ? ` · ${line.writtenByOwner} дописаны вами` : ""}`, tone: "plain" };
    case "slice-start":
      return { text: `партия ${line.index}: ${countOf(line.photos, PHOTOS)} · до ${ceilingUsd(line.capMicros)}`, tone: "plain" };
    case "photo":
      return { text: `фото ${line.done} из ${line.total}${face(line.faceCos)}`, tone: "plain" };
    case "photo-retry":
      return { text: `сцена ${line.sceneId}: отказ${line.viaFallback ? " → Seedream" : ""} · попытка ${line.attempt} из ${line.attempts}`, tone: "plain" };
    case "photo-failed":
      // S4.9d: orange, as the sheet colours it — a slot that used up its tries.
      return { text: `фото ${line.slot}: ${FAILED_CAUSE[line.cause](line.faceCos)} · попыток ${line.attempts}`, tone: "warn" };
    case "video-done":
      return { text: `${videoLabel(line.key)} · ${shapeLabel(line.shape, line.size)} · ${seconds(line.durationMs)} · ${megabytes(line.bytes)}`, tone: "plain" };
    case "degrade":
      return {
        text: line.fewerVideos > 0 ? `${countOf(line.fewerVideos, VIDEOS)} меньше: ${countOf(line.missingPhotos, PHOTOS)} не получились` : `видео короче: ${countOf(line.missingPhotos, PHOTOS)} не получились`,
        // S4.9d: orange, as the sheet colours it — the launch came out smaller than planned.
        tone: "warn",
      };
    case "price-shrink":
      return { text: `цена выросла: −${countOf(line.fromPhotos - line.toPhotos, PHOTOS)} в партии`, tone: "warn" };
    case "review-write":
      return { text: `правка сцен: ${line.write === "redraw" ? "«другая сцена»" : "переписать"} · ${spentUsd(line.micros)} отдельно`, tone: "plain" };
    case "pausing":
      return {
        text:
          line.requests === 0 && line.renders === 0
            ? "пауза"
            : `пауза: ждём ${[line.requests > 0 ? countOf(line.requests, REQUESTS) : null, line.renders > 0 ? countOf(line.renders, ["рендер", "рендера", "рендеров"]) : null].filter((p) => p !== null).join(" и ")}`,
        tone: "warn",
      };
    case "paused":
      return { text: "на паузе: запросы закончились", tone: "warn" };
    case "resumed":
      return { text: line.acceptedRemainingMicros > 0 ? `продолжен · до ${ceilingUsd(line.acceptedRemainingMicros)}` : "продолжен", tone: "plain" };
    case "host-quit":
      return { text: line.requests > 0 ? `Studio закрыт · ${countOf(line.requests, REQUESTS)} прервались` : "Studio закрыт · запросов в работе не было", tone: "warn" };
    case "network-retry":
      return { text: `нет ответа · повтор ${line.attempt} из ${line.attempts} через ${minutes(line.afterMs)}`, tone: "warn" };
    case "hold-budget":
      return {
        text:
          line.holdKind === "resume-slice"
            ? `доделать партию: нужно до ${ceilingUsd(line.needMicros)}, свободно ${leftUsd(line.freeMicros)}`
            : `начать новую партию: нужно хотя бы ${ceilingUsd(line.needMicros)}, свободно ${leftUsd(line.freeMicros)}`,
        tone: "warn",
      };
    case "skipped":
      return { text: line.reason === "failure-rate" && line.failed !== undefined && line.total !== undefined ? `пропущена: ${line.failed} из ${line.total} фото не прошли проверки` : SKIP_LOG[line.reason], tone: "danger" };
    case "waiting-music":
      return { text: `${videoLabel(line.key)} ждёт музыку · все треки короче ${seconds(line.neededMs)}`, tone: "warn" };
    case "review-approved-paused":
      return { text: `сцены приняты на паузе: ${countOf(line.photos, PHOTOS)} · ждут «Продолжить»`, tone: "info" };
    case "music-refresh":
      return { text: `тренды обновлены: +${countOf(line.added, TRACKS)} · осталось ${line.remaining} из 30`, tone: "plain" };
    case "stopped":
      return { text: `остановлен владельцем · потрачено ${spentUsd(line.spentMicros)}`, tone: "warn" };
    case "done":
      // An avatar's line is its own part done («готово: 10 из 10»); the launch's, the end of it all.
      return {
        text: line.avatarId === undefined ? `запуск завершён · ${line.videosDone} из ${line.videosPlanned}${NBSP}видео` : `готово: ${line.videosDone} из ${line.videosPlanned}`,
        tone: "ok",
      };
    case "hold-network":
      return { text: `нет ответа ${line.drops}-й раз · ждём сверки`, tone: "warn" };
    case "avatar-busy":
      return { text: "ждём: аватар занят вашей генерацией", tone: "warn" };
    case "open-set":
      return { text: "ждём: открыт ваш набор сцен", tone: "warn" };
    case "library-unknown":
      return { text: "ждём: не читается, какие фото свободны", tone: "warn" };
    case "app-restarted":
      return {
        text: line.cause === "quit" ? (line.requests > 0 ? "Studio открыт снова · нужна сверка" : "Studio открыт снова · запуск на паузе") : line.requests > 0 ? "движок перезапущен · нужна сверка" : "движок перезапущен · запуск на паузе",
        tone: "warn",
      };
    case "scenes-writing":
      return { text: `сцены пишутся: ${line.scenes}`, tone: "plain" };
    case "budget-ended":
      return { text: `месячный бюджет кончился · партия встала на ${line.done} из ${line.total}`, tone: "warn" };
    case "hold-key":
      return { text: "ключ OpenRouter отклонён · ждём новый", tone: "warn" };
    case "hold-credits":
      return { text: "на счёте OpenRouter нет денег · ждём пополнения", tone: "warn" };
    case "hold-halt":
      return { text: "расходы остановлены · нужна сверка", tone: "danger" };
    case "hold-price":
      return { text: line.detail.stage === "slice" ? "цена выросла: партия не помещается в остаток" : "цена выросла: сцены не помещаются в остаток", tone: "warn" };
    case "hold-price-unavailable":
      return { text: `цены не загрузились · повтор ${line.attempt} из 3`, tone: "warn" };
    case "hold-internal":
      if (line.holdKind === "job-failed") return { text: `задача остановилась с ошибкой · ${line.detail === undefined ? "" : `${line.detail} · `}«Продолжить» запустит её снова`, tone: "danger" };
      return { text: "внутренняя ошибка учёта · платная часть остановлена", tone: "danger" };
    case "hold-export":
      return { text: line.exportReason === "not-enough-space" ? "мало места на диске · рендеры ждут" : "папка «Готовые видео» недоступна · рендеры ждут", tone: "warn" };
    case "render-dropped":
      return { text: `${videoLabel(line.key)} не собралось: рендер не удался дважды`, tone: "warn" };
    case "render-retry":
      return { text: `${videoLabel(line.key)}: рендер не удался · пробуем ещё раз`, tone: "warn" };
  }
}

/** The log's tail, newest first (the card shows the last 20; the whole log is «Журнал» of the launch, S4.9c). */
export function logRows(launch: LaunchView, nameOf: (avatarId: string) => string): LogRow[] {
  return launch.logTail
    .map((line, i) => {
      const { text, tone } = logText(line, launch.draft.sceneReview);
      return { key: `${i}-${line.at}-${line.kind}`, at: clockSeconds(line.at), who: line.avatarId === undefined ? "—" : nameOf(line.avatarId), text, tone };
    })
    .reverse();
}

// ---------- «Остановить запуск?» by the phase of each set ----------

export interface StopSetLine {
  readonly avatarId: string;
  readonly name: string;
  readonly phase: string;
  readonly what: string;
}

/**
 * What «Стоп» does to each avatar's scene set (LaunchStates «Наборы сцен», round 1 M2): written or under review — back on «Фото» as an ordinary set;
 * approved with no batch yet — back as an open set; drawn in part — the started batch can be finished there by the owner's own click, the scenes not yet
 * drawn never will be; no set — nothing changes.
 */
export function stopSetLine(row: LaunchAvatarView, name: string): StopSetLine {
  const line = (phase: string, what: string): StopSetLine => ({ avatarId: row.avatarId, name, phase, what });
  if (row.sceneSetId === null) {
    if (row.photos.total === 0) return line("только библиотека", "Наборов сцен нет — ничего не меняется.");
    if (row.phase === "skipped") return line("пропущена", "Набора сцен нет — ничего не меняется.");
    return line("в очереди", "Набор сцен ещё не составлен — ничего не меняется.");
  }
  if (row.phase === "composing") return line("сцены пишутся", "Дождёмся ответа модели на текущий запрос и вернём набор на «Фото» обычным. Дописать или удалить его — решите там.");
  if (row.phase === "awaiting-review") return line("ждёт проверки", "Набор вернётся на «Фото» обычным: отрисовать его или удалить — решите там. За составление уже заплачено.");
  if (row.phase === "approved-waiting") return line("проверен, не начат", "Набор проверен, но партий ещё нет — вернётся на «Фото» обычным открытым набором.");
  const started = row.slice !== null || row.photos.done > 0;
  if (!started) return line("партия не начата", "Партий ещё нет — набор вернётся на «Фото» обычным открытым набором.");
  const phase = row.slice !== null && row.slice.total > 1 ? `партия ${row.slice.index} из ${row.slice.total}` : `рисуется ${row.photos.done} из ${row.photos.total}`;
  const resumable =
    row.resumableSlots > 0
      ? `Начатую партию (осталось ${countOf(row.resumableSlots, PHOTOS)}) можно доделать на «Фото» своим кликом`
      : "Начатые партии закончены";
  const undrawn =
    row.undrawnScenes > 0
      ? `. Остальные ${countOf(row.undrawnScenes, SCENES_ACC)} набора не нарисуются — их составление уже оплачено.`
      : "; других сцен в наборе нет.";
  if (row.phase === "montage" || row.phase === "done") {
    if (row.undrawnScenes === 0 && row.resumableSlots === 0) return line("нарисован", "Набор нарисован целиком — ничего не меняется.");
  }
  return line(phase, `${row.undrawnScenes === 0 && row.resumableSlots > 0 ? "Набор останется отрисованным частично. " : ""}${resumable}${undrawn}`);
}

/** Whether «Стоп» changes anything for the avatar's set: no set (library only, skipped or still queued) and a set drawn whole stay as they are. */
function stopChangesSet(row: LaunchAvatarView): boolean {
  if (row.sceneSetId === null) return false;
  return !((row.phase === "montage" || row.phase === "done") && row.undrawnScenes === 0 && row.resumableSlots === 0);
}

/**
 * The lines of «Наборы сцен», one per avatar of the launch: the sets «Стоп» changes first, then the avatars it leaves as they are, each group in the launch's
 * own order (S4.9b L4, ApStopConfirm: Sofia's set back on «Фото», Elena's drawn in part, then Mia's library).
 */
export function stopSetLines(launch: LaunchView, nameOf: (avatarId: string) => string): StopSetLine[] {
  const changes = launch.avatars.filter(stopChangesSet);
  const stays = launch.avatars.filter((row) => !stopChangesSet(row));
  return [...changes, ...stays].map((row) => stopSetLine(row, nameOf(row.avatarId)));
}
