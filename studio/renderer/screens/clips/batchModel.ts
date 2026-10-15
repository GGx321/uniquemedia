import {
  CLIP_REASONS_RU,
  clipBatchDroppedRu,
  clipCancelDetailRu,
  clipOptionKey,
  GROK_FALLBACK,
  type ClipBatchMemberSummary,
  type ClipBatchOptions,
  type ClipBatchSummary,
  type ClipCancelDetail,
  type ClipCost,
  type ClipCostKind,
  type ClipFailReason,
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
  // The renderer's one sum of figures here (plan s5b2 §5.2.1: «from MoneyStatus and the budget setting»): a hint on the pick bar, rounded down; noRendererMoney.test.ts lists it. It subtracts what
  // MoneyStatus tells and nothing else: the month holds a running batch keeps for its queued members are not in it — the engine's exact room, holds included (`clips.batchOptions.monthRoomMicros`),
  // is the sheet's, and it is live only while the sheet is open.
  const room = Math.max(0, money.monthlyBudgetMicros - money.spentMicros - money.unsettledMicros);
  const text = formatUsdTiered(room, "down");
  if (room < KLING_CLIP_WORST_MICROS) return { room: text, tail: "на клип не хватит" };
  if (mode === "auto" && room < AUTO_CLIP_WORST_MICROS) return { room: text, tail: "хватит только на клип без запасной модели" };
  const count = Math.floor(room / (mode === "auto" ? AUTO_CLIP_WORST_MICROS : KLING_CLIP_WORST_MICROS));
  return { room: text, tail: `это примерно ${count}${NBSP}${plural(count, CLIP_FORMS)}` };
}

// ---------- the members of a batch ----------

/**
 * Where a member stands: made, at work, waiting its turn, late, refused (its content refused), failed (no clip for another reason: a failed download, a second 429, …), not shot (no clip will come of
 * it), `removed` (no summary: a clip made in this window and deleted since — the window cannot say which it was), or `unknown` (no summary, and nothing of it left in the records or the jobs).
 */
export type MemberState = "done" | "run" | "wait" | "late" | "refused" | "failed" | "off" | "removed" | "unknown";

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
  /** At work, at most one (B1 makes one clip at a time; a member saving its file while the next prepares is one clip at work, L5). `late` is in no part (README question 2). */
  readonly running: number;
  /** `queued`: what «Отменить оставшиеся» takes. */
  readonly queued: number;
  /** Members no clip will come of: cancelled, stopped, their photo gone, dropped by a restart. */
  readonly notShot: number;
  readonly refused: number;
  readonly failed: number;
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
  /**
   * The engine's own summary of the batch (`clips.list` `batches`, S5.WB2c): its members' outcomes and every money word of the header. Absent for a batch from before the summaries or older than the twenty
   * listed: the header then counts what the records and jobs prove and says no money at all.
   */
  readonly summary?: ClipBatchSummary | null;
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
 * `KEEP_FINISHED`) the engine's newest summary; with none either (an engine before them), the newest record's batch. Null when the avatar has made no batch.
 */
export function latestBatchId(records: readonly ClipSummary[], jobs: readonly JobView[], summaries: readonly ClipBatchSummary[] = []): string | null {
  const fromJobs = batchJobs(jobs).at(-1)?.clip.batch?.batchId;
  if (fromJobs !== undefined) return fromJobs;
  const fromSummaries = summaries[0]?.batchId;
  if (fromSummaries !== undefined) return fromSummaries;
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
  /** Why an `off` member was not shot: the cancel's detail, or `dropped` (a restart, or the engine ending it without a word). */
  readonly why: ClipCancelDetail | "dropped" | null;
  /** Its money as the engine's summary says it; null without one (the header then names no money). */
  readonly money: { readonly micros: number; readonly kind: ClipCostKind } | null;
}

/** Refusals of content (the summary's `refused`), as a record without a summary tells them; any other failure is `failed`. */
const REFUSAL_REASONS: ReadonlySet<ClipFailReason> = new Set(["refused-free", "refused-both", "refused-paid", "refused-unknown", "grok-no-room"]);

