import {
  CLIP_REASONS_RU,
  clipBatchDroppedRu,
  clipCancelDetailRu,
  clipOptionKey,
  GROK_FALLBACK,
  type ClipBatchOptions,
  type ClipCancelDetail,
  type ClipOptionKey,
  type ClipQuality,
  type ClipReason,
  type ClipSeconds,
  type ClipSummary,
  type EngineError,
  type MoneyStatus,
  type PhotoSummary,
} from "../../../shared/engine";
import { isActiveJob, type JobView } from "../../engine/store";
import { NBSP, plural } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { nearUsd, upUsd } from "./clipModel";

// 5b.2, S5.WB4 (plan s5b2 §5.2, §6 rows 58a–60f; README §S5.WBD decisions 5–13 and «Для WB2 / WB4»): the batch «Оживить выбранные» as the window says it — the pick bar's month line, the sheet's
// figures and row notes, and the «Клипы» tab's header over the members. Every price on the sheet is the engine's (`clips.batchOptions`); the header counts the members by DISTINCT `batchIndex` over the records and
// the jobs, so it survives `KEEP_FINISHED` and a restart (I5.63, L9), and says the contract's own words for a stop (`clipCancelDetailRu`, `clipBatchDroppedRu`).

// ---------- the pick bar's month line (58a) ----------

/**
 * The divisors of «это примерно N клипов» (plan s5b2 §5.2.1, round 2 Q5): the worst case of one clip of the sheet's default option (Kling std 5 s, $0.504), and of the same clip with Grok behind it in mode
 * `auto` ($0.85). An estimate of how many clips the month holds, never what is charged: the sheet shows the engine's exact figure (`clips.batchOptions`).
 */
export const KLING_CLIP_WORST_MICROS = 504_000;
export const AUTO_CLIP_WORST_MICROS = 850_000;

const CLIP_FORMS = ["клип", "клипа", "клипов"] as const;

export interface MonthLine {
  /** «$6.20»: what the month has left, rounded DOWN (never more than there is). */
  readonly room: string;
  /** «это примерно 7 клипов», «хватит только на клип без запасной модели», «на клип не хватит». */
  readonly tail: string;
}

/**
 * «В этом месяце осталось $6.20 — это примерно 7 клипов» (§6 58a): the room from MoneyStatus — the budget less what was spent and what open reserves may still take — over the worst clip of the engine's mode,
 * floored. Null without a readable ledger: the line is left out and the sheet says the engine's figure.
 */
export function monthLine(money: MoneyStatus | null, mode: "auto" | "offer" = GROK_FALLBACK): MonthLine | null {
  if (money === null || money.ledger !== "open") return null;
  // The renderer's one sum of figures here (plan s5b2 §5.2.1: «from MoneyStatus and the budget setting»): a hint on the pick bar, rounded down; noRendererMoney.test.ts lists it.
  const room = Math.max(0, money.monthlyBudgetMicros - money.spentMicros - money.unsettledMicros);
  const text = formatUsdTiered(room, "down");
  if (room < KLING_CLIP_WORST_MICROS) return { room: text, tail: "на клип не хватит" };
  if (mode === "auto" && room < AUTO_CLIP_WORST_MICROS) return { room: text, tail: "хватит только на клип без запасной модели" };
  const count = Math.floor(room / (mode === "auto" ? AUTO_CLIP_WORST_MICROS : KLING_CLIP_WORST_MICROS));
  return { room: text, tail: `это примерно ${count}${NBSP}${plural(count, CLIP_FORMS)}` };
}

// ---------- the members of a batch ----------

/**
 * Where a member stands: made, at work, waiting its turn, late, refused (a record that is not a clip), not shot (no clip will come of it), or `removed` — made, and its record since deleted by the owner
 * (its job ended `done` and the list read after that holds nothing of it): in no part, and never «не снимался».
 */
export type MemberState = "done" | "run" | "wait" | "late" | "refused" | "off" | "removed";

export interface BatchMember {
  /** 1-based, the pick order. */
  readonly index: number;
  readonly state: MemberState;
  /** The member's photo, for the header's strip; null when nothing this window holds names it. */
  readonly photoId: string | null;
}

