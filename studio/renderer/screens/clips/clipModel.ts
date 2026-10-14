import { CLIP_RETRYABLE_FAILURES, GROK_FALLBACK, type ClipCost, type ClipFace, type ClipFailReason, type ClipPhase, type ClipSummary } from "../../../shared/engine";
import { CLIP_LOST_TEXT, CLIP_RECOVERED_TEXT, CLIP_RECOVERING_TEXT } from "../../../shared/engine/clipRestartTexts";
import { NBSP } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §5.7 «Tiles», §6 states 40–43 and 46; the mockups 40, 41, 42, 43 and README §S5.VD / §S5.VD2): the words of a clip's tile, its viewer's facts and
// its queue row, from the engine's summary and job alone. Every figure is the engine's — the ledger's `ClipCost`, the offer's `grokOffer`, the provider's `providerCostMicros` — so this
// file picks and formats, and computes no money. A maximum (an open reserve, a settle at the worst, a ceiling) is rounded up; a sum the provider billed, to the nearest (the README's
// «Деньги на экране»).

type Ready = Extract<ClipSummary, { status: "ready" }>;
type Failed = Extract<ClipSummary, { status: "failed" }>;

/** A ceiling or a maximum: up. */
export const upUsd = (micros: number): string => formatUsdTiered(micros, "up");
/** What was billed: to the nearest. */
export const nearUsd = (micros: number): string => formatUsdTiered(micros, "nearest");

/** A cost as its kind reads: billed to the nearest, every other (open, at the worst) a maximum, rounded up. */
export function costFigure(cost: ClipCost): string {
  return cost.kind === "billed" ? nearUsd(cost.micros) : upUsd(cost.micros);
}

