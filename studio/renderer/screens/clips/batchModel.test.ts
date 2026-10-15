import { describe, expect, test } from "bun:test";
import { CLIP_REASONS_RU, type ClipBatchOptions, type ClipCancelDetail, type ClipCost, type ClipFailReason, type ClipOptions, type ClipSummary, type MoneyStatus } from "../../../shared/engine";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import type { ClipJobInfo, JobView } from "../../engine/store";
import { batchRecordRoles, batchRowNote, batchSheetView, batchView, itemRefusal, itemRefusedAlert, latestBatchId, monthLine, type BatchInput } from "./batchModel";

// 5b.2, S5.WB4 (plan s5b2 §5.2, §6 rows 58a–60f; README §S5.WBD «Одни данные на все страницы», decisions 7–9, «Для WB2 / WB4»): what the window says about a batch. The pick bar's month line
// (from MoneyStatus, rounded DOWN, divided by the worst clip of the mode), the «Клипы» header counted by DISTINCT `batchIndex` over the records and the jobs (so it survives `KEEP_FINISHED` and a restart), the
// first-429 rule, «бесплатно» only for a refusal proven free, the cancel count from `clips.cancelBatch`, the sheet's sums and the per-row refusal after the click.

const NBSP = " ";
const AVATAR = "avatar-nini-0001";
const BATCH = "batch-0000001";
const OLD_BATCH = "batch-0000000";

// ---------- builders ----------

const BILLED: ClipCost = { kind: "billed", micros: 420_000 };
const FREE: ClipCost = { kind: "free", micros: 0 };
const WORST: ClipCost = { kind: "estimated", micros: 504_000 };

let at = Date.UTC(2026, 9, 15, 11, 21);
const nextAt = (): string => new Date((at += 60_000)).toISOString();

function common(index: number, o: { batchId?: string; size?: number; cost?: ClipCost; clipId?: string; photoId?: string } = {}) {
  return {
    clipId: o.clipId ?? `clip-b${index}-${at}`,
    avatarId: AVATAR,
    photoId: o.photoId ?? `photo-${index}`,
    createdAt: nextAt(),
    seen: false,
    motion: { source: "code" as const, label: "Как в сцене", text: "she blinks" },
    request: { model: "kling" as const, quality: "std" as const, seconds: 5 as const, fallback: "auto" as const },
    model: "kling-std" as const,
    fallback: false,
    recovered: false,
    cost: o.cost ?? BILLED,
    exports: [],
    batchId: o.batchId ?? BATCH,
    batchIndex: index,
    batchSize: o.size ?? 10,
  };
}

function ready(index: number, o: Parameters<typeof common>[1] = {}): ClipSummary {
  return { ...common(index, o), status: "ready", width: 720, height: 1280, durationMs: 5000, face: { verdict: "skipped", frames: 0 } };
}

function failed(index: number, reason: ClipFailReason, o: Parameters<typeof common>[1] = {}): ClipSummary {
  return { ...common(index, { cost: FREE, ...o }), status: "failed", failure: { reason } };
}

