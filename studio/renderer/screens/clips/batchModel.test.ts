import { describe, expect, test } from "bun:test";
import {
  CLIP_REASONS_RU,
  clipBatchCostOf,
  type ClipBatchOptions,
  type ClipBatchOutcome,
  type ClipBatchStop,
  type ClipBatchSummary,
  type ClipCancelDetail,
  type ClipCost,
  type ClipCostKind,
  type ClipFailReason,
  type ClipOptions,
  type ClipSummary,
  type MoneyStatus,
} from "../../../shared/engine";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import type { ClipJobInfo, JobView } from "../../engine/store";
import { batchRecordRoles, batchRowNote, batchSheetView, batchView, itemRefusal, itemRefusedAlert, latestBatchId, monthLine, type BatchInput } from "./batchModel";

// 5b.2, S5.WB4 (plan s5b2 §5.2, §6 rows 58a–60f; README §S5.WBD «Одни данные на все страницы», decisions 7–9, «Для WB2 / WB4»): what the window says about a batch. The pick bar's month line
// (from MoneyStatus, rounded DOWN, divided by the worst clip of the mode); the «Клипы» header — round 2 (S5.WB4b): its members and EVERY money word from the engine's own summary of the batch
// (`ClipBatchSummary`, S5.WB2c: a deleted clip stays what it was; money only from `cost`/`costKind`), the live phases from the jobs, and with no summary only what the records and jobs prove — no money sentence,
// no «бесплатно»; the first-429 rule; the cancel count from `clips.cancelBatch`; the sheet's sums and the per-row refusal after the click.

const NBSP = " ";
const AVATAR = "avatar-nini-0001";
const BATCH = "batch-0000001";
const OLD_BATCH = "batch-0000000";

// ---------- builders ----------

const BILLED: ClipCost = { kind: "billed", micros: 420_000 };
const FREE: ClipCost = { kind: "free", micros: 0 };

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

const queued = (index: number, waitReason: ClipJobInfo["waitReason"] = "turn", size = 10): JobView => job(index, { phase: "queued", waitReason }, {}, { size });
const rendering = (index: number, size = 10): JobView => job(index, { phase: "rendering", model: "kling" }, {}, { size });
const cancelledJob = (index: number, detail: ClipCancelDetail | undefined): JobView => job(index, { phase: "queued", ...(detail === undefined ? {} : { detail }) }, { status: "cancelled" });
/** The records as `clips.list` gives them: newest first. */
const newestFirst = (records: ClipSummary[]): ClipSummary[] => [...records].reverse();
const readyRange = (from: number, to: number): ClipSummary[] => Array.from({ length: to - from + 1 }, (_, i) => ready(from + i));