/** «0:05», «0:10»: a clip's length on its poster. */
export function clipLength(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A clip's seconds: the real file's for a ready clip, the request's for any other. */
export function secondsOf(clip: ClipSummary): number {
  return clip.status === "ready" ? Math.round(clip.durationMs / 1000) : clip.request.seconds;
}

/** «14:32»: a time as the owner's clock reads it (the restart texts' rule). */
export function clockLabel(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

const MONTHS_SHORT = ["янв.", "февр.", "мар.", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];

/** «сегодня, 14:06», «вчера, 19:12», «24 сент., 13:00»: when a clip was made, by the owner's calendar. */
export function whenLabel(iso: string, nowMs: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date(nowMs);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const time = clockLabel(at.getTime());
  if (days === 0) return `сегодня, ${time}`;
  if (days === 1) return `вчера, ${time}`;
  return `${at.getDate()} ${MONTHS_SHORT[at.getMonth()] ?? ""}, ${time}`;
}

/** «(OpenRouter: $0.42)»: the provider's own number, for information beside the ledger's (I5.49); empty when it named none. */
function providerNote(clip: ClipSummary): string {
  return clip.providerCostMicros === undefined ? "" : ` (OpenRouter: ${nearUsd(clip.providerCostMicros)})`;
}

// ---------- the face ----------

export interface FaceBadge {
  readonly kind: "ok" | "low" | "none";
  readonly text: string;
}

/** The poster's badge (§6 41): «лицо 0.71», «Лицо не совпало · 0.48», «лицо не проверялось». The check marks, never decides (I5.52). */
export function faceBadge(face: ClipFace): FaceBadge {
  if (face.verdict === "match" && face.p75 !== undefined) return { kind: "ok", text: `лицо ${face.p75.toFixed(2)}` };
  if (face.verdict === "mismatch" && face.p75 !== undefined) return { kind: "low", text: `Лицо не совпало · ${face.p75.toFixed(2)}` };
  return { kind: "none", text: "лицо не проверялось" };
}

const SKIPPED_WHY: Record<NonNullable<ClipFace["why"]>, string | null> = {
  hidden: "лицо скрыто в кадре",
  profile: "лицо в профиль",
  "few-faces": "мало кадров с лицом",
  // The worker broke: §6 names no reason for it, so the line says only that it was not checked.
  worker: null,
};

export interface FaceFact {
  readonly tone: "ok" | "warn" | "quiet";
  /** The similarity in mono, before the text (a match only). */
  readonly value: string | null;
  readonly text: string;
}

/** The viewer's «Лицо» (§6 43): «0.71 (по 11 кадрам)», «не совпало: 0.48 — клип оставлен, решать вам», «не проверялось: <почему>». */
export function faceFact(face: ClipFace): FaceFact {
  if (face.verdict === "match" && face.p75 !== undefined) return { tone: "ok", value: face.p75.toFixed(2), text: `(по ${face.frames} кадрам)` };
  if (face.verdict === "mismatch" && face.p75 !== undefined) return { tone: "warn", value: null, text: `не совпало: ${face.p75.toFixed(2)} — клип оставлен, решать вам` };
  const why = face.why === undefined ? null : SKIPPED_WHY[face.why];
  return { tone: "quiet", value: null, text: why === null ? "не проверялось" : `не проверялось: ${why}` };
}

// ---------- the model and the cost (§6 43) ----------

/** The resolution of the file as it came (I5.54: a pro request answered in 720p is badged 720p); a clip with no file, by the model that tried. */
function resolutionOf(clip: ClipSummary): "720p" | "1080p" {
  if (clip.status === "ready") return clip.height >= 1920 ? "1080p" : "720p";
  return clip.model === "kling-pro" ? "1080p" : "720p";
}

/** «Kling 3.0 · 720p · 5 с», «Kling 3.0 · 1080p · 5 с» (the approved 38's label), «Grok 1.5 · 720p · 5 с — запасная модель». */
export function modelFact(clip: ClipSummary): string {
  const name = clip.model === "grok" ? "Grok 1.5" : "Kling 3.0";
  const line = `${name} · ${resolutionOf(clip)} · ${secondsOf(clip)} с`;
  return clip.model === "grok" && clip.fallback ? `${line} — запасная модель` : line;
}

/** The viewer's «Стоимость»: what the ledger holds, a maximum rounded up and said as one, the provider's own number beside it. */
export function costFact(clip: ClipSummary): string {
  const { cost } = clip;
  switch (cost.kind) {
    case "billed":
      return nearUsd(cost.micros);
    case "free":
      return "бесплатно";
    case "estimated":
      return `${upUsd(cost.micros)} — списано по максимуму${clip.recovered ? " при сверке" : ""}${providerNote(clip)}`;
    case "open":
      return `до ${upUsd(cost.micros)} — спишется при сверке${providerNote(clip)}`;
  }
}

/** Whether a copy of the clip is in the export folder now: the newest export whose file is there (a `clips.list` without states counts every export as there). */
export function savedExport(clip: ClipSummary): ClipSummary["exports"][number] | null {
  return clip.exports.findLast((e) => e.fileState === undefined || e.fileState === "present") ?? null;
}

// ---------- a ready tile (§6 41, 46) ----------

/** The caption's money and time under a ready clip's poster: «$0.42 · сегодня, 14:06»; a restart's or a late arrival's line in its place. */
export function readyMeta(clip: Ready, nowMs: number): { line: string | null; meta: string } {
  const when = whenLabel(clip.createdAt, nowMs);
  const { cost } = clip;
  const money = cost.kind === "open" ? `до сверки: ${upUsd(cost.micros)}${providerNote(clip)}` : cost.kind === "estimated" ? `списано по максимуму ${upUsd(cost.micros)}${providerNote(clip)}` : null;
  if (clip.recovered) return { line: `${CLIP_RECOVERED_TEXT} · ${money ?? costFigure(cost)}`, meta: when };
  // A ready clip whose reserve waits for the reconcile came after its lifetime (I5.48: a late `completed` writes no ledger line); one settled at the worst with the provider's figure did too.
  if (cost.kind === "open" || (cost.kind === "estimated" && clip.providerCostMicros !== undefined)) return { line: `Клип пришёл с опозданием · ${money ?? ""}`, meta: when };
  return { line: null, meta: `${cost.kind === "estimated" ? `списано по максимуму ${upUsd(cost.micros)}` : costFigure(cost)} · ${when}` };
}

/** The pills at the poster's foot beside the length: what differs from the default clip, by the real file (§6 41c). */
export function readyTags(clip: Ready): string[] {
  return [...(clip.model === "grok" ? ["Grok"] : []), ...(clip.height >= 1920 ? ["1080p"] : [])];
}

// ---------- a failed tile (§6 42) ----------

export type FailAction = "again" | "redownload" | "grok";

export interface FailedTileModel {
  readonly text: string;
  /** By the money: a free end is calm, a paid or still open one warm (README decision 6). */
  readonly tone: "free" | "paid" | "open";
  /** The money line, only where the text does not name the money itself. */
  readonly money: string | null;
  readonly actions: readonly FailAction[];
  /** «до $0.85» of «Снять на Grok»: the engine's own price of the offer (I5.47). */
  readonly grokWorst?: string;
  /** «15:06» of «Скачать снова · до 15:06»: the end of the free retry, by the owner's clock. */
  readonly retryUntil?: string;
}

const FREE_AGAIN: ReadonlySet<ClipFailReason> = new Set(["refused-both", "refused-paid", "refused-free", "grok-no-room", "bad-request", "rate-limited"]);

/** «Kling» or «Grok»: the model that tried last. */
const modelName = (clip: ClipSummary): string => (clip.model === "grok" ? "Grok" : "Kling");

/** The open line: «до $0.51 — спишется при сверке»; after the reconcile «списано по максимуму $0.51»; a reserve never written, «бесплатно». */
function reconcileMoney(cost: ClipCost): string {
  if (cost.kind === "open") return `до ${upUsd(cost.micros)} — спишется при сверке`;
  if (cost.kind === "free") return "бесплатно";
  return cost.kind === "estimated" ? `списано по максимуму ${upUsd(cost.micros)}` : costFigure(cost);
}

/**
 * The words, the tone, the money line and the buttons of a clip that did not come (§5.7 «Tiles», §6 42, README §S5.VD «42 — плитки ошибок» and §S5.VD2). `bold`: the source photo is
 * a frame of «Смелая» kept to Kling (I5.57), so its free refusal says there is no fallback for it (42q). A paid download past its `retryDownloadUntil` reads as 42o, whose file the
 * provider no longer serves; the engine turns the record so at the next retry.
 */
export function failedTile(clip: Failed, ctx: { nowMs: number; bold: boolean; mode?: "auto" | "offer" }): FailedTileModel {
  const mode = ctx.mode ?? GROK_FALLBACK;
  const { cost } = clip;
  const tone = cost.kind === "free" ? "free" : cost.kind === "open" ? "open" : "paid";
  const until = clip.retryDownloadUntil === undefined ? null : Date.parse(clip.retryDownloadUntil);
  const retryable = CLIP_RETRYABLE_FAILURES.includes(clip.failure.reason);
  const expired = clip.failure.reason === "download-expired" || (retryable && (until === null || until <= ctx.nowMs));
  const reason: ClipFailReason = expired ? "download-expired" : clip.failure.reason;
  const paid = costFigure(cost);
  const openLine = cost.kind === "open" ? reconcileMoney(cost) : null;
  const again: FailAction[] = FREE_AGAIN.has(reason) ? ["again"] : [];
  const base = { tone, money: openLine, actions: again } as const;
  switch (reason) {
    case "refused-both":
      return { ...base, text: "Kling и Grok отказали — бесплатно" };
    case "refused-paid":
      return { ...base, text: `Отказ модели после генерации — оплачено ${paid}` };
    case "refused-unknown":
      return { ...base, text: `Отказ модели — стоимость не прочитана, списано по максимуму ${upUsd(cost.micros)}` };
    case "refused-free": {
      const offer = clip.failure.grokOffer;
      if (offer !== undefined) return { ...base, text: "Kling отказал бесплатно", actions: ["grok"], grokWorst: upUsd(offer.worstMicros) };
      if (clip.request.model === "grok") return { ...base, text: "Grok отказал бесплатно" };
      if (ctx.bold) return { ...base, text: "Kling отказал бесплатно — для кадров «Смелой» запасной модели нет" };
      // Mode auto with the fallback allowed runs Grok behind a free refusal: ending here means Grok's reserve was refused for no lack of room — paid work had stopped
      // (RECONCILE_REQUIRED, a halt; the banner above says which). A new string for the owner.
      if (mode === "auto" && clip.request.fallback === "auto") return { ...base, text: "Kling отказал бесплатно, а Grok не запущен: платные запросы были остановлены" };
      return { ...base, text: "Kling отказал бесплатно" };
    }
    case "provider-error":
      if (cost.kind === "free") return { ...base, text: `${modelName(clip)} не снял клип — бесплатно`, actions: ["again"] };
      if (cost.kind === "billed") return { ...base, text: `${modelName(clip)} не снял клип — оплачено ${paid}`, actions: [] };
      return { ...base, text: `${modelName(clip)} не снял клип — стоимость не прочитана, списано по максимуму ${upUsd(cost.micros)}`, actions: [] };
    case "grok-no-room":
      return { ...base, text: "Kling отказал бесплатно, а на Grok не хватило месячного бюджета" };
    case "bad-request":
      return { ...base, text: "OpenRouter не принял запрос — бесплатно" };
    case "rate-limited":
      return { ...base, text: "OpenRouter занят — бесплатно. Попробуйте через минуту." };
    case "key-invalid":
      return { ...base, text: "Ключ OpenRouter не принят", money: reconcileMoney(cost) };
    case "no-credits":
      return { ...base, text: "Не хватает средств на OpenRouter", money: reconcileMoney(cost) };
    case "submit-uncertain":
      return { ...base, text: "Неизвестно, оплачено ли — сверка покажет", money: reconcileMoney(cost) };
    case "late":
      return { ...base, text: "Клип так и не пришёл — сверка спишет его по максимуму", money: reconcileMoney(cost) };
    case "lost":
      return { ...base, text: CLIP_LOST_TEXT, money: reconcileMoney(cost) };
    case "download-failed":
      return { ...base, text: `Файл клипа не скачался — оплачено ${paid}`, actions: ["redownload"], retryUntil: clockLabel(until ?? 0) };
    case "invalid-file":
      return { ...base, text: `Файл клипа повреждён — оплачено ${paid}`, actions: ["redownload"], retryUntil: clockLabel(until ?? 0) };
    case "disk-full":
      return { ...base, text: "Нет места на диске — клип оплачен", money: paid, actions: ["redownload"], retryUntil: clockLabel(until ?? 0) };
    case "download-expired":
      return { ...base, text: `Файл у OpenRouter больше недоступен — оплачено ${paid}`, actions: [] };
  }
}

// ---------- a clip at work (§6 40) and its queue row ----------

export interface ClipProgress {
  readonly phase: ClipPhase;
  readonly model?: "kling" | "grok" | null;
  readonly submittedAt?: string | null;
  readonly proveUntil?: string | null;
}

export interface PhaseContext {
  readonly nowMs: number;
  /** When this window first saw the attempt on its way: the count starts there when the submit time is from another clock (I5.48's minutes are this window's). */
  readonly seenMs: number;
  /** The end of a late clip's wait, as the engine dates it (`reconcileAvailableAt`, I5.48), else null. */
  readonly lateUntilMs: number | null;
  /** The clip was started by «Снять на Grok» (a `model: "grok"` clip), so Grok is not a fallback behind a refusal. */
  readonly grokOffer: boolean;
}

/** A submit time this far from this window's clock is another clock's (the demo engine's, a sleeping machine's): counted from when it was seen instead. */
const PLAUSIBLE_ELAPSED_MS = 2 * 3_600_000;

function elapsedLabel(p: ClipProgress, ctx: PhaseContext): string {
  const submitted = p.submittedAt === undefined || p.submittedAt === null ? Number.NaN : Date.parse(p.submittedAt);
  const own = ctx.nowMs - submitted;
  const elapsed = Number.isFinite(own) && own >= 0 && own < PLAUSIBLE_ELAPSED_MS ? own : Math.max(0, ctx.nowMs - ctx.seenMs);
  return clipLength(elapsed);
}

export interface PhaseLine {
  readonly text: string;
  readonly tone: "work" | "warn" | "quiet";
  /** The poster's state pill. */
  readonly pill: string;
  /** Only before the POST (§5.1): «Отменить». */
  readonly cancel: boolean;
}

const lateText = (ctx: PhaseContext): string =>
  ctx.lateUntilMs === null ? "Задерживается — потом понадобится сверка расходов." : `Задерживается. Клип ещё может прийти до ${clockLabel(ctx.lateUntilMs)} — потом понадобится сверка расходов.`;

/** The running tile's line (§6 40, verbatim): «Готовим кадр» … «Восстанавливаем после перезапуска». */
export function phaseLine(p: ClipProgress, ctx: PhaseContext): PhaseLine {
  const work = (text: string, cancel = false): PhaseLine => ({ text, tone: "work", pill: "в работе", cancel });
  const grokBehind = p.model === "grok" && !ctx.grokOffer;
  switch (p.phase) {
    case "preparing":
      return work("Готовим кадр", true);
    case "submitting":
      return work(p.model === "grok" ? (grokBehind ? "Kling отказал бесплатно — снимает Grok" : "Отправляем в Grok") : "Отправляем в Kling");
    case "rendering":
      return work(grokBehind ? `Kling отказал бесплатно — снимает Grok · ${elapsedLabel(p, ctx)}` : `Снимается · ${elapsedLabel(p, ctx)}`);
    case "proving":
      return work(`${p.model === "grok" ? "Grok" : "Kling"} отказал — проверяем, что бесплатно · до 2 мин`);
    case "late":
      return { text: lateText(ctx), tone: "warn", pill: "задерживается", cancel: false };
    case "downloading":
      return work("Скачивается");
    case "checking":
      return work("Проверяем лицо");
    case "saving":
      return work("Сохраняем");
    case "recovering":
      return { text: CLIP_RECOVERING_TEXT, tone: "quiet", pill: "после перезапуска", cancel: false };
    case "exporting":
      return work("Сохраняем в папку");
  }
}

/** «40 %»: the frames an export encoded of all of them, floored. */
export function exportPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((done * 100) / total)));
}

/** The queue row's short phase (README §S5.VD «Что нарисовано не буквально» 9: the full texts do not fit the panel), and an export's «Сохраняем 40 %» (VD2 question 1). */
export function queuePhase(p: ClipProgress & { readonly done: number; readonly total: number }, ctx: PhaseContext): { text: string; warn: boolean } {
  const plain = (text: string): { text: string; warn: boolean } => ({ text, warn: false });
  switch (p.phase) {
    case "preparing":
      return plain("Готовим кадр");
    case "submitting":
      return plain("Отправляем");
    case "rendering":
      return plain(p.model === "grok" && !ctx.grokOffer ? `Grok · ${elapsedLabel(p, ctx)}` : `Снимается ${elapsedLabel(p, ctx)}`);
    case "proving":
      return plain("Проверка отказа");
    case "late":
      return { text: "Задерживается", warn: true };
    case "downloading":
      return plain("Скачивается");
    case "checking":
      return plain("Проверка лица");
    case "saving":
      return plain("Сохраняем");
    case "recovering":
      return plain("Восстановление");
    case "exporting":
      return plain(`Сохраняем ${exportPercent(p.done, p.total)}${NBSP}%`);
  }
}