let jobN = 0;
function job(index: number, info: Partial<ClipJobInfo>, patch: Partial<JobView> = {}, o: { batchId?: string; size?: number; photoId?: string } = {}): JobView {
  const jobId = `job-${String(++jobN).padStart(8, "0")}`;
  return {
    jobId,
    kind: "clip",
    avatarId: AVATAR,
    runId: null,
    montageId: null,
    videoId: null,
    status: "running",
    saving: false,
    done: 0,
    total: 4,
    result: null,
    error: null,
    clip: {
      clipId: jobId,
      phase: "queued",
      model: null,
      submittedAt: null,
      proveUntil: null,
      recovery: false,
      export: false,
      facts: { photoId: o.photoId ?? `photo-${index}`, request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" }, motion: { source: "code", label: "Как в сцене" }, acceptedWorstMicros: 504_000 },
      batch: { batchId: o.batchId ?? BATCH, index, size: o.size ?? 10 },
      ...info,
    },
    ...patch,
  };
}

const queued = (index: number, waitReason: ClipJobInfo["waitReason"] = "turn"): JobView => job(index, { phase: "queued", waitReason });
const rendering = (index: number): JobView => job(index, { phase: "rendering", model: "kling" });
const cancelledJob = (index: number, detail: ClipCancelDetail): JobView => job(index, { phase: "queued", detail }, { status: "cancelled" });
/** The record of a ready member, newest first as `clips.list` gives them. */
const newestFirst = (records: ClipSummary[]): ClipSummary[] => [...records].reverse();
const readyRange = (from: number, to: number): ClipSummary[] => Array.from({ length: to - from + 1 }, (_, i) => ready(from + i));

function view(input: BatchInput) {
  const v = batchView(BATCH, input);
  if (v === null) throw new Error("no batch view");
  return v;
}

// ---------- the month line (58a) ----------

function money(spentMicros: number, unsettledMicros = 0, monthlyBudgetMicros = 10_000_000): MoneyStatus {
  return { ledger: "open", month: "2026-10", monthlyBudgetMicros, spentMicros, unsettledMicros, unsettledCount: unsettledMicros > 0 ? 1 : 0, reconcileNeeded: false, reconcileReasons: [], halt: null } as MoneyStatus;
}

describe("the pick bar's month line (58a)", () => {
  test("$10 budget, $3.80 spent: «осталось $6.20 — это примерно 7 клипов» — the room over $0.85 in mode auto, floored", () => {
    expect(monthLine(money(3_800_000), "auto")).toEqual({ room: "$6.20", tail: `это примерно 7${NBSP}клипов` });
  });

  test("in mode offer the divisor is Kling alone, $0.504: «это примерно 12 клипов»", () => {
    expect(monthLine(money(3_800_000), "offer")).toEqual({ room: "$6.20", tail: `это примерно 12${NBSP}клипов` });
  });

  test("the room rounds DOWN and counts the open reserves too", () => {
    // $10 − $3.80 − $0.504 = $5.696: «$5.69», and 5.696 / 0.85 = 6.7 → 6.
    expect(monthLine(money(3_800_000, 504_000), "auto")).toEqual({ room: "$5.69", tail: `это примерно 6${NBSP}клипов` });
  });

  test("the noun agrees with the count: 1 клип, 2 клипа, 5 клипов", () => {
    expect(monthLine(money(10_000_000 - 900_000), "auto")?.tail).toBe(`это примерно 1${NBSP}клип`);
    expect(monthLine(money(10_000_000 - 1_800_000), "auto")?.tail).toBe(`это примерно 2${NBSP}клипа`);
  });

  test("below $0.85 in auto: «хватит только на клип без запасной модели»; in offer the same room still holds one clip", () => {
    expect(monthLine(money(9_400_000), "auto")).toEqual({ room: "$0.60", tail: "хватит только на клип без запасной модели" });
    expect(monthLine(money(9_400_000), "offer")?.tail).toBe(`это примерно 1${NBSP}клип`);
  });

  test("below $0.504: «на клип не хватит», in either mode", () => {
    expect(monthLine(money(9_600_000), "auto")).toEqual({ room: "$0.40", tail: "на клип не хватит" });
    expect(monthLine(money(9_600_000), "offer")?.tail).toBe("на клип не хватит");
  });

  test("exactly one Kling clip's worth is one clip; one micro short is none", () => {
    expect(monthLine(money(10_000_000 - 504_000), "offer")?.tail).toBe(`это примерно 1${NBSP}клип`);
    expect(monthLine(money(10_000_000 - 503_999), "offer")?.tail).toBe("на клип не хватит");
  });

  test("a month spent past its budget has no room: nothing fits", () => {
    expect(monthLine(money(12_000_000), "auto")?.tail).toBe("на клип не хватит");
  });

  test("no line without a readable ledger", () => {
    expect(monthLine(null)).toBeNull();
    expect(monthLine({ ledger: "unavailable", month: "2026-10", monthlyBudgetMicros: 10_000_000, reconcileNeeded: false, reconcileReasons: [], halt: { cause: "LEDGER_CORRUPT", detail: "x" } } as MoneyStatus)).toBeNull();
  });
});

// ---------- which batch the header is about ----------

describe("latestBatchId", () => {
  test("a batch with a job in view wins over an older batch the records hold", () => {
    const records = newestFirst([ready(1, { batchId: OLD_BATCH })]);
    expect(latestBatchId(records, [queued(1)])).toBe(BATCH);
  });

  test("records only (after a restart, or past KEEP_FINISHED): the newest record's batch", () => {
    const records = newestFirst([ready(1, { batchId: OLD_BATCH }), ready(1)]);
    expect(latestBatchId(records, [])).toBe(BATCH);
  });

  test("single clips only: no batch", () => {
    const single = { ...ready(1), batchId: undefined, batchIndex: undefined, batchSize: undefined } as ClipSummary;
    expect(latestBatchId([single], [])).toBeNull();
  });
});

// ---------- the header (60–60f) ----------

describe("the batch header counts members by distinct batchIndex", () => {
  test("60: «Пакет · 4 из 10 готовы · снимается 1 · в очереди 5», with «Отменить оставшиеся» and no ✕", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), queued(6), queued(7), queued(8), queued(9), queued(10)] });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 5");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("run");
    expect(v.cancel).toBe(true);
    expect(v.close).toBe(false);
    expect(v.members.map((m) => m.state)).toEqual(["done", "done", "done", "done", "run", "wait", "wait", "wait", "wait", "wait"]);
  });

  test("a part that is zero is left out (L5): 60 #four «Пакет · снимается 1 · в очереди 3»", () => {
    const v = view({ records: [], jobs: [job(1, { phase: "submitting", model: "kling" }, {}, { size: 4 }), job(2, {}, {}, { size: 4 }), job(3, {}, {}, { size: 4 }), job(4, {}, {}, { size: 4 })] });
    expect(v.title).toBe("Пакет · снимается 1 · в очереди 3");
  });

  test("«готов» at 1, «готовы» at 2", () => {
    const next = (index: number): JobView => job(index, { phase: "rendering", model: "kling" }, {}, { size: 4 });
    expect(view({ records: [ready(1, { size: 4 })], jobs: [next(2)] }).title).toBe("Пакет · 1 из 4 готов · снимается 1 · не снимались 2");
    expect(view({ records: newestFirst([ready(1, { size: 4 }), ready(2, { size: 4 })]), jobs: [next(3)] }).title).toBe("Пакет · 2 из 4 готовы · снимается 1 · не снимался 1");
  });

  test("a member waiting for other money or after a 429 is still «в очереди»; `preparing` is at work (a cancel does not take it)", () => {
    const v = view({ records: newestFirst(readyRange(1, 5)), jobs: [job(6, { phase: "preparing" }), queued(7, "alone"), queued(8, "rate-limit"), queued(9), queued(10)] });
    expect(v.title).toBe("Пакет · 5 из 10 готовы · снимается 1 · в очереди 4");
  });

  test("it survives KEEP_FINISHED: the ready members' jobs gone, the records still count them", () => {
    const withJobs = view({ records: newestFirst(readyRange(1, 4)), jobs: [job(1, { phase: "saving" }, { status: "done" }), rendering(5), queued(6)] });
    const withoutJobs = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), queued(6)] });
    expect(withoutJobs.title).toBe(withJobs.title);
  });

  test("a member whose job ended and whose record the list does not hold yet is still at work, not «не снимался»", () => {
    const done = job(5, { phase: "saving" }, { status: "done" });
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [done, queued(6)], pending: (j) => j.jobId === done.jobId });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 1 · не снимались 4");
  });

  test("a refused member during the run is in no part (L14)", () => {
    const v = view({ records: newestFirst([...readyRange(1, 3), failed(4, "refused-free")]), jobs: [rendering(5), queued(6)] });
    expect(v.title).toBe("Пакет · 3 из 10 готовы · снимается 1 · в очереди 1 · не снимались 4");
    expect(v.members[3]?.state).toBe("refused");
  });

  test("60 #photo-gone: «· не снимался 1» and the contract's own line for the member whose photo went", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [cancelledJob(5, "photo-gone"), rendering(6), queued(7), queued(8), queued(9), queued(10)] });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 4 · не снимался 1");
    expect(v.line).toBe("Это фото удалено из галереи — клип не снимался, бесплатно.");
    expect(v.tone).toBe("run");
    expect(v.members[4]).toMatchObject({ state: "off", photoId: "photo-5" });
  });
});