/** One member of the engine's summary: its outcome, and its money as the ledger has it (the defaults: a made clip billed $0.42, a clip at work open at $0.504, anything else free). */
interface M {
  readonly outcome: ClipBatchOutcome;
  readonly detail?: ClipCancelDetail;
  readonly costMicros?: number;
  readonly costKind?: ClipCostKind;
  readonly clipIds?: readonly string[];
}
const DEFAULT_COST: Record<ClipBatchOutcome, { costMicros: number; costKind: ClipCostKind }> = {
  ready: { costMicros: 420_000, costKind: "billed" },
  running: { costMicros: 504_000, costKind: "open" },
  queued: { costMicros: 0, costKind: "free" },
  refused: { costMicros: 0, costKind: "free" },
  failed: { costMicros: 0, costKind: "free" },
  cancelled: { costMicros: 0, costKind: "free" },
  dropped: { costMicros: 0, costKind: "free" },
};
function summary(members: readonly M[], o: { stop?: ClipBatchStop; ended?: boolean; batchId?: string } = {}): ClipBatchSummary {
  const list = members.map((m, i) => ({
    batchIndex: i + 1,
    outcome: m.outcome,
    ...(m.detail === undefined ? {} : { detail: m.detail }),
    costMicros: m.costMicros ?? DEFAULT_COST[m.outcome].costMicros,
    costKind: m.costKind ?? DEFAULT_COST[m.outcome].costKind,
    clipIds: [...(m.clipIds ?? [`clip-s${i + 1}`])],
  }));
  return {
    batchId: o.batchId ?? BATCH,
    avatarId: AVATAR,
    size: list.length,
    createdAt: "2026-10-15T11:21:00.000Z",
    members: list,
    ...(o.ended === true ? { endedAt: "2026-10-15T11:37:00.000Z" } : {}),
    ...(o.stop === undefined ? {} : { stop: o.stop }),
    cost: clipBatchCostOf(list),
  };
}
const times = (n: number, m: M): M[] => Array.from({ length: n }, () => m);
const R: M = { outcome: "ready" };
const RUN: M = { outcome: "running" };
const Q: M = { outcome: "queued" };
const cancelled = (detail: ClipCancelDetail): M => ({ outcome: "cancelled", detail });

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
  test("a batch with a job in view wins over older batches the summaries and records hold", () => {
    const records = newestFirst([ready(1, { batchId: OLD_BATCH })]);
    expect(latestBatchId(records, [queued(1)], [summary([R], { batchId: OLD_BATCH, ended: true })])).toBe(BATCH);
  });

  test("no batch job in view (a restart, past KEEP_FINISHED): the engine's newest summary", () => {
    expect(latestBatchId(newestFirst([ready(1, { batchId: OLD_BATCH })]), [], [summary([R], { ended: true }), summary([R], { batchId: OLD_BATCH, ended: true })])).toBe(BATCH);
  });

  test("no summary either (an engine before them): the newest record's batch", () => {
    const records = newestFirst([ready(1, { batchId: OLD_BATCH }), ready(1)]);
    expect(latestBatchId(records, [], [])).toBe(BATCH);
  });

  test("single clips only: no batch", () => {
    const single = { ...ready(1), batchId: undefined, batchIndex: undefined, batchSize: undefined } as ClipSummary;
    expect(latestBatchId([single], [], [])).toBeNull();
  });
});

// ---------- the header with the engine's summary (60–60f) ----------