export type BatchTone = "run" | "ok" | "info" | "warn";

export interface BatchCounts {
  readonly done: number;
  /** At work: from `preparing` to `saving`, a recovery included; `late` is in no part (README question 2). */
  readonly running: number;
  /** `queued`: what «Отменить оставшиеся» takes. */
  readonly queued: number;
  /** Members no clip will come of: cancelled, stopped, their photo gone, dropped by a restart. */
  readonly notShot: number;
  readonly refused: number;
}

export interface BatchView {
  readonly batchId: string;
  readonly size: number;
  readonly members: readonly BatchMember[];
  readonly counts: BatchCounts;
  readonly title: string;
  /** The second line: a stop, a cancel, a restart, a photo gone, a refusal counted at its worst; null when there is none. */
  readonly line: string | null;
  readonly tone: BatchTone;
  /** «Отменить оставшиеся»: members still wait their turn and no stop took them. */
  readonly cancel: boolean;
  /** ✕ «Закрыть»: nothing waits and nothing is at work (a late clip may still come: its tile says so). */
  readonly close: boolean;
  /** 60e «Отметить их снова»: the photos a price stop left unmade, in batch order; null when not offered. */
  readonly again: readonly string[] | null;
}

export interface BatchInput {
  /** The avatar's `clips.list`, newest first. */
  readonly records: readonly ClipSummary[];
  /** The store's jobs: only the clip create jobs of the batch are read. */
  readonly jobs: readonly JobView[];
  /** A job that ended `done` whose record the list on show does not hold yet (ClipsTab's `behind`): it is still at work. */
  readonly pending?: (job: JobView) => boolean;
  /** What this window's «Отменить оставшиеся» was answered (`clips.cancelBatch`'s `{cancelled}`, L11). */
  readonly cancelled?: { readonly batchId: string; readonly count: number } | null;
}

type ClipJob = JobView & { readonly clip: NonNullable<JobView["clip"]> };

function batchJobs(jobs: readonly JobView[]): ClipJob[] {
  return jobs.filter((job): job is ClipJob => job.kind === "clip" && job.clip !== undefined && job.clip.batch !== undefined && !job.clip.export);
}

/**
 * The batch the header is about: the newest one this window knows. Batches never overlap (one money unit, I5.61), so the last batch member among the jobs is the newest; with none (a restart, or past
 * `KEEP_FINISHED`) the newest record's batch. Null when the avatar has made no batch.
 */
export function latestBatchId(records: readonly ClipSummary[], jobs: readonly JobView[]): string | null {
  const fromJobs = batchJobs(jobs).at(-1)?.clip.batch?.batchId;
  if (fromJobs !== undefined) return fromJobs;
  return records.find((record) => record.batchId !== undefined)?.batchId ?? null;
}

/** A member's records, oldest first (a 429's requeue gives a member two). `clips.list` is newest first: ties keep that order reversed. */
function recordsByIndex(records: readonly ClipSummary[], batchId: string): Map<number, ClipSummary[]> {
  const byIndex = new Map<number, ClipSummary[]>();
  const oldestFirst = [...records].reverse().filter((record) => record.batchId === batchId && record.batchIndex !== undefined);
  oldestFirst.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const record of oldestFirst) {
    const index = record.batchIndex ?? 0;
    byIndex.set(index, [...(byIndex.get(index) ?? []), record]);
  }
  return byIndex;
}

/** The stop details, in the order one is named when several were told. A photo gone or unreadable is the member's own and stops nothing. */
const STOPS: readonly ClipCancelDetail[] = ["ledger-stopped", "money-uncertain", "price-changed", "price-unavailable", "cancelled"];
type OwnPhotoDetail = "photo-gone" | "photo-unreadable";
const isOwnPhoto = (why: MemberRead["why"]): why is OwnPhotoDetail => why === "photo-gone" || why === "photo-unreadable";