describe("a 429 in the batch: one tile per member, the header as the members stand", () => {
  // 60 #rate-limit: members 1–8 ready; member 9 met a 429 twice (two records, the second final); member 10 met its first 429 and waits out the pause at the tail.
  const first9 = failed(9, "rate-limited");
  const final9 = failed(9, "rate-limited");
  const first10 = failed(10, "rate-limited");
  const waiting10 = queued(10, "rate-limit");

  test("the header: «Пакет · 8 из 10 готовы · в очереди 1» — the final 429 is a refusal, in no part; the waiting retry is «в очереди»", () => {
    const v = view({ records: newestFirst([...readyRange(1, 8), first9, first10, final9]), jobs: [waiting10] });
    expect(v.title).toBe("Пакет · 8 из 10 готовы · в очереди 1");
    expect(v.members.map((m) => m.state).slice(8)).toEqual(["refused", "wait"]);
  });

  test("the first record of a member with a later record is not drawn; the first 429 of a member whose retry still runs says the batch will shoot it again", () => {
    const roles = batchRecordRoles(newestFirst([...readyRange(1, 8), first9, first10, final9]), [waiting10]);
    expect(roles.get(first9.clipId)).toBe("hidden");
    expect(roles.has(final9.clipId)).toBe(false);
    expect(roles.get(first10.clipId)).toBe("batch-retry");
  });

  test("a retry whose job ended done, its record not listed yet, still counts as the later one", () => {
    const done10 = job(10, { phase: "saving" }, { status: "done" });
    const roles = batchRecordRoles(newestFirst([first10]), [done10], (j) => j.jobId === done10.jobId);
    expect(roles.get(first10.clipId)).toBe("batch-retry");
  });

  test("a retry that made its clip hides the first 429", () => {
    const retried = ready(10);
    const roles = batchRecordRoles(newestFirst([first10, retried]), [job(10, { phase: "saving" }, { status: "done" })]);
    expect(roles.get(first10.clipId)).toBe("hidden");
    expect(view({ records: newestFirst([...readyRange(1, 9), first10, retried]), jobs: [] }).counts.done).toBe(10);
  });

  test("a retry the owner cancelled: the first 429 is the 5b.1 record again (no role) and the member counts in «не снимался»", () => {
    const cancelled10 = cancelledJob(10, "cancelled");
    const records = newestFirst([...readyRange(1, 8), first9, first10, final9]);
    expect(batchRecordRoles(records, [cancelled10]).has(first10.clipId)).toBe(false);
    const v = view({ records, jobs: [cancelled10], cancelled: { batchId: BATCH, count: 1 } });
    expect(v.title).toBe("Пакет · 8 из 10 готовы · не снимался 1");
    expect(v.members[9]?.state).toBe("off");
  });

  test("a first 429 with no retry job at all (the batch stopped first) is not shot either", () => {
    const v = view({ records: newestFirst([...readyRange(1, 9), first10]), jobs: [] });
    expect(v.members[9]?.state).toBe("off");
    expect(batchRecordRoles(newestFirst([first10]), []).size).toBe(0);
  });

  test("records of single clips and of other batches are left alone", () => {
    const single = { ...failed(1, "rate-limited"), batchId: undefined, batchIndex: undefined, batchSize: undefined } as ClipSummary;
    expect(batchRecordRoles([single, failed(1, "rate-limited", { batchId: OLD_BATCH })], [queued(1)]).size).toBe(0);
  });
});