describe("the header counts the members of the engine's summary; the jobs say who is at work now", () => {
  test("60: «Пакет · 4 из 10 готовы · снимается 1 · в очереди 5», with «Отменить оставшиеся» and no ✕", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), queued(6), queued(7), queued(8), queued(9), queued(10)], summary: summary([...times(4, R), RUN, ...times(5, Q)]) });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 5");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("run");
    expect(v.cancel).toBe(true);
    expect(v.close).toBe(false);
    expect(v.members.map((m) => m.state)).toEqual(["done", "done", "done", "done", "run", "wait", "wait", "wait", "wait", "wait"]);
  });

  test("a part that is zero is left out: 60 #four «Пакет · снимается 1 · в очереди 3»", () => {
    const v = view({ records: [], jobs: [job(1, { phase: "submitting", model: "kling" }, {}, { size: 4 }), queued(2, "turn", 4), queued(3, "turn", 4), queued(4, "turn", 4)], summary: summary([RUN, Q, Q, Q]) });
    expect(v.title).toBe("Пакет · снимается 1 · в очереди 3");
  });

  test("«готов» at 1, «готовы» at 2", () => {
    expect(view({ records: [ready(1, { size: 4 })], jobs: [rendering(2, 4)], summary: summary([R, RUN, Q, Q]) }).title).toStartWith("Пакет · 1 из 4 готов · ");
    expect(view({ records: [], jobs: [rendering(3, 4)], summary: summary([R, R, RUN, Q]) }).title).toStartWith("Пакет · 2 из 4 готовы · ");
  });

  test("«снимается» is at most one (L5): the member saving its file while the next one prepares is one clip at work", () => {
    const saving = job(4, { phase: "saving" });
    const v = view({ records: newestFirst(readyRange(1, 3)), jobs: [saving, job(5, { phase: "preparing" }), queued(6)], summary: summary([...times(3, R), RUN, RUN, Q, ...times(4, Q)]) });
    expect(v.counts.running).toBe(1);
    expect(v.title).toBe("Пакет · 3 из 10 готовы · снимается 1 · в очереди 5");
  });

  test("it survives KEEP_FINISHED and a restart: no job of the made members, the summary still counts them", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [rendering(5), queued(6)], summary: summary([...times(4, R), RUN, Q, ...times(4, Q)]) });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 5");
  });

  test("M1: a made clip the owner deleted stays «готов» — its tile is gone, its money stays in the total", () => {
    const v = view({ records: [ready(1, { size: 2 })], jobs: [], summary: summary([R, R], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 2 клипа · $0.84");
    expect(v.counts.notShot).toBe(0);
  });

  test("a summary a list read before the member's job ended still says at work: the job that ended says more", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [cancelledJob(5, "cancelled"), cancelledJob(6, "cancelled")], summary: summary([...times(4, R), Q, Q], {}), cancelled: { batchId: BATCH, count: 2 } });
    expect(v.counts.queued).toBe(0);
    expect(v.counts.notShot).toBe(2);
  });

  test("a member whose job ended and whose record the list does not hold yet is still at work", () => {
    const done = job(5, { phase: "saving" }, { status: "done" });
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [done, queued(6)], summary: summary([...times(4, R), RUN, ...times(5, Q)]), pending: (j) => j.jobId === done.jobId });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 5");
  });

  test("a refused or failed member during the run is in no part (L14)", () => {
    const v = view({ records: [], jobs: [rendering(5), queued(6)], summary: summary([...times(3, R), { outcome: "refused" }, RUN, Q, ...times(4, Q)]) });
    expect(v.title).toBe("Пакет · 3 из 10 готовы · снимается 1 · в очереди 5");
    expect(v.members[3]?.state).toBe("refused");
  });

  test("60 #photo-gone: «· не снимался 1» and the contract's own line for the member, its money free", () => {
    const v = view({ records: [], jobs: [rendering(6), queued(7)], summary: summary([...times(4, R), cancelled("photo-gone"), RUN, ...times(4, Q)]) });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 4 · не снимался 1");
    expect(v.line).toBe("Это фото удалено из галереи — клип не снимался, бесплатно.");
    expect(v.tone).toBe("run");
  });

  test("60 #rate-limit: the final 429 is a member that failed, in no part; its neighbour's retry waits «в очереди»", () => {
    const v = view({ records: [], jobs: [queued(10, "rate-limit")], summary: summary([...times(8, R), { outcome: "failed" }, Q]) });
    expect(v.title).toBe("Пакет · 8 из 10 готовы · в очереди 1");
    expect(v.members.map((m) => m.state).slice(8)).toEqual(["failed", "wait"]);
  });

  test("L1: a member whose retry made its clip and whose first 429 the owner deleted is «готов» — the summary, not the records, says so", () => {
    const v = view({ records: [], jobs: [], summary: summary([R, { outcome: "ready", clipIds: ["clip-first-429", "clip-retry"] }], { ended: true }) });
    expect(v.members[1]?.state).toBe("done");
  });

  test("one queued member cancelled on its own (`avatars.cancel`) does not stop the batch: the others wait, «Отменить оставшиеся» stays", () => {
    const v = view({ records: [], jobs: [rendering(5), cancelledJob(6, "cancelled"), queued(7), queued(8), queued(9), queued(10)], summary: summary([...times(4, R), RUN, cancelled("cancelled"), ...times(4, Q)]) });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 4 · не снимался 1");
    expect(v.cancel).toBe(true);
    expect(v.tone).toBe("run");
  });
});