interface MemberRead extends BatchMember {
  /** Why an `off` member was not shot: the cancel's detail, its job's failure, or `dropped` (a restart, or the engine ending it without a word). */
  readonly why: ClipCancelDetail | "failed" | "dropped" | null;
}

/** Why a member none of whose jobs is at work came to nothing: by its latest job. A cancel the engine gave no reason for is not the owner's: it is dropped, as a restart drops. */
function offWhy(jobs: readonly ClipJob[]): MemberRead["why"] {
  const latest = jobs.at(-1);
  if (latest?.status === "cancelled") return latest.clip.detail ?? "dropped";
  if (latest?.status === "failed") return "failed";
  return "dropped";
}

function readMember(index: number, records: readonly ClipSummary[], jobs: readonly ClipJob[], recordIds: ReadonlySet<string>, pending: (job: JobView) => boolean): MemberRead {
  const last = records.at(-1);
  const photoId = last?.photoId ?? jobs.findLast((job) => job.clip.facts !== undefined)?.clip.facts?.photoId ?? null;
  const at = (state: MemberState, why: MemberRead["why"] = null): MemberRead => ({ index, state, photoId, why });
  const active = jobs.find(isActiveJob);
  if (active !== undefined) {
    const phase = active.clip.phase ?? "preparing";
    return at(phase === "queued" ? "wait" : phase === "late" ? "late" : "run");
  }
  // Its job ended and its record is on its way to the list: still the tile's «Сохраняем».
  if (jobs.some((job) => job.status === "done" && !recordIds.has(job.clip.clipId) && pending(job))) return at("run");
  /** A job of this member that made a record the list read after it no longer holds: the owner deleted that record. */
  const deleted = (except: string | null): boolean => jobs.some((job) => job.status === "done" && job.clip.clipId !== except && !recordIds.has(job.clip.clipId));
  if (last !== undefined) {
    if (last.status === "ready") return at("done");
    if (last.failure.reason === "rate-limited" && records.length === 1) {
      // The first 429's record deleted: this one is the retry's, the member's final refusal.
      if (deleted(last.clipId)) return at("refused");
      // A first 429 whose retry never ran (the owner cancelled it, a stop came first, a restart dropped it): no clip came of the member, for free.
      return at("off", offWhy(jobs.filter((job) => job.clip.clipId !== last.clipId)));
    }
    return at("refused");
  }
  if (jobs.at(-1)?.status === "done" && deleted(null)) return at("removed");
  return at("off", offWhy(jobs));
}

const one = (n: number): boolean => n % 10 === 1 && n % 100 !== 11;
const notShotPart = (n: number): string => `не ${one(n) ? "снимался" : "снимались"} ${n}`;