describe("the stop headers (60c–60f) say the contract's words", () => {
  test("60c: «Отменено: N…» counts what `clips.cancelBatch` answered, not the tiles (L11); info; ✕ once nothing is at work", () => {
    const jobs = [cancelledJob(8, "cancelled"), cancelledJob(9, "cancelled"), cancelledJob(10, "cancelled")];
    const v = view({ records: newestFirst(readyRange(1, 7)), jobs, cancelled: { batchId: BATCH, count: 3 } });
    expect(v.title).toBe("Пакет · 7 из 10 готовы · не снимались 3");
    expect(v.line).toBe("Отменено: 3 клипа не снимались — бесплатно");
    expect(v.tone).toBe("info");
    expect(v.cancel).toBe(false);
    expect(v.close).toBe(true);
  });

  test("the cancel's own count wins over the jobs this window happened to see end", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), cancelledJob(6, "cancelled")], cancelled: { batchId: BATCH, count: 5 } });
    expect(v.line).toBe("Отменено: 5 клипов не снимались — бесплатно");
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · не снимались 5");
    expect(v.close).toBe(false);
  });

  test("a cancel in another window: the cancelled jobs' own count", () => {
    const v = view({ records: newestFirst(readyRange(1, 9)), jobs: [cancelledJob(10, "cancelled")] });
    expect(v.line).toBe("Отменено: 1 клип не снимался — бесплатно");
  });

  test("60d ledger-stopped: warn, «Пакет остановлен: нужна сверка расходов. Оставшиеся 4 клипа…»", () => {
    const v = view({ records: newestFirst(readyRange(1, 6)), jobs: [7, 8, 9, 10].map((i) => cancelledJob(i, "ledger-stopped")) });
    expect(v.title).toBe("Пакет · 6 из 10 готовы · не снимались 4");
    expect(v.line).toBe("Пакет остановлен: нужна сверка расходов. Оставшиеся 4 клипа не снимались — бесплатно.");
    expect(v.tone).toBe("warn");
    expect(v.again).toBeNull();
  });

  test("60e price-changed: warn, and «Отметить их снова» picks the photos not shot, in batch order", () => {
    const v = view({ records: newestFirst(readyRange(1, 7)), jobs: [8, 9, 10].map((i) => cancelledJob(i, "price-changed")) });
    expect(v.line).toBe("Цена у OpenRouter выросла — оставшиеся 3 клипа не снимались, бесплатно. Запустите их заново.");
    expect(v.tone).toBe("warn");
    expect(v.again).toEqual(["photo-8", "photo-9", "photo-10"]);
  });

  test("60e #unavailable: price-unavailable, the same button", () => {
    const v = view({ records: newestFirst(readyRange(1, 7)), jobs: [8, 9, 10].map((i) => cancelledJob(i, "price-unavailable")) });
    expect(v.line).toBe("Цены видео у OpenRouter сейчас не читаются — оставшиеся 3 клипа не снимались, бесплатно.");
    expect(v.again).toEqual(["photo-8", "photo-9", "photo-10"]);
  });

  test("60f money-uncertain: the late member is in no part, the five not shot are; ✕ is offered", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [job(5, { phase: "late", model: "kling" }), ...[6, 7, 8, 9, 10].map((i) => cancelledJob(i, "money-uncertain"))] });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · не снимались 5");
    expect(v.line).toBe("Клип задержался или не ясно, оплачен ли он — оставшиеся 5 не снимались, чтобы не тратить вслепую. Бесплатно.");
    expect(v.tone).toBe("warn");
    expect(v.close).toBe(true);
    expect(v.members[4]?.state).toBe("late");
  });
});