describe("the stop headers (60c–60f) say the contract's words, when the summary says the money", () => {
  test("60c: «Отменено: N…» counts what `clips.cancelBatch` answered (L11); info; ✕ once nothing is at work", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(7, R), ...times(3, cancelled("cancelled"))], { stop: "cancelled", ended: true }), cancelled: { batchId: BATCH, count: 3 } });
    expect(v.title).toBe("Пакет · 7 из 10 готовы · не снимались 3");
    expect(v.line).toBe("Отменено: 3 клипа не снимались — бесплатно");
    expect(v.tone).toBe("info");
    expect(v.cancel).toBe(false);
    expect(v.close).toBe(true);
  });

  test("a cancel in another window: the summary's own count", () => {
    expect(view({ records: [], jobs: [], summary: summary([...times(9, R), cancelled("cancelled")], { stop: "cancelled", ended: true }) }).line).toBe("Отменено: 1 клип не снимался — бесплатно");
  });

  test("60d ledger-stopped: warn, «Пакет остановлен: нужна сверка расходов. Оставшиеся 4 клипа…»", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(6, R), ...times(4, cancelled("ledger-stopped"))], { stop: "ledger-stopped", ended: true }) });
    expect(v.title).toBe("Пакет · 6 из 10 готовы · не снимались 4");
    expect(v.line).toBe("Пакет остановлен: нужна сверка расходов. Оставшиеся 4 клипа не снимались — бесплатно.");
    expect(v.tone).toBe("warn");
    expect(v.again).toBeNull();
  });

  test("60e price-changed: warn, and «Отметить их снова» picks the photos not shot, in batch order (from the jobs that knew them)", () => {
    const jobs = [8, 9, 10].map((i) => job(i, { phase: "queued", detail: "price-changed", clipId: `clip-s${i}` }, { status: "cancelled" }));
    const v = view({ records: [], jobs, summary: summary([...times(7, R), ...times(3, cancelled("price-changed"))], { stop: "price-changed", ended: true }) });
    expect(v.line).toBe("Цена у OpenRouter выросла — оставшиеся 3 клипа не снимались, бесплатно. Запустите их заново.");
    expect(v.tone).toBe("warn");
    expect(v.again).toEqual(["photo-8", "photo-9", "photo-10"]);
  });

  test("60e #unavailable: price-unavailable, the same button", () => {
    const jobs = [8, 9, 10].map((i) => job(i, { phase: "queued", detail: "price-unavailable", clipId: `clip-s${i}` }, { status: "cancelled" }));
    const v = view({ records: [], jobs, summary: summary([...times(7, R), ...times(3, cancelled("price-unavailable"))], { stop: "price-unavailable", ended: true }) });
    expect(v.line).toBe("Цены видео у OpenRouter сейчас не читаются — оставшиеся 3 клипа не снимались, бесплатно.");
    expect(v.again).toEqual(["photo-8", "photo-9", "photo-10"]);
  });

  test("60f money-uncertain: the late member is in no part, the five not shot are; ✕ is offered", () => {
    const v = view({ records: [], jobs: [job(5, { phase: "late", model: "kling" })], summary: summary([...times(4, R), RUN, ...times(5, cancelled("money-uncertain"))], { stop: "money-uncertain" }) });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · не снимались 5");
    expect(v.line).toBe("Клип задержался или не ясно, оплачен ли он — оставшиеся 5 не снимались, чтобы не тратить вслепую. Бесплатно.");
    expect(v.tone).toBe("warn");
    expect(v.close).toBe(true);
    expect(v.members[4]?.state).toBe("late");
  });

  test("a stop's members whose money is not free are never called free: no line", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(7, R), ...times(3, { outcome: "cancelled", detail: "ledger-stopped", costMicros: 504_000, costKind: "open" } as M)], { stop: "ledger-stopped", ended: true }) });
    expect(v.title).toBe("Пакет · 7 из 10 готовы · не снимались 3");
    expect(v.line).toBeNull();
  });
});