/** §6 60's line, a zero part left out (L5): «Пакет · 4 из 10 готовы · снимается 1 · в очереди 5 · не снимались N». */
function partsTitle(c: BatchCounts, size: number): string {
  return [
    c.done > 0 ? `Пакет · ${c.done} из ${size} ${one(c.done) ? "готов" : "готовы"}` : "Пакет",
    c.running > 0 ? `снимается ${c.running}` : "",
    c.queued > 0 ? `в очереди ${c.queued}` : "",
    c.notShot > 0 ? notShotPart(c.notShot) : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * The header of batch `batchId` (README decision 7): one line counting its members, the second line (a stop's, a restart's, a photo's), the tone by the money, and the actions. Null when the window holds
 * nothing of the batch.
 */
export function batchView(batchId: string, input: BatchInput): BatchView | null {
  const jobs = batchJobs(input.jobs).filter((job) => job.clip.batch?.batchId === batchId);
  const byIndex = recordsByIndex(input.records, batchId);
  const size = jobs[0]?.clip.batch?.size ?? input.records.find((record) => record.batchId === batchId)?.batchSize;
  if (size === undefined) return null;
  const pending = input.pending ?? (() => false);
  const recordIds = new Set(input.records.map((record) => record.clipId));
  const members = Array.from({ length: size }, (_, i) =>
    readMember(
      i + 1,
      byIndex.get(i + 1) ?? [],
      jobs.filter((job) => job.clip.batch?.index === i + 1),
      recordIds,
      pending,
    ),
  );
  const count = (state: MemberState): number => members.filter((m) => m.state === state).length;
  const counts: BatchCounts = { done: count("done"), running: count("run"), queued: count("wait"), notShot: count("off"), refused: count("refused") };
  const off = members.filter((m) => m.state === "off");
  const ownPhoto = off.map((m) => m.why).findLast(isOwnPhoto);
  const photoLine = ownPhoto === undefined ? null : clipCancelDetailRu(ownPhoto, 1);
  const base = { batchId, size, members: members.map(({ index, state, photoId }) => ({ index, state, photoId })), counts, again: null };
  const live = counts.running > 0 || counts.queued > 0;
  const close = counts.queued === 0 && counts.running === 0;

  // A cancel is the batch's stop once nothing waits any more: one queued member cancelled on its own (`avatars.cancel`) leaves the rest waiting.
  const stop = STOPS.find((detail) => off.some((m) => m.why === detail) && (detail !== "cancelled" || counts.queued === 0));
  if (stop !== undefined) {
    const told = off.filter((m) => m.why === stop);
    const asked = input.cancelled?.batchId === batchId ? input.cancelled.count : 0;
    const n = stop === "cancelled" && asked > 0 ? asked : told.length;
    const priced = stop === "price-changed" || stop === "price-unavailable";
    const again = priced ? told.flatMap((m) => (m.photoId === null ? [] : [m.photoId])) : [];
    return {
      ...base,
      title: partsTitle(counts, size),
      line: clipCancelDetailRu(stop, n),
      tone: stop === "cancelled" ? "info" : "warn",
      cancel: false,
      close,
      again: again.length > 0 ? again : null,
    };
  }
  if (live || count("late") > 0) return { ...base, title: partsTitle(counts, size), line: photoLine, tone: "run", cancel: counts.queued > 0, close };

  const dropped = off.filter((m) => m.why === "dropped").length;
  if (dropped > 0) return { ...base, title: partsTitle(counts, size), line: clipBatchDroppedRu(dropped), tone: "info", cancel: false, close };

  const finals = finalRecords(input.records, batchId, members);
  return { ...base, ...doneHeader(input.records, batchId, finals, counts), line: worstLine(finals) ?? photoLine, cancel: false, close };
}

const REFUSAL_FORMS = ["отказ", "отказа", "отказов"] as const;

/** The members' final records (a member's newest): what the batch made and what it refused. */
function finalRecords(records: readonly ClipSummary[], batchId: string, members: readonly MemberRead[]): ClipSummary[] {
  const byIndex = recordsByIndex(records, batchId);
  return members.flatMap((m) => {
    const last = m.state === "done" || m.state === "refused" ? byIndex.get(m.index)?.at(-1) : undefined;
    return last === undefined ? [] : [last];
  });
}

/**
 * 60b: «Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78» (README decision 8). «бесплатно» only when every refusal's cost is `free`; the sum is every record's cost of the batch (a hidden first 429 is free)
 * — billed to the nearest, and rounded up once it holds a ceiling (a cost at the worst, or still open).
 */
function doneHeader(records: readonly ClipSummary[], batchId: string, finals: readonly ClipSummary[], counts: BatchCounts): { title: string; tone: BatchTone } {
  const own = records.filter((record) => record.batchId === batchId);
  const refusals = finals.filter((record) => record.status === "failed");
  const free = refusals.every((record) => record.cost.kind === "free");
  // No engine figure sums a batch (plan s5b2 §6 60b): the header adds its records' ledger costs, each the engine's own (`ClipCost`, I5.49). noRendererMoney.test.ts lists it.
  const total = own.reduce((totalMicros, record) => totalMicros + record.cost.micros, 0);
  const ceiling = own.some((record) => record.cost.kind === "estimated" || record.cost.kind === "open");
  const parts = [
    counts.done > 0 ? `${counts.done} ${plural(counts.done, CLIP_FORMS)}` : "",
    refusals.length > 0 ? `${refusals.length} ${plural(refusals.length, REFUSAL_FORMS)}${free ? " бесплатно" : ""}` : "",
    counts.notShot > 0 ? notShotPart(counts.notShot) : "",
    ceiling ? upUsd(total) : nearUsd(total),
  ].filter((part) => part !== "");
  return { title: `Пакет готов: ${parts.join(" · ")}`, tone: free ? "ok" : "info" };
}

/** 60b #worst: a refusal settled at its worst says why it is counted in the sum (round 2, M5). Null when none is. */
function worstLine(finals: readonly ClipSummary[]): string | null {
  const worst = finals.filter((record) => record.status === "failed" && record.cost.kind === "estimated");
  const first = worst[0];
  if (first === undefined) return null;
  if (worst.length === 1) return `Отказ учтён по максимуму ${upUsd(first.cost.micros)}: не удалось доказать, что он бесплатный.`;
  return `Отказы учтены по максимуму ${upUsd(worst.reduce((worstMicros, record) => worstMicros + record.cost.micros, 0))}: не удалось доказать, что они бесплатные.`;
}

// ---------- the records of a batch on the «Клипы» tab (README decision 9) ----------

/** `hidden`: the first record of a member that has a later one (one tile per member). `batch-retry`: a first 429 whose retry is still on its way (no «Оживить снова…»). */
export type RecordRole = "hidden" | "batch-retry";

/** How the batch members' records are drawn, by clip id; a record with no role is drawn as 5b.1 draws it. */
export function batchRecordRoles(records: readonly ClipSummary[], jobs: readonly JobView[], pending: (job: JobView) => boolean = () => false): ReadonlyMap<string, RecordRole> {
  const roles = new Map<string, RecordRole>();
  const members = batchJobs(jobs);
  const batches = new Set(records.flatMap((record) => (record.batchId === undefined ? [] : [record.batchId])));
  for (const batchId of batches) {
    for (const [index, own] of recordsByIndex(records, batchId)) {
      for (const record of own.slice(0, -1)) roles.set(record.clipId, "hidden");
      const last = own.at(-1);
      if (last === undefined || last.status !== "failed" || last.failure.reason !== "rate-limited" || own.length !== 1) continue;
      const retry = members.some((job) => job.clip.batch?.batchId === batchId && job.clip.batch.index === index && job.clip.clipId !== last.clipId && (isActiveJob(job) || (job.status === "done" && pending(job))));
      if (retry) roles.set(last.clipId, "batch-retry");
    }
  }
  return roles;
}

// ---------- the sheet «Оживить N фото» (59–59c) ----------

export interface BatchSheetChoice {
  readonly quality: ClipQuality;
  readonly seconds: ClipSeconds;
}

export interface BatchButton {
  /** The accepted worst a click sends: the engine's sum for this option. */
  readonly worstMicros: number;
  /** «до $3.06». */
  readonly label: string;
}

export interface BatchSheetView {
  readonly key: ClipOptionKey;
  /** «Обычно $1.68 · не больше $3.06». */
  readonly expected: string;
  readonly worst: string;
  /** «Осталось в месяце $6.20»: the engine's room, rounded DOWN. */
  readonly room: string;
  /** The clips the batch would make: the photos the engine can bring to life. «Оживить 4». */
  readonly count: number;
  /** Some member may fall back to Grok (mode `auto`, a frame that is not «Смелая»): the Grok line, and a second button when only Kling fits. */
  readonly auto: boolean;
  /** The month takes the option as the main button sends it. */
  readonly fits: boolean;
  readonly main: BatchButton;
  /** «Оживить без запасной модели · до $5.04» (59b): the month holds the batch on Kling alone and not with Grok behind it. */
  readonly noFallback: BatchButton | null;
  /** 59b's «пакету нужно до $8.50» while the main button waits; null when it fits. */
  readonly budgetNeed: string | null;
  /** «Запасная модель (Grok) снимает в 720p»: «Чётче» in mode auto. */
  readonly proNote: boolean;
}

/** The sheet's figures for the option on show, read off the engine's `clips.batchOptions` alone (sums, room and fit). */
export function batchSheetView(options: ClipBatchOptions, choice: BatchSheetChoice): BatchSheetView {
  const key = clipOptionKey(choice.quality, choice.seconds);
  const sum = options.sums[key];
  const fit = options.monthFits[key];
  const auto = options.items.some((item) => item.suitable && item.fallback === "auto");
  // With a member that may fall back, the main button sends the worst with Grok behind it; with none, `without-fallback` is the batch's own worst.
  const fits = auto ? fit === "with-fallback" : fit !== "none";
  return {
    key,
    expected: nearUsd(sum.expected),
    worst: upUsd(sum.worst),
    room: formatUsdTiered(options.monthRoomMicros, "down"),
    count: options.items.filter((item) => item.suitable).length,
    auto,
    fits,
    main: { worstMicros: sum.worst, label: `до ${upUsd(sum.worst)}` },
    noFallback: auto && fit === "without-fallback" ? { worstMicros: sum.worstNoFallback, label: `до ${upUsd(sum.worstNoFallback)}` } : null,
    budgetNeed: fits ? null : upUsd(sum.worst),
    proNote: auto && choice.quality === "pro",
  };
}

/** `clips.createBatch` refused one item (VALIDATION with its own `clipReason` at `["items", i]`): which photo of those sent, and why. Null for any other refusal. */
export function itemRefusal(error: EngineError, sent: readonly string[]): { readonly photoId: string; readonly reason: ClipReason } | null {
  const [root, index] = error.path ?? [];
  if (error.code !== "VALIDATION" || error.clipReason === undefined || root !== "items" || typeof index !== "number") return null;
  const photoId = sent[index];
  return photoId === undefined ? null : { photoId, reason: error.clipReason };
}

/** The alert's short form of an item's reason (59 #item-refused); the row under it says the full text (`CLIP_REASONS_RU`). */
const ITEM_SHORT: Partial<Record<ClipReason, string>> = {
  "photo-unreadable": "файл не читается",
  "not-a-gallery-photo": "фото больше нет в галерее",
  "age-unverified": "кадр не прошёл проверку возраста",
  "not-vertical": "кадр не вертикальный 9:16",
  "bold-off": "кадры «Смелой» пока не оживляются",
  "no-motion": "движение не подобрать",
  "unknown-motion": "движение больше недоступно",
};

/** «Фото 5 · Виды не оживить: файл не читается. Сумма пересчитана — подтвердите ещё раз.» */
export function itemRefusedAlert(label: string, reason: ClipReason): string {
  const short = ITEM_SHORT[reason];
  return `${label} не оживить${short === undefined ? "" : `: ${short}`}. Сумма пересчитана${NBSP}— подтвердите ещё раз.`;
}

export interface RowNote {
  readonly text: string;
  /** The row will not be a clip: struck, the reason itself in place of «не оживляется» (round 2, L1); no motion list. */
  readonly struck: boolean;
  /** «без запасной модели», in the accent. */
  readonly bold: boolean;
}

const ROW_BOLD = "без запасной модели";
const ROW_USED = `фото уже в видео${NBSP}— клип в монтаж не ставится`;
const ROW_REJECTED = "пока фото отклонено, клип в монтаж не ставится";

/** What a row of the sheet says under «Фото N · категория»: its refusal after the click, the engine's reason it cannot be made, «Смелая», a photo in a video, a rejected one; null for a plain photo. */
export function batchRowNote(photo: PhotoSummary | null, item: ClipBatchOptions["items"][number] | undefined, refused: ClipReason | undefined): RowNote | null {
  if (refused !== undefined) return { text: CLIP_REASONS_RU[refused], struck: true, bold: false };
  if (item !== undefined && !item.suitable) return { text: CLIP_REASONS_RU[item.reason], struck: true, bold: false };
  if (item?.suitable === true && item.bold) return { text: ROW_BOLD, struck: false, bold: true };
  if (photo !== null && (photo.used || photo.usedIn.length > 0)) return { text: ROW_USED, struck: false, bold: false };
  if (photo?.rejected === true) return { text: ROW_REJECTED, struck: false, bold: false };
  return null;
}