describe("after a restart: no batch job left", () => {
  test("60c #restart: the members with neither a record nor a job were dropped for free — «Оставшиеся 4 клипа не снимались — бесплатно.»", () => {
    const recovered = { ...ready(6), recovered: true, cost: { kind: "open", micros: 504_000 } } as ClipSummary;
    const v = view({ records: newestFirst([...readyRange(1, 5), recovered]), jobs: [] });
    expect(v.title).toBe("Пакет · 6 из 10 готовы · не снимались 4");
    expect(v.line).toBe("Оставшиеся 4 клипа не снимались — бесплатно.");
    expect(v.tone).toBe("info");
    expect(v.close).toBe(true);
  });

  test("60c #restart-idle: «Пакет · 5 из 10 готовы · не снимались 5» and «Оставшиеся 5 клипов не снимались — бесплатно.»", () => {
    const v = view({ records: newestFirst(readyRange(1, 5)), jobs: [] });
    expect(v.title).toBe("Пакет · 5 из 10 готовы · не снимались 5");
    expect(v.line).toBe("Оставшиеся 5 клипов не снимались — бесплатно.");
  });
});

describe("what the window cannot read as «не снимался» (review of S5.WB4)", () => {
  test("a member whose clip was made and then deleted by the owner is in no part — never «не снимался — бесплатно»", () => {
    const madeThenDeleted = job(2, { phase: "saving" }, { status: "done" }, { size: 2 });
    const v = view({ records: [ready(1, { size: 2 })], jobs: [madeThenDeleted] });
    expect(v.title).toBe("Пакет готов: 1 клип · $0.42");
    expect(v.line).toBeNull();
    expect(v.counts.notShot).toBe(0);
  });

  test("a final 429 whose first 429 the owner deleted is the member's refusal, not «не снимался»", () => {
    const first = job(2, { phase: "submitting", model: "kling" }, { status: "done" }, { size: 2 });
    const finalRecord = failed(2, "rate-limited", { size: 2 });
    const retry = job(2, { phase: "saving", clipId: finalRecord.clipId }, { status: "done" }, { size: 2 });
    const v = view({ records: newestFirst([ready(1, { size: 2 }), finalRecord]), jobs: [first, retry] });
    expect(v.members[1]?.state).toBe("refused");
    expect(v.title).toBe("Пакет готов: 1 клип · 1 отказ бесплатно · $0.42");
  });

  test("members the engine dropped without a reason (a fault of its scheduler) are not «Отменено»: the owner cancelled nothing", () => {
    const silent = job(2, { phase: "queued" }, { status: "cancelled" }, { size: 2 });
    const v = view({ records: [ready(1, { size: 2 })], jobs: [silent] });
    expect(v.line).toBe("Оставшийся 1 клип не снимался — бесплатно.");
  });

  test("one queued member cancelled on its own (`avatars.cancel`) does not stop the batch: the others still wait, «Отменить оставшиеся» stays", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), cancelledJob(6, "cancelled"), queued(7), queued(8), queued(9), queued(10)] });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 4 · не снимался 1");
    expect(v.cancel).toBe(true);
    expect(v.tone).toBe("run");
  });

  test("after a restart, a first 429 whose retry the restart dropped is dropped with the rest: the line and the title agree", () => {
    const v = view({ records: newestFirst([...readyRange(1, 7), failed(8, "rate-limited")]), jobs: [] });
    expect(v.title).toBe("Пакет · 7 из 10 готовы · не снимались 3");
    expect(v.line).toBe("Оставшиеся 3 клипа не снимались — бесплатно.");
  });
});