describe("after a restart (the summary's `dropped`)", () => {
  test("60c #restart: «Пакет · 6 из 10 готовы · не снимались 4» and «Оставшиеся 4 клипа не снимались — бесплатно.»; the recovered clip still open", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(5, R), { outcome: "ready", costMicros: 504_000, costKind: "open" }, ...times(4, { outcome: "dropped" } as M)], { ended: true }) });
    expect(v.title).toBe("Пакет · 6 из 10 готовы · не снимались 4");
    expect(v.line).toBe("Оставшиеся 4 клипа не снимались — бесплатно.");
    expect(v.tone).toBe("info");
    expect(v.close).toBe(true);
  });

  test("a dropped member whose reserve is still open is not called free: the line counts only the free ones", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(5, R), { outcome: "dropped", costMicros: 504_000, costKind: "open" }, ...times(4, { outcome: "dropped" } as M)], { ended: true }) });
    expect(v.title).toBe("Пакет · 5 из 10 готовы · не снимались 5");
    expect(v.line).toBe("Оставшиеся 4 клипа не снимались — бесплатно.");
  });
});

describe("the end (60b): every money word from the summary's `cost` and `costKind`", () => {
  test("a refusal whose cost is `free`: «Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78», ok", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(8, R), { outcome: "refused" }, R], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ бесплатно · $3.78");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("ok");
    expect(v.close).toBe(true);
    expect(v.cancel).toBe(false);
  });

  test("#worst: a refusal settled at its worst is not «бесплатно»; the total holds a ceiling and rounds up; the line says why", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(8, R), { outcome: "refused", costMicros: 504_000, costKind: "estimated" }, R], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ · $4.29");
    expect(v.line).toBe("Отказ учтён по максимуму $0.51: не удалось доказать, что он бесплатный.");
    expect(v.tone).toBe("info");
  });

  test("two refusals at their worst: one line, and no figure the window would have to add up", () => {
    const worst: M = { outcome: "refused", costMicros: 504_000, costKind: "estimated" };
    expect(view({ records: [], jobs: [], summary: summary([...times(8, R), worst, worst], { ended: true }) }).line).toBe("Отказы учтены по максимуму: не удалось доказать, что они бесплатные.");
  });

  test("a paid refusal is not «бесплатно» either", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(9, R), { outcome: "refused", costMicros: 420_000, costKind: "billed" }], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ · $4.20");
  });

  test("L2: money still open reads «до $X»", () => {
    const v = view({ records: [], jobs: [], summary: summary([R, { outcome: "ready", costMicros: 504_000, costKind: "open" }], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 2 клипа · до $0.93");
    expect(v.tone).toBe("info");
  });

  test("a member that failed for another reason is said as such, not as a refusal", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(9, R), { outcome: "failed", costMicros: 420_000, costKind: "billed" }], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 не получился · $4.20");
  });

  test("#photo-gone: «Пакет готов: 8 клипов · 1 отказ бесплатно · не снимался 1 · $3.36» and the photo's line", () => {
    const v = view({ records: [], jobs: [], summary: summary([...times(4, R), cancelled("photo-gone"), R, R, R, { outcome: "refused" }, R], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 8 клипов · 1 отказ бесплатно · не снимался 1 · $3.36");
    expect(v.line).toBe("Это фото удалено из галереи — клип не снимался, бесплатно.");
    expect(v.tone).toBe("ok");
  });

  test("no refusal: no refusal part; nothing paid at all: «бесплатно» once", () => {
    expect(view({ records: [], jobs: [], summary: summary(times(10, R), { ended: true }) }).title).toBe("Пакет готов: 10 клипов · $4.20");
  });

  test("S5.WB4c: no clip made — «Пакет закончен: 2 отказа бесплатно», never «готов» with no clip", () => {
    expect(view({ records: [], jobs: [], summary: summary([{ outcome: "refused" }, { outcome: "refused" }], { ended: true }) }).title).toBe("Пакет закончен: 2 отказа бесплатно");
  });

  test("S5.WB4c: a made clip the ledger settled at its worst says why it counts too — not only a refusal", () => {
    const v = view({ records: [], jobs: [], summary: summary([R, { outcome: "ready", costMicros: 504_000, costKind: "estimated" }], { ended: true }) });
    expect(v.title).toBe("Пакет готов: 2 клипа · $0.93");
    expect(v.line).toBe("Клип учтён по максимуму $0.51: точная стоимость не прочитана.");
  });

  test("S5.WB4c: several at their worst, not all of them refusals: one line, no figure to add up", () => {
    const worstReady: M = { outcome: "ready", costMicros: 504_000, costKind: "estimated" };
    const worstRefused: M = { outcome: "refused", costMicros: 504_000, costKind: "estimated" };
    expect(view({ records: [], jobs: [], summary: summary([R, worstReady, worstRefused], { ended: true }) }).line).toBe("По максимуму учтено 2 клипа: точная стоимость не прочитана.");
  });
});

// ---------- the header with NO summary (a batch from before them, or older than the twenty listed): what the records and jobs prove, and no money ----------

describe("no summary: counts from the records, neutral words, never a money word", () => {
  test("an ended batch: «Пакет готов: 9 клипов · 1 отказ» — no total, no «бесплатно»", () => {
    const v = view({ records: newestFirst([...readyRange(1, 8), failed(9, "refused-free"), ready(10)]), jobs: [] });
    expect(v.title).toBe("Пакет готов: 9 клипов · 1 отказ");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("info");
  });

  test("members of which nothing is left (a restart, a delete — the window cannot tell): in no part, and the batch is not called ready", () => {
    const v = view({ records: newestFirst(readyRange(1, 5)), jobs: [] });
    expect(v.title).toBe("Пакет · 5 из 10 готовы");
    expect(v.line).toBeNull();
    expect(v.close).toBe(true);
  });

  test("a made clip deleted in this window (its job ended, the list read after holds nothing of it) is in no part", () => {
    const v = view({ records: [ready(1, { size: 2 })], jobs: [job(2, { phase: "saving" }, { status: "done" }, { size: 2 })] });
    expect(v.counts.notShot).toBe(0);
    expect(v.title).not.toContain("не снимал");
  });

  test("S5.WB4c: nothing to count at all — «Пакет закончен», with no empty tail", () => {
    expect(view({ records: [], jobs: [job(1, { phase: "saving" }, { status: "done" }, { size: 1 })] }).title).toBe("Пакет закончен");
  });

  test("a stop the jobs told: the parts and the tone, but no line — it would say «бесплатно»", () => {
    const v = view({ records: newestFirst(readyRange(1, 6)), jobs: [7, 8, 9, 10].map((i) => cancelledJob(i, "ledger-stopped")) });
    expect(v.title).toBe("Пакет · 6 из 10 готовы · не снимались 4");
    expect(v.line).toBeNull();
    expect(v.tone).toBe("warn");
  });

  test("while it runs: the live parts from the jobs, the photo-gone line left out", () => {
    const v = view({ records: newestFirst(readyRange(1, 4)), jobs: [cancelledJob(5, "photo-gone"), rendering(6), queued(7), queued(8), queued(9), queued(10)] });
    expect(v.title).toBe("Пакет · 4 из 10 готовы · снимается 1 · в очереди 4 · не снимался 1");
    expect(v.line).toBeNull();
  });
});

// ---------- the records of a batch on the «Клипы» tab (README decision 9) ----------

describe("a 429 in the batch: one tile per member", () => {
  // 60 #rate-limit: member 9 met a 429 twice (two records, the second final); member 10 met its first 429 and waits at the tail.
  const first9 = failed(9, "rate-limited");
  const final9 = failed(9, "rate-limited");
  const first10 = failed(10, "rate-limited");
  const waiting10 = queued(10, "turn");

  test("the first record of a member with a later record is not drawn; the first 429 of a member whose retry still runs says the batch will shoot it again", () => {
    const roles = batchRecordRoles(newestFirst([...readyRange(1, 8), first9, first10, final9]), [waiting10]);
    expect(roles.get(first9.clipId)).toBe("hidden");
    expect(roles.has(final9.clipId)).toBe(false);
    expect(roles.get(first10.clipId)).toBe("batch-retry");
  });

  test("a retry whose job ended done, its record not listed yet, still counts as the later one", () => {
    const done10 = job(10, { phase: "saving" }, { status: "done" });
    expect(batchRecordRoles(newestFirst([first10]), [done10], (j) => j.jobId === done10.jobId).get(first10.clipId)).toBe("batch-retry");
  });

  test("a retry that made its clip hides the first 429", () => {
    const retried = ready(10);
    expect(batchRecordRoles(newestFirst([first10, retried]), [job(10, { phase: "saving" }, { status: "done" })]).get(first10.clipId)).toBe("hidden");
  });

  test("a retry the owner cancelled: the first 429 is the 5b.1 record again (no role)", () => {
    expect(batchRecordRoles(newestFirst([first10]), [cancelledJob(10, "cancelled")]).has(first10.clipId)).toBe(false);
  });

  test("records of single clips and of other batches are left alone", () => {
    const single = { ...failed(1, "rate-limited"), batchId: undefined, batchIndex: undefined, batchSize: undefined } as ClipSummary;
    expect(batchRecordRoles([single, failed(1, "rate-limited", { batchId: OLD_BATCH })], [queued(1)]).size).toBe(0);
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

  test("nothing fits: no second button — and the Kling-only worst is still the engine's own, for what a refused «без запасной модели» needed (L6)", () => {
    const s = batchSheetView(batchOptions({ worst: 15_500_000, noFallback: 9_240_000, fit: "none" }), { quality: "std", seconds: 10 });
    expect(s).toMatchObject({ key: "std10", fits: false, noFallback: null, budgetNeed: "$15.50", worstNoFallbackMicros: 9_240_000 });
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

  test("L8: a photo no longer in the gallery says the same on its row and in the alert", () => {
    expect(itemRefusedAlert("Фото 5 · Виды", "not-a-gallery-photo")).toBe(`Фото 5 · Виды не оживить: этого фото больше нет в галерее. Сумма пересчитана${NBSP}— подтвердите ещё раз.`);
    expect(batchRowNote(scenePhoto(5), suitable("p5"), "not-a-gallery-photo")).toEqual({ text: "Этого фото больше нет в галерее.", struck: true, bold: false });
    expect(batchRowNote(scenePhoto(5), { suitable: false, photoId: "p5", reason: "not-a-gallery-photo" }, undefined)).toEqual({ text: "Этого фото больше нет в галерее.", struck: true, bold: false });
  });
});

describe("the sheet's row notes (59)", () => {
  const options = (photoId: string, o: Parameters<typeof suitable>[1] = {}) => suitable(photoId, o);

  test("«Смелая»: «без запасной модели», in the accent", () => {
    expect(batchRowNote(scenePhoto(3), options("p3", { bold: true }), undefined)).toEqual({ text: "без запасной модели", struck: false, bold: true });
  });

  test("L9: the note follows the engine's `fallback: none`, not the frame's category", () => {
    expect(batchRowNote(scenePhoto(3), options("p3", { fallback: "none" }), undefined)).toEqual({ text: "без запасной модели", struck: false, bold: true });
    expect(batchRowNote(scenePhoto(3), options("p3", { fallback: "offer" }), undefined)).toBeNull();
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