interface MemberFacts {
  readonly index: number;
  /** Its records, oldest first. */
  readonly records: readonly ClipSummary[];
  /** Its jobs, in the order the window heard of them. */
  readonly jobs: readonly ClipJob[];
  /** The engine's word on it, when the batch has a summary. */
  readonly summary: ClipBatchMemberSummary | null;
  readonly recordIds: ReadonlySet<string>;
  readonly pending: (job: JobView) => boolean;
}

/** Where a member stands now: a job at work says it best (the summary is as fresh as the last list read), then the engine's summary, then — without one — only what the records and jobs prove. */
function readMember(m: MemberFacts): MemberRead {
  const last = m.records.at(-1);
  const byClip = m.summary === null ? null : new Set(m.summary.clipIds);
  const photoId = last?.photoId ?? m.jobs.findLast((job) => job.clip.facts !== undefined && (byClip === null || byClip.has(job.clip.clipId) || job.clip.batch?.index === m.index))?.clip.facts?.photoId ?? null;
  const money = m.summary === null ? null : { micros: m.summary.costMicros, kind: m.summary.costKind };
  const at = (state: MemberState, why: MemberRead["why"] = null): MemberRead => ({ index: m.index, state, photoId, why, money });
  const active = m.jobs.find(isActiveJob);
  if (active !== undefined) {
    const phase = active.clip.phase ?? "preparing";
    return at(phase === "queued" ? "wait" : phase === "late" ? "late" : "run");
  }
  // Its job ended and its record is on its way to the list: still the tile's «Сохраняем».
  if (m.jobs.some((job) => job.status === "done" && !m.recordIds.has(job.clip.clipId) && m.pending(job))) return at("run");
  const latest = m.jobs.at(-1);
  if (m.summary !== null) {
    const { outcome } = m.summary;
    if (outcome === "queued" || outcome === "running") {
      // Read before the member's job ended: the job that ended says more, until the list is read again.
      if (latest?.status === "cancelled") return at("off", latest.clip.detail ?? "dropped");
      if (latest?.status === "failed") return at("failed");
      return at(outcome === "queued" ? "wait" : "run");
    }
    if (outcome === "ready") return at("done");
    if (outcome === "refused") return at("refused");
    if (outcome === "failed") return at("failed");
    if (outcome === "cancelled") return at("off", m.summary.detail ?? "dropped");
    return at("off", "dropped");
  }
  // No summary: only facts. A record says what came of the member; a job's end says why nothing did; anything else is not known.
  if (last !== undefined) {
    if (last.status === "ready") return at("done");
    if (last.failure.reason === "rate-limited" && m.records.length === 1) {
      const retry = m.jobs.filter((job) => job.clip.clipId !== last.clipId).at(-1);
      if (retry?.status === "cancelled" && retry.clip.detail !== undefined) return at("off", retry.clip.detail);
      if (retry?.status === "failed") return at("failed");
      return at("unknown");
    }
    return at(REFUSAL_REASONS.has(last.failure.reason) ? "refused" : "failed");
  }
  if (latest?.status === "cancelled" && latest.clip.detail !== undefined) return at("off", latest.clip.detail);
  if (latest?.status === "failed") return at("failed");
  if (latest?.status === "done") return at("removed");
  return at("unknown");
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

/** Every member named is free by the engine's summary: only then may a line say «бесплатно». */
const allFree = (members: readonly MemberRead[]): boolean => members.length > 0 && members.every((m) => m.money?.kind === "free");

/**
 * The header of batch `batchId` (README decision 7): one line counting its members, the second line (a stop's, a restart's, a photo's, a refusal's at its worst), the tone, and the actions. Members and money
 * come from the engine's summary when the batch has one; without it, no money word at all. Null when the window holds nothing of the batch.
 */
export function batchView(batchId: string, input: BatchInput): BatchView | null {
  const summary = input.summary !== undefined && input.summary !== null && input.summary.batchId === batchId ? input.summary : null;
  const jobs = batchJobs(input.jobs).filter((job) => job.clip.batch?.batchId === batchId);
  const byIndex = recordsByIndex(input.records, batchId);
  const size = summary?.size ?? jobs[0]?.clip.batch?.size ?? input.records.find((record) => record.batchId === batchId)?.batchSize;
  if (size === undefined) return null;
  const pending = input.pending ?? (() => false);
  const recordIds = new Set(input.records.map((record) => record.clipId));
  const members = Array.from({ length: size }, (_, i) =>
    readMember({
      index: i + 1,
      records: byIndex.get(i + 1) ?? [],
      jobs: jobs.filter((job) => job.clip.batch?.index === i + 1),
      summary: summary?.members.find((member) => member.batchIndex === i + 1) ?? null,
      recordIds,
      pending,
    }),
  );
  const count = (state: MemberState): number => members.filter((m) => m.state === state).length;
  const counts: BatchCounts = {
    done: count("done"),
    running: Math.min(1, count("run")),
    queued: count("wait"),
    notShot: count("off"),
    refused: count("refused"),
    failed: count("failed"),
  };
  const off = members.filter((m) => m.state === "off");
  const gone = off.filter((m) => isOwnPhoto(m.why));
  const ownPhoto = gone.map((m) => m.why).findLast(isOwnPhoto);
  // The contract's photo line says «бесплатно»: only for a member the summary says is free.
  const photoLine = ownPhoto === undefined || !allFree(gone) ? null : clipCancelDetailRu(ownPhoto, 1);
  const base = { batchId, size, members: members.map(({ index, state, photoId }) => ({ index, state, photoId })), counts, again: null };
  const live = counts.running > 0 || counts.queued > 0;
  const close = counts.queued === 0 && counts.running === 0;

  // The engine's stop, else the one the members tell; a cancel is the batch's stop once nothing waits any more (one queued member cancelled on its own, `avatars.cancel`, leaves the rest waiting).
  const told = summary?.stop ?? STOPS.find((detail) => off.some((m) => m.why === detail));
  const stop = told === "cancelled" && counts.queued > 0 ? undefined : told;
  if (stop !== undefined) {
    const stopped = off.filter((m) => m.why === stop);
    const asked = input.cancelled?.batchId === batchId ? input.cancelled.count : 0;
    const n = stop === "cancelled" && asked > 0 ? asked : stopped.length;
    const again = stop === "price-changed" || stop === "price-unavailable" ? stopped.flatMap((m) => (m.photoId === null ? [] : [m.photoId])) : [];
    return {
      ...base,
      title: partsTitle(counts, size),
      line: allFree(stopped) && n > 0 ? clipCancelDetailRu(stop, n) : null,
      tone: stop === "cancelled" ? "info" : "warn",
      cancel: false,
      close,
      again: again.length > 0 ? again : null,
    };
  }
  if (live || count("late") > 0) return { ...base, title: partsTitle(counts, size), line: photoLine, tone: "run", cancel: counts.queued > 0, close };

  const dropped = off.filter((m) => m.why === "dropped");
  if (dropped.length > 0 || count("unknown") > 0) {
    // A restart dropped them (the summary's `dropped`): «Оставшиеся N … — бесплатно.» names only the ones the summary says are free. Without a summary nothing of them is known: no line.
    const free = dropped.filter((m) => m.money?.kind === "free").length;
    return { ...base, title: partsTitle(counts, size), line: free > 0 ? clipBatchDroppedRu(free) : null, tone: "info", cancel: false, close };
  }

  return { ...base, ...doneHeader(members, counts, summary), line: summary === null ? null : (worstLine(members) ?? photoLine), cancel: false, close };
}

const REFUSAL_FORMS = ["отказ", "отказа", "отказов"] as const;

/** The batch's money as the engine sums it (`ClipBatchSummary.cost`): billed to the nearest, a ceiling (at the worst) up, money still open «до $X», nothing owed «бесплатно» (L2). */
function batchMoney(cost: ClipCost): string {
  switch (cost.kind) {
    case "billed":
      return nearUsd(cost.micros);
    case "estimated":
      return upUsd(cost.micros);
    case "open":
      return `до ${upUsd(cost.micros)}`;
    case "free":
      return "бесплатно";
  }
}

/**
 * 60b: «Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78» (README decision 8). Every money word is the summary's: «бесплатно» after the refusals only when each refused member's money is `free`, the total
 * its `cost`. Without a summary: the counts alone, no money.
 */
function doneHeader(members: readonly MemberRead[], counts: BatchCounts, summary: ClipBatchSummary | null): { title: string; tone: BatchTone } {
  const refused = members.filter((m) => m.state === "refused");
  const refusalsFree = summary !== null && allFree(refused);
  const money = summary === null ? "" : summary.cost.kind === "free" && refusalsFree ? "" : batchMoney(summary.cost);
  const parts = [
    counts.done > 0 ? `${counts.done} ${plural(counts.done, CLIP_FORMS)}` : "",
    counts.refused > 0 ? `${counts.refused} ${plural(counts.refused, REFUSAL_FORMS)}${refusalsFree ? " бесплатно" : ""}` : "",
    counts.failed > 0 ? `${counts.failed} ${one(counts.failed) ? "не получился" : "не получились"}` : "",
    counts.notShot > 0 ? notShotPart(counts.notShot) : "",
    money,
  ].filter((part) => part !== "");
  const ok = summary !== null && (refused.length === 0 || refusalsFree) && (summary.cost.kind === "billed" || summary.cost.kind === "free");
  return { title: `Пакет готов: ${parts.join(" · ")}`, tone: ok ? "ok" : "info" };
}

/** 60b #worst: a refusal the summary says was settled at its worst says why it counts (round 2, M5); two or more say it once, with no figure the window would have to add up. */
function worstLine(members: readonly MemberRead[]): string | null {
  const worst = members.filter((m) => m.state === "refused" && m.money?.kind === "estimated");
  const first = worst[0];
  if (first === undefined || first.money === null) return null;
  if (worst.length === 1) return `Отказ учтён по максимуму ${upUsd(first.money.micros)}: не удалось доказать, что он бесплатный.`;
  return "Отказы учтены по максимуму: не удалось доказать, что они бесплатные.";
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
  /** The engine's Kling-only worst for the option, offered or not: what a refused «без запасной модели» needed (L6). */
  readonly worstNoFallbackMicros: number;
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
    worstNoFallbackMicros: sum.worstNoFallback,
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

/**
 * A batch's photo the engine calls `not-a-gallery-photo` is one that left the gallery after it was picked (the gallery offers nothing else): its row and the alert both say so (L8), not 5b.1's text
 * about imported photos and portrait variants.
 */
const NOT_IN_GALLERY_ROW = "Этого фото больше нет в галерее.";

/** The alert's short form of an item's reason (59 #item-refused); the row under it says the full text. */
const ITEM_SHORT: Partial<Record<ClipReason, string>> = {
  "photo-unreadable": "файл не читается",
  "not-a-gallery-photo": "этого фото больше нет в галерее",
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

/** A struck row's own reason: the contract's words, a photo gone from the gallery said as such (L8). */
const rowReason = (reason: ClipReason): string => (reason === "not-a-gallery-photo" ? NOT_IN_GALLERY_ROW : CLIP_REASONS_RU[reason]);

/**
 * What a row of the sheet says under «Фото N · категория»: its refusal after the click, the engine's reason it cannot be made, «без запасной модели» (the engine's `fallback: none` for the photo, L9 —
 * a frame of «Смелая» under `kling-only`), a photo in a video, a rejected one; null for a plain photo.
 */
export function batchRowNote(photo: PhotoSummary | null, item: ClipBatchOptions["items"][number] | undefined, refused: ClipReason | undefined): RowNote | null {
  if (refused !== undefined) return { text: rowReason(refused), struck: true, bold: false };
  if (item !== undefined && !item.suitable) return { text: rowReason(item.reason), struck: true, bold: false };
  if (item?.suitable === true && item.fallback === "none") return { text: ROW_BOLD, struck: false, bold: true };
  if (photo !== null && (photo.used || photo.usedIn.length > 0)) return { text: ROW_USED, struck: false, bold: false };
  if (photo?.rejected === true) return { text: ROW_REJECTED, struck: false, bold: false };
  return null;
}