describe("the end (60b): «бесплатно» only for a refusal proven free", () => {
  test("a refusal whose cost is `free`: «Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78», ok", () => {
    const v = view({ records: newestFirst([...readyRange(1, 8), failed(9, "refused-free", { cost: FREE }), ready(10)]), jobs: [] });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("ok");
    expect(v.close).toBe(true);
    expect(v.cancel).toBe(false);
  });

  test("#worst: a refusal counted at its worst is not «бесплатно»; the sum holds the ceiling and rounds up; the line says why", () => {
    const v = view({ records: newestFirst([...readyRange(1, 8), failed(9, "refused-unknown", { cost: WORST }), ready(10)]), jobs: [] });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ · $4.29");
    expect(v.line).toBe("Отказ учтён по максимуму $0.51: не удалось доказать, что он бесплатный.");
    expect(v.tone).toBe("info");
  });

  test("a paid refusal is not «бесплатно» either", () => {
    const v = view({ records: newestFirst([...readyRange(1, 9), failed(10, "refused-paid", { cost: BILLED })]), jobs: [] });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ · $4.20");
  });

  test("#photo-gone: «Пакет готов: 8 клипов · 1 отказ бесплатно · не снимался 1 · $3.36» and the photo's line", () => {
    const v = view({ records: newestFirst([...readyRange(1, 4), ...readyRange(6, 8), failed(9, "refused-free"), ready(10)]), jobs: [cancelledJob(5, "photo-gone")] });
    expect(v.title).toBe("Пакет готов: 8 клипов · 1 отказ бесплатно · не снимался 1 · $3.36");
    expect(v.line).toBe("Это фото удалено из галереи — клип не снимался, бесплатно.");
    expect(v.tone).toBe("ok");
  });

  test("no refusal: no refusal part", () => {
    expect(view({ records: newestFirst(readyRange(1, 10)), jobs: [] }).title).toBe("Пакет готов: 10 клипов · $4.20");
  });
});

