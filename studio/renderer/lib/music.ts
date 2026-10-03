import { MUSIC_QUOTA_WINDOW_DAYS, type EngineError, type MusicKeyStatus, type MusicStatus } from "../../shared/engine";
import { errorText } from "./errors";
import { countOf, NBSP } from "./format";

// What the Settings «Музыка» card says and allows (3c.6), from the RapidAPI key's state and the music status alone (K24).
// «Обновить» spends one of 30 flashapi requests per 31 days, so the card offers it only when the engine would let one leave,
// and sends it only after a confirmation that says what it costs. The words follow the plan, not the artboard's month
// (CF5): the window is a rolling 31 days, so the date is the one the oldest request leaves it (`nextFreeAt`).

const DAY_MS = 24 * 3600 * 1000;
const WINDOW_MS = MUSIC_QUOTA_WINDOW_DAYS * DAY_MS;

/** From this many requests left the bar turns amber and the button says how many remain (the components sheet's «у предела»). */
const NEAR_LIMIT_LEFT = 2;

function format(at: number, options: Intl.DateTimeFormatOptions, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("ru-RU", { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
}

/** «3 окт.»: a day and a month that never break apart. In the owner's own time zone unless one is given (tests). */
export function dayLabel(at: number, timeZone?: string): string {
  return format(at, { day: "numeric", month: "short" }, timeZone).replace(/\s/g, NBSP);
}

/** «21 сент., 14:02». */
function dayTimeLabel(at: number, timeZone?: string): string {
  const [day, time] = format(at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, timeZone).split(", ");
  return time === undefined ? (day ?? "").replace(/\s/g, NBSP) : `${(day ?? "").replace(/\s/g, NBSP)}, ${time}`;
}

/** Ends a sentence that may end on a date: «3 окт.» already has its dot (Russian never doubles it), «3 мая» needs one. */
function stop(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** «94 МБ», «2.4 МБ»: decimal megabytes, one decimal under 10. */
function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}${NBSP}МБ`;
}

/** A log that cannot be read or trusted counts as the whole quota spent (the engine's rule, pinned by the contract). */
function logClosed(status: MusicStatus): boolean {
  return status.quotaLog === "corrupt" || status.quotaLog === "unreadable";
}

export interface QuotaView {
  /** «отправлено 12 из 30 за 31 день». */
  line: string;
  /** The row's figure, as the artboard sets it: «12 из 30». */
  figure: { sent: number; limit: number };
  /** The bar's fill, 0 to 100. */
  share: number;
  /** The bar's colour: the accent, amber near the limit, the danger colour once nothing can leave. */
  tone: "accent" | "warn" | "danger";
  /** «следующий освободится 3 окт.»; null with nothing in the window or a log that cannot be read. */
  nextFree: string | null;
  /** flashapi's own count when it is lower than the local room: the server's figure wins for the floor. */
  server: string | null;
}

export function quotaView(status: MusicStatus, timeZone?: string): QuotaView {
  const { sentLast31d: sent, limit } = status;
  const left = limit - sent;
  const exhausted = left <= 0 || status.serverRemaining === 0 || logClosed(status);
  const nextFreeAt = status.nextFreeAt === null ? null : Date.parse(status.nextFreeAt);
  return {
    line: `отправлено ${sent} из ${limit} за 31${NBSP}день`,
    figure: { sent, limit },
    share: Math.min(100, Math.round((sent / limit) * 100)),
    tone: exhausted ? "danger" : left <= NEAR_LIMIT_LEFT ? "warn" : "accent",
    nextFree: nextFreeAt === null || sent === 0 || logClosed(status) ? null : `следующий освободится ${dayLabel(nextFreeAt, timeZone)}`,
    server: status.serverRemaining !== null && status.serverRemaining > 0 && status.serverRemaining < left ? `по последнему ответу flashapi осталось ${status.serverRemaining}` : null,
  };
}

/**
 * Whether «Обновить» may be asked now:
 * - `loading`: the status is not known yet;
 * - `running`: a refresh (or the downloads it left) is under way;
 * - `blocked`: the engine would refuse it; `reason` says why, `fix` names what the card offers (the key row, the log's recovery);
 * - `ready`: it may be asked; `confirm` is what the confirmation says before anything is spent.
 * The order is the engine's admission order where the owner can tell: the key, the log, then the quota.
 */
export type RefreshGate =
  | { kind: "loading" }
  | { kind: "running"; percent: number }
  | { kind: "blocked"; reason: string; fix: "key" | "recover" | null }
  | { kind: "ready"; confirm: string };

export function refreshGate(key: MusicKeyStatus, status: MusicStatus | null, now: number, timeZone?: string): RefreshGate {
  if (status === null) return { kind: "loading" };
  const { refresh } = status;
  if (refresh.state === "running") return { kind: "running", percent: Math.max(0, Math.min(100, Math.floor((refresh.done * 100) / Math.max(1, refresh.total)))) };
  if (!key.stored) return { kind: "blocked", reason: "Сначала добавьте ключ RapidAPI: без него запрос не отправится.", fix: "key" };
  if (key.rejected) return { kind: "blocked", reason: "RapidAPI отклонил ключ: замените его, и обновление снова станет доступно.", fix: "key" };
  if (status.quotaLog === "corrupt") return { kind: "blocked", reason: "Журнал запросов повреждён, поэтому запросы не отправляются. Восстановите его ниже.", fix: "recover" };
  if (status.quotaLog === "unreadable") return { kind: "blocked", reason: "Журнал запросов не читается, поэтому запросы не отправляются. Проверьте доступ к файлу и перезапустите Studio.", fix: null };
  if (status.quotaLog === "held") {
    return { kind: "blocked", reason: "Прошлый ответ ещё не записан в журнал запросов: проверьте место на диске, запись повторится, когда вы снова откроете эту карточку.", fix: null };
  }
  const nextFreeAt = status.nextFreeAt === null ? null : Date.parse(status.nextFreeAt);
  const when = nextFreeAt === null ? "позже" : dayLabel(nextFreeAt, timeZone);
  if (status.sentLast31d >= status.limit) return { kind: "blocked", reason: `${stop(`Квота кончилась: следующий запрос — ${when}`)} Список остаётся прежним.`, fix: null };
  if (status.serverRemaining === 0) return { kind: "blocked", reason: `${stop(`flashapi ответил, что запросов не осталось: следующий — ${when}`)} Список остаётся прежним.`, fix: null };
  const left = status.limit - status.sentLast31d - 1;
  // After this request the first slot to free is the oldest one in the window, or this very one 31 days from now.
  const frees = dayLabel(nextFreeAt ?? now + WINDOW_MS, timeZone);
  const server = status.serverRemaining !== null && status.serverRemaining - 1 < left ? ` По последнему ответу flashapi останется ${Math.max(0, status.serverRemaining - 1)}.` : "";
  return { kind: "ready", confirm: `${stop(`Спишется 1 запрос — останется ${left} из ${status.limit}; следующий освободится ${frees}`)} Ошибка тоже считается, повторов нет.${server}` };
}

/** What the button spends: «Обновить · 1 запрос», and near the limit how many are left (the components sheet). */
export function refreshLabel(status: MusicStatus): string {
  const left = status.limit - status.sentLast31d;
  if (left === 1) return "Обновить · последний запрос";
  if (left <= NEAR_LIMIT_LEFT) return `Обновить · 1 из ${left} оставшихся`;
  return "Обновить · 1 запрос";
}

const TRACKS = ["трек", "трека", "треков"] as const;

/** «только вручную · обновлено 21 сент., 14:02 · 30 треков · 94 МБ»: the list's age, size and that it changes only by the button. */
export function listLine(status: MusicStatus, timeZone?: string): string {
  if (status.listFetchedAt === null) return "только вручную · список ещё не загружался";
  // The count and the size stay on one line together, so a wrap never leaves «94 МБ» alone.
  const size = status.bytesOnDisk > 0 ? `${NBSP}·${NBSP}${megabytes(status.bytesOnDisk)}` : "";
  return ["только вручную", `обновлено ${dayTimeLabel(Date.parse(status.listFetchedAt), timeZone)}`, `${countOf(status.trackCount, TRACKS)}${size}`].join(" · ");
}

/** Why a refresh ended failed: MUSIC_UNAVAILABLE by its cause (errorText knows them), anything else by its code. */
export function musicFailureText(error: EngineError): string {
  return errorText(error);
}

/** Why a click was refused at once. IN_FLIGHT here is a refresh already running, not the paid requests its general text speaks of. */
export function refusalText(error: EngineError): string {
  if (error.code === "IN_FLIGHT") return "Обновление уже идёт: второй запрос не отправлен.";
  return musicFailureText(error);
}

/** What recovering a damaged log costs: the quota closed until exactly 31 days from now. */
export function recoveryText(now: number, timeZone?: string): { until: string; confirm: string } {
  const until = dayLabel(now + WINDOW_MS, timeZone);
  return {
    until,
    confirm: `Повреждённый журнал отложится в сторону, а квота закроется до ${until}: Studio посчитает, что за 31${NBSP}день ушли все 30 запросов. Ничего не отправится.`,
  };
}