// ---------- the sheet (59–59c) ----------

const EST = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live" as const, pricesAsOf: "2026-10-15T11:00:00.000Z" });

function suitable(photoId: string, o: { bold?: boolean; fallback?: "auto" | "offer" | "none" } = {}): ClipOptions {
  const k = EST(420_000, 504_000);
  return {
    suitable: true,
    photoId,
    motions: [{ id: "scene", source: "scene", label: "Как в сцене", text: "she blinks" }],
    prices: { std5: k, pro5: k, std10: k, pro10: k, grok5: k, grok10: k },
    fallback: o.fallback ?? (o.bold === true ? "none" : "auto"),
    bold: o.bold ?? false,
    noFallbackPrices: { std5: k, pro5: k, std10: k, pro10: k },
    monthFits: { std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" },
  };
}

function batchOptions(o: { worst?: number; noFallback?: number; expected?: number; room?: number; fit?: "with-fallback" | "without-fallback" | "none"; items?: ClipOptions[] } = {}): ClipBatchOptions {
  const sum = { expected: o.expected ?? 1_680_000, worst: o.worst ?? 3_060_000, worstNoFallback: o.noFallback ?? 2_016_000 };
  const fit = o.fit ?? "with-fallback";
  return {
    items: o.items ?? [suitable("p7"), suitable("p3", { bold: true }), suitable("p5"), suitable("p10"), { suitable: false, photoId: "p12", reason: "no-motion" }],
    sums: { std5: sum, pro5: sum, std10: sum, pro10: sum },
    monthRoomMicros: o.room ?? 6_200_000,
    monthFits: { std5: fit, pro5: fit, std10: fit, pro10: fit },
  };
}

describe("the batch sheet's figures are the engine's (59)", () => {
  test("59: «Обычно $1.68 · не больше $3.06», «Осталось в месяце $6.20», «Оживить 4 · до $3.06» — four clips of five photos", () => {
    const s = batchSheetView(batchOptions(), { quality: "std", seconds: 5 });
    expect(s).toMatchObject({ key: "std5", expected: "$1.68", worst: "$3.06", room: "$6.20", count: 4, auto: true, fits: true, main: { worstMicros: 3_060_000, label: "до $3.06" }, noFallback: null, budgetNeed: null });
  });

  test("the room rounds down", () => {
    expect(batchSheetView(batchOptions({ room: 2_609_999 }), { quality: "std", seconds: 5 }).room).toBe("$2.60");
  });

  test("59b at open: the month holds Kling alone — «Оживить» waits, «Оживить без запасной модели · до $5.04» is offered, the notice needs $8.50", () => {
    const s = batchSheetView(batchOptions({ worst: 8_500_000, noFallback: 5_040_000, fit: "without-fallback" }), { quality: "std", seconds: 5 });
    expect(s.fits).toBe(false);
    expect(s.budgetNeed).toBe("$8.50");
    expect(s.noFallback).toEqual({ worstMicros: 5_040_000, label: "до $5.04" });
  });

  test("nothing fits: no second button", () => {
    const s = batchSheetView(batchOptions({ worst: 15_500_000, noFallback: 9_240_000, fit: "none" }), { quality: "std", seconds: 10 });
    expect(s).toMatchObject({ key: "std10", fits: false, noFallback: null, budgetNeed: "$15.50" });
  });

  test("mode offer (59 #offer): no member falls back, so `without-fallback` fits the main button and there is no Grok line", () => {
    const items = [suitable("p7", { fallback: "offer" }), suitable("p3", { bold: true })];
    const s = batchSheetView(batchOptions({ items, worst: 2_016_000, fit: "without-fallback" }), { quality: "std", seconds: 5 });
    expect(s).toMatchObject({ auto: false, fits: true, noFallback: null, count: 2 });
  });

  test("«Чётче» in mode auto says Grok shoots 720p", () => {
    expect(batchSheetView(batchOptions(), { quality: "pro", seconds: 5 })).toMatchObject({ key: "pro5", proNote: true });
    expect(batchSheetView(batchOptions(), { quality: "std", seconds: 5 }).proNote).toBe(false);
  });
});

describe("a refusal of one item after the click (59 #item-refused)", () => {
  test("VALIDATION at [\"items\", i] names the i-th photo sent and its own reason", () => {
    const sent = ["p7", "p3", "p5", "p10"];
    expect(itemRefusal({ code: "VALIDATION", clipReason: "photo-unreadable", path: ["items", 2] }, sent)).toEqual({ photoId: "p5", reason: "photo-unreadable" });
  });

  test("anything else is not a row's: no path, another code, an index out of range", () => {
    const sent = ["p7"];
    expect(itemRefusal({ code: "VALIDATION", clipReason: "photo-unreadable" }, sent)).toBeNull();
    expect(itemRefusal({ code: "PRICE_CHANGED", path: ["items", 0] }, sent)).toBeNull();
    expect(itemRefusal({ code: "VALIDATION", clipReason: "bold-off", path: ["items", 3] }, sent)).toBeNull();
  });

  test("one alert: «Фото 5 · Виды не оживить: файл не читается. Сумма пересчитана — подтвердите ещё раз.»", () => {
    expect(itemRefusedAlert("Фото 5 · Виды", "photo-unreadable")).toBe(`Фото 5 · Виды не оживить: файл не читается. Сумма пересчитана${NBSP}— подтвердите ещё раз.`);
  });
});

describe("the sheet's row notes (59)", () => {
  const options = (photoId: string, o: Parameters<typeof suitable>[1] = {}) => suitable(photoId, o);

  test("«Смелая»: «без запасной модели», in the accent", () => {
    expect(batchRowNote(scenePhoto(3), options("p3", { bold: true }), undefined)).toEqual({ text: "без запасной модели", struck: false, bold: true });
  });

  test("a photo in a video and a rejected one say their clip never goes into a montage", () => {
    expect(batchRowNote(scenePhoto(5, { used: true, usedIn: ["video-0000001"] }), options("p5"), undefined)).toEqual({ text: `фото уже в видео${NBSP}— клип в монтаж не ставится`, struck: false, bold: false });
    expect(batchRowNote(scenePhoto(10, { rejected: true }), options("p10"), undefined)).toEqual({ text: "пока фото отклонено, клип в монтаж не ставится", struck: false, bold: false });
  });

  test("a photo the engine cannot bring to life is struck, and says the reason itself (L1)", () => {
    expect(batchRowNote(scenePhoto(12), { suitable: false, photoId: "p12", reason: "no-motion" }, undefined)).toEqual({ text: CLIP_REASONS_RU["no-motion"], struck: true, bold: false });
  });

  test("a row refused after the click is struck with its OWN reason, whatever it was before", () => {
    expect(batchRowNote(scenePhoto(5, { used: true }), options("p5"), "photo-unreadable")).toEqual({ text: CLIP_REASONS_RU["photo-unreadable"], struck: true, bold: false });
  });

  test("a plain photo has no note", () => {
    expect(batchRowNote(scenePhoto(7), options("p7"), undefined)).toBeNull();
  });
});
