import { describe, expect, test } from "bun:test";
import {
  ApiKeyStatus,
  AvatarSummary,
  Draft,
  EngineNotice,
  Estimate,
  JobState,
  MoneyStatus,
  ReconcileResult,
  RunRequest,
  Settings,
} from "./state";

const keyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };

const settings = {
  apiKey: keyStatus,
  monthlyBudgetMicros: 10_000_000,
  libraryPath: "/Users/alex/Studio/library",
  imageModel: "x-ai/grok-imagine-image-2.0",
  textModel: "x-ai/grok-4.3",
  concurrency: { network: 6 },
};

const money = {
  ledger: "open",
  month: "2026-09",
  spentMicros: 1_250_000,
  monthlyBudgetMicros: 10_000_000,
  unsettledMicros: 0,
  unsettledCount: 0,
  reconcileNeeded: false,
  reconcileReasons: [],
  halt: null,
};

/** The ledger could not be read at start: no amounts, only why. */
const unavailableMoney = {
  ledger: "unavailable",
  month: "2026-09",
  monthlyBudgetMicros: 10_000_000,
  reconcileNeeded: false,
  reconcileReasons: [],
  halt: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" },
};

const reconciled = {
  status: "done",
  creditsDeltaMicros: 210_000,
  deltaUnavailable: null,
  ledgerDeltaMicros: 230_000,
  mismatch: true,
  closedReserves: 2,
  aboveWorstAttempts: [],
  tornLineMoved: false,
  warnings: [],
};

const estimate = { expectedMicros: 200_000, worstMicros: 230_000, prices: "live", pricesAsOf: "2026-09-24" };

const traits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "approachable, coffee, travel, books",
};

const descriptor = { age: 25, text: "25-year-old woman, light olive skin, hazel eyes, slim athletic build." };

const candidate = { avatarId: "avatar-0001", photoId: "photo-0001" };

const draft = { avatarId: "avatar-0001", traits, descriptor, candidates: [candidate], estimate };

const candidatesJob = {
  kind: "avatar.candidates",
  jobId: "job-00000001",
  avatarId: "avatar-0001",
  status: "running",
  done: 1,
  total: 4,
};

const candidatesResult = {
  kind: "avatar.candidates",
  avatarId: "avatar-0001",
  candidates: [candidate],
  rejectedByAgeCheck: 0,
};

const runJob = { kind: "run", jobId: "job-00000002", runId: "run-00000001", status: "running", done: 3, total: 20 };

const run = { avatarId: "avatar-0001", count: 20, categories: ["home", "travel"], resolution: "1k" };

const avatar = {
  avatarId: "avatar-0001",
  name: "Лиза",
  descriptor,
  masterPhotoId: "photo-0001",
  createdAt: "2026-09-24T10:00:00Z",
  status: "active",
  photoCount: 0,
};

describe("ApiKeyStatus", () => {
  test("accepts a stored key described only by its last four chars", () => {
    expect(ApiKeyStatus.safeParse(keyStatus).success).toBe(true);
  });

  test("accepts no stored key with a null last4", () => {
    const s = { stored: false, last4: null, encryptionAvailable: false, rejected: false };
    expect(ApiKeyStatus.safeParse(s).success).toBe(true);
  });

  test("accepts a stored key that OpenRouter rejected with 401", () => {
    expect(ApiKeyStatus.safeParse({ ...keyStatus, rejected: true }).success).toBe(true);
  });

  test("rejects a rejected flag without a stored key", () => {
    const s = { stored: false, last4: null, encryptionAvailable: true, rejected: true };
    expect(ApiKeyStatus.safeParse(s).success).toBe(false);
  });

  test("rejects a status without the rejected flag", () => {
    const { rejected: _r, ...withoutRejected } = keyStatus;
    expect(ApiKeyStatus.safeParse(withoutRejected).success).toBe(false);
  });

  test("rejects a status that carries the key itself", () => {
    expect(ApiKeyStatus.safeParse({ ...keyStatus, key: "sk-or-v1-0123456789abcdef" }).success).toBe(false);
  });

  test("rejects a stored key without last4", () => {
    expect(ApiKeyStatus.safeParse({ ...keyStatus, last4: null }).success).toBe(false);
  });

  test("rejects last4 when no key is stored", () => {
    expect(ApiKeyStatus.safeParse({ ...keyStatus, stored: false }).success).toBe(false);
  });

  test.each(["3f2", "3f2a9", "3f a"])("rejects last4 %p that is not four visible chars", (last4) => {
    expect(ApiKeyStatus.safeParse({ ...keyStatus, last4 }).success).toBe(false);
  });
});

describe("Settings", () => {
  test("accepts the defaults", () => {
    expect(Settings.safeParse(settings).success).toBe(true);
  });

  test("rejects a float budget", () => {
    expect(Settings.safeParse({ ...settings, monthlyBudgetMicros: 10.5 }).success).toBe(false);
  });

  test("rejects a negative budget", () => {
    expect(Settings.safeParse({ ...settings, monthlyBudgetMicros: -1 }).success).toBe(false);
  });

  test("rejects a relative library path", () => {
    expect(Settings.safeParse({ ...settings, libraryPath: "Studio/library" }).success).toBe(false);
  });

  test("rejects a malformed model id", () => {
    expect(Settings.safeParse({ ...settings, imageModel: "grok" }).success).toBe(false);
  });

  test.each([1, 16])("accepts network concurrency %p", (network) => {
    expect(Settings.safeParse({ ...settings, concurrency: { network } }).success).toBe(true);
  });

  test.each([0, 17, 2.5])("rejects network concurrency %p", (network) => {
    expect(Settings.safeParse({ ...settings, concurrency: { network } }).success).toBe(false);
  });

  test("rejects an extra field", () => {
    expect(Settings.safeParse({ ...settings, apiKeyPlain: "x" }).success).toBe(false);
  });
});

describe("MoneyStatus", () => {
  test("accepts a clean month", () => {
    expect(MoneyStatus.safeParse(money).success).toBe(true);
  });

  test("accepts a torn ledger line that needs reconciling", () => {
    const s = { ...money, reconcileNeeded: true, reconcileReasons: ["torn-ledger-line"] };
    expect(MoneyStatus.safeParse(s).success).toBe(true);
  });

  test("accepts both reasons at once", () => {
    const s = { ...money, reconcileNeeded: true, reconcileReasons: ["open-reserves", "torn-ledger-line"] };
    expect(MoneyStatus.safeParse(s).success).toBe(true);
  });

  test.each([
    ["spentMicros", 0.05],
    ["monthlyBudgetMicros", -10],
    ["unsettledMicros", 1.5],
    ["unsettledCount", -1],
  ])("rejects %s = %p", (field, value) => {
    expect(MoneyStatus.safeParse({ ...money, [field]: value }).success).toBe(false);
  });

  test("rejects the old budgetMicros name", () => {
    const { monthlyBudgetMicros, ...rest } = money;
    expect(MoneyStatus.safeParse({ ...rest, budgetMicros: monthlyBudgetMicros }).success).toBe(false);
  });

  test("rejects the old single reconcileReason field", () => {
    const { reconcileReasons: _r, ...rest } = money;
    expect(MoneyStatus.safeParse({ ...rest, reconcileReason: null }).success).toBe(false);
  });

  test.each(["2026-13", "2026-00", "2026-9", "26-09"])("rejects the month %p", (month) => {
    expect(MoneyStatus.safeParse({ ...money, month }).success).toBe(false);
  });

  test("rejects reconcileNeeded without a reason", () => {
    expect(MoneyStatus.safeParse({ ...money, reconcileNeeded: true }).success).toBe(false);
  });

  test("rejects a reason when no reconcile is needed", () => {
    expect(MoneyStatus.safeParse({ ...money, reconcileReasons: ["open-reserves"] }).success).toBe(false);
  });

  test("rejects a repeated reason", () => {
    const s = { ...money, reconcileNeeded: true, reconcileReasons: ["open-reserves", "open-reserves"] };
    expect(MoneyStatus.safeParse(s).success).toBe(false);
  });

  test("rejects an unknown reconcile reason", () => {
    const s = { ...money, reconcileNeeded: true, reconcileReasons: ["because"] };
    expect(MoneyStatus.safeParse(s).success).toBe(false);
  });

  test("rejects a status without a halt field: no halt is null, never missing", () => {
    const { halt: _h, ...withoutHalt } = money;
    expect(MoneyStatus.safeParse(withoutHalt).success).toBe(false);
  });

  test("accepts a halt for attempts billed above their worst case, with the attempts listed", () => {
    const halt = { cause: "SETTLE_ABOVE_WORST", detail: "the price table is wrong; reconcile to acknowledge", attemptIds: ["slot-3#2"] };
    expect(MoneyStatus.safeParse({ ...money, halt }).success).toBe(true);
  });

  test("rejects a settle-above-worst halt that lists no attempt", () => {
    const halt = { cause: "SETTLE_ABOVE_WORST", detail: "the price table is wrong", attemptIds: [] };
    expect(MoneyStatus.safeParse({ ...money, halt }).success).toBe(false);
  });

  test.each(["", "a b", "x".repeat(129)])("rejects the attempt id %p in a settle-above-worst halt", (attemptId) => {
    const halt = { cause: "SETTLE_ABOVE_WORST", detail: "the price table is wrong", attemptIds: [attemptId] };
    expect(MoneyStatus.safeParse({ ...money, halt }).success).toBe(false);
  });

  test("accepts a halt after a failed ledger write, next to open reserves that also need a reconcile", () => {
    const s = {
      ...money,
      unsettledMicros: 55_000,
      unsettledCount: 1,
      reconcileNeeded: true,
      reconcileReasons: ["open-reserves"],
      halt: { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed; restart the app" },
    };
    expect(MoneyStatus.safeParse(s).success).toBe(true);
  });

  test.each(["LEDGER_CORRUPT", "LEDGER_UNREADABLE", "INTERNAL"])("rejects the halt cause %p on a ledger that was read", (cause) => {
    expect(MoneyStatus.safeParse({ ...money, halt: { cause, detail: "x" } }).success).toBe(false);
  });

  test("strips a key from a halt detail", () => {
    const parsed = MoneyStatus.parse({ ...money, halt: { cause: "LEDGER_WRITE_FAILED", detail: "failed with sk-or-v1-abcdef0123456789" } });
    expect(JSON.stringify(parsed)).not.toContain("sk-or-v1-abcdef0123456789");
  });

  test("rejects a halt detail over 500 chars", () => {
    expect(MoneyStatus.safeParse({ ...money, halt: { cause: "LEDGER_WRITE_FAILED", detail: "x".repeat(501) } }).success).toBe(false);
  });

  test.each(["LEDGER_CORRUPT", "LEDGER_UNREADABLE"])("accepts a ledger that could not be read (%s): the cause, no amounts", (cause) => {
    expect(MoneyStatus.safeParse({ ...unavailableMoney, halt: { cause, detail: "x" } }).success).toBe(true);
  });

  test.each(["spentMicros", "unsettledMicros", "unsettledCount"])("rejects %s on a ledger that could not be read: the amount is unknown", (field) => {
    expect(MoneyStatus.safeParse({ ...unavailableMoney, [field]: 0 }).success).toBe(false);
  });

  test("rejects a ledger that could not be read without the cause", () => {
    expect(MoneyStatus.safeParse({ ...unavailableMoney, halt: null }).success).toBe(false);
  });

  test("rejects a ledger that could not be read with a halt that belongs to a readable one", () => {
    const halt = { cause: "LEDGER_WRITE_FAILED", detail: "x" };
    expect(MoneyStatus.safeParse({ ...unavailableMoney, halt }).success).toBe(false);
  });

  test("rejects a reconcile on a ledger that could not be read: reconcile needs the ledger", () => {
    const s = { ...unavailableMoney, reconcileNeeded: true, reconcileReasons: ["open-reserves"] };
    expect(MoneyStatus.safeParse(s).success).toBe(false);
  });

  test("rejects an unknown ledger state", () => {
    expect(MoneyStatus.safeParse({ ...money, ledger: "closed" }).success).toBe(false);
  });
});

describe("Estimate", () => {
  test("accepts expected below worst", () => {
    expect(Estimate.safeParse(estimate).success).toBe(true);
  });

  test("accepts expected equal to worst", () => {
    expect(Estimate.safeParse({ ...estimate, expectedMicros: 230_000 }).success).toBe(true);
  });

  test("rejects expected above worst", () => {
    expect(Estimate.safeParse({ ...estimate, expectedMicros: 230_001 }).success).toBe(false);
  });

  test("rejects a float worst case", () => {
    expect(Estimate.safeParse({ ...estimate, worstMicros: 0.23 }).success).toBe(false);
  });

  test("accepts fallback prices with their date", () => {
    expect(Estimate.safeParse({ ...estimate, prices: "fallback", pricesAsOf: "2026-09-01" }).success).toBe(true);
  });

  test.each([
    ["prices", "cached"],
    ["pricesAsOf", "yesterday"],
    ["pricesAsOf", "2026-09-24T10:00:00Z"],
  ])("rejects %s = %p", (field, value) => {
    expect(Estimate.safeParse({ ...estimate, [field]: value }).success).toBe(false);
  });
});

describe("Draft", () => {
  test("accepts a draft avatar with its traits, descriptor, candidates and estimate", () => {
    expect(Draft.safeParse(draft).success).toBe(true);
  });

  test("accepts a draft before any candidate exists", () => {
    expect(Draft.safeParse({ ...draft, candidates: [] }).success).toBe(true);
  });

  test("accepts more than four candidates across several batches", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({ avatarId: "avatar-0001", photoId: `photo-000${i}` }));
    expect(Draft.safeParse({ ...draft, candidates }).success).toBe(true);
  });

  test("rejects a candidate that belongs to another avatar", () => {
    const candidates = [{ avatarId: "avatar-0002", photoId: "photo-0001" }];
    expect(Draft.safeParse({ ...draft, candidates }).success).toBe(false);
  });

  test("rejects a descriptor whose age differs from the traits", () => {
    const other = { age: 26, text: "26-year-old woman, light olive skin." };
    expect(Draft.safeParse({ ...draft, descriptor: other }).success).toBe(false);
  });

  test("rejects a draft without an estimate", () => {
    const { estimate: _e, ...withoutEstimate } = draft;
    expect(Draft.safeParse(withoutEstimate).success).toBe(false);
  });

  test("accepts a draft whose next batch the engine cannot price now (estimate null)", () => {
    expect(Draft.safeParse({ ...draft, estimate: null }).success).toBe(true);
  });
});

describe("AvatarSummary", () => {
  test.each(["active", "archived"])("accepts status %p", (status) => {
    expect(AvatarSummary.safeParse({ ...avatar, status }).success).toBe(true);
  });

  test("rejects a draft: drafts are listed separately", () => {
    expect(AvatarSummary.safeParse({ ...avatar, status: "draft" }).success).toBe(false);
  });

  test("rejects a language field: on-video text is English only", () => {
    expect(AvatarSummary.safeParse({ ...avatar, language: "en" }).success).toBe(false);
  });

  test("rejects the old archived flag", () => {
    const { status: _s, ...rest } = avatar;
    expect(AvatarSummary.safeParse({ ...rest, archived: false }).success).toBe(false);
  });
});

describe("JobState", () => {
  test("accepts a running candidates job for a draft avatar", () => {
    expect(JobState.safeParse(candidatesJob).success).toBe(true);
  });

  test("accepts a running photo run job", () => {
    expect(JobState.safeParse(runJob).success).toBe(true);
  });

  test("accepts a done job with its result", () => {
    const j = { ...candidatesJob, status: "done", done: 4, result: candidatesResult };
    expect(JobState.safeParse(j).success).toBe(true);
  });

  test("accepts a failed job with its error", () => {
    const j = { ...candidatesJob, status: "failed", error: { code: "AUTH_INVALID" } };
    expect(JobState.safeParse(j).success).toBe(true);
  });

  test("rejects a done job without a result", () => {
    expect(JobState.safeParse({ ...candidatesJob, status: "done", done: 4 }).success).toBe(false);
  });

  test("rejects a failed job without an error", () => {
    expect(JobState.safeParse({ ...candidatesJob, status: "failed" }).success).toBe(false);
  });

  test("rejects a running job that already has a result", () => {
    expect(JobState.safeParse({ ...candidatesJob, result: candidatesResult }).success).toBe(false);
  });

  test("rejects a running job that carries an error", () => {
    expect(JobState.safeParse({ ...candidatesJob, error: { code: "NETWORK" } }).success).toBe(false);
  });

  test("rejects a candidates result for another avatar", () => {
    const other = { ...candidatesResult, avatarId: "avatar-0002", candidates: [{ avatarId: "avatar-0002", photoId: "photo-0009" }] };
    const j = { ...candidatesJob, status: "done", done: 4, result: other };
    expect(JobState.safeParse(j).success).toBe(false);
  });

  test("rejects a run result for another run", () => {
    const result = { kind: "run", runId: "run-00000009", photoIds: [], failedSlots: 0 };
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result }).success).toBe(false);
  });

  test("rejects a run result on a candidates job", () => {
    const result = { kind: "run", runId: "run-00000001", photoIds: [], failedSlots: 0 };
    expect(JobState.safeParse({ ...candidatesJob, status: "done", done: 4, result }).success).toBe(false);
  });

  test("rejects a candidates job without its avatarId", () => {
    const { avatarId: _a, ...withoutAvatar } = candidatesJob;
    expect(JobState.safeParse(withoutAvatar).success).toBe(false);
  });

  test("rejects a run job without its runId", () => {
    const { runId: _r, ...withoutRun } = runJob;
    expect(JobState.safeParse(withoutRun).success).toBe(false);
  });

  test("rejects done above total", () => {
    expect(JobState.safeParse({ ...candidatesJob, done: 5 }).success).toBe(false);
  });

  test("rejects an unknown status", () => {
    expect(JobState.safeParse({ ...candidatesJob, status: "paused" }).success).toBe(false);
  });

  test("rejects an unknown kind", () => {
    expect(JobState.safeParse({ ...candidatesJob, kind: "video" }).success).toBe(false);
  });
});

describe("ReconcileResult", () => {
  test("accepts a finished reconcile that shows both totals and the verdict", () => {
    expect(ReconcileResult.safeParse(reconciled).success).toBe(true);
  });

  test.each(["no-baseline", "negative-delta"])("accepts a reconcile whose /credits delta is unavailable (%s): no delta, no verdict", (why) => {
    const r = { ...reconciled, creditsDeltaMicros: null, deltaUnavailable: why, mismatch: null };
    expect(ReconcileResult.safeParse(r).success).toBe(true);
  });

  test("rejects a delta together with a reason it is unavailable", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, deltaUnavailable: "no-baseline" }).success).toBe(false);
  });

  test("rejects a missing delta without the reason", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, creditsDeltaMicros: null, mismatch: null }).success).toBe(false);
  });

  test("rejects a verdict without a delta to compare", () => {
    const r = { ...reconciled, creditsDeltaMicros: null, deltaUnavailable: "no-baseline", mismatch: false };
    expect(ReconcileResult.safeParse(r).success).toBe(false);
  });

  test("rejects a delta without a verdict", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, mismatch: null }).success).toBe(false);
  });

  test("accepts the above-worst attempts this reconcile acknowledged", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, aboveWorstAttempts: ["slot-3#2", "age-1#1"] }).success).toBe(true);
  });

  test("rejects a done answer without the acknowledged above-worst attempts", () => {
    const { aboveWorstAttempts: _a, ...without } = reconciled;
    expect(ReconcileResult.safeParse(without).success).toBe(false);
  });

  test("rejects the old done shape without delta reason, verdict, attempts or warnings", () => {
    const r = { status: "done", creditsDeltaMicros: 210_000, ledgerDeltaMicros: 230_000, closedReserves: 2, tornLineMoved: false };
    expect(ReconcileResult.safeParse(r).success).toBe(false);
  });

  test("accepts a clock-skew warning on a finished reconcile", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, warnings: ["clock-skew"] }).success).toBe(true);
  });

  test.each([[["clock-skew", "clock-skew"]], [["late"]]])("rejects the warnings %p", (warnings) => {
    expect(ReconcileResult.safeParse({ ...reconciled, warnings }).success).toBe(false);
  });

  test("accepts a too-early answer with a wait", () => {
    expect(ReconcileResult.safeParse({ status: "too-early", retryAfterMs: 45_000, warnings: [] }).success).toBe(true);
  });

  test("accepts a too-early answer measured on the monotonic clock (clock skew)", () => {
    expect(ReconcileResult.safeParse({ status: "too-early", retryAfterMs: 45_000, warnings: ["clock-skew"] }).success).toBe(true);
  });

  test("rejects a too-early answer with a zero wait", () => {
    expect(ReconcileResult.safeParse({ status: "too-early", retryAfterMs: 0, warnings: [] }).success).toBe(false);
  });

  test("rejects an in-flight result: requests in flight are the IN_FLIGHT error, not a result", () => {
    expect(ReconcileResult.safeParse({ status: "in-flight", inFlight: 2 }).success).toBe(false);
  });

  test("rejects a float credits delta", () => {
    expect(ReconcileResult.safeParse({ ...reconciled, creditsDeltaMicros: 0.21 }).success).toBe(false);
  });
});

describe("EngineNotice", () => {
  const notice = { noticeId: "notice-0001", code: "engine-restarted", detail: "the engine exited unexpectedly (code 9)", at: "2026-09-24T10:00:00.000Z", count: 1 };

  test("accepts an engine restart with its diagnostic detail", () => {
    expect(EngineNotice.safeParse(notice).success).toBe(true);
  });

  test("accepts a settings reset without a detail", () => {
    const { detail: _d, ...withoutDetail } = notice;
    expect(EngineNotice.safeParse({ ...withoutDetail, code: "settings-reset" }).success).toBe(true);
  });

  test.each(["INTERNAL", "engine.error", "crash"])("rejects the code %p: a notice is not an error code", (code) => {
    expect(EngineNotice.safeParse({ ...notice, code }).success).toBe(false);
  });

  test("accepts a notice that happened several times this session: the count, the latest detail and time", () => {
    expect(EngineNotice.safeParse({ ...notice, count: 7 }).success).toBe(true);
  });

  test.each([0, 1.5, -1])("rejects a count of %p", (count) => {
    expect(EngineNotice.safeParse({ ...notice, count }).success).toBe(false);
  });

  test("rejects a notice without a count", () => {
    const { count: _c, ...withoutCount } = notice;
    expect(EngineNotice.safeParse(withoutCount).success).toBe(false);
  });

  test("rejects a notice without an id", () => {
    const { noticeId: _n, ...withoutId } = notice;
    expect(EngineNotice.safeParse(withoutId).success).toBe(false);
  });

  test("strips a key from the detail", () => {
    const parsed = EngineNotice.parse({ ...notice, detail: "Bearer sk-or-v1-abcdef0123456789" });
    expect(parsed.detail).not.toContain("sk-or-v1");
  });
});

describe("RunRequest (2b placeholder)", () => {
  test.each([1, 100])("accepts a count of %p", (count) => {
    expect(RunRequest.safeParse({ ...run, count }).success).toBe(true);
  });

  test.each([0, 101, 20.5])("rejects a count of %p", (count) => {
    expect(RunRequest.safeParse({ ...run, count }).success).toBe(false);
  });

  test("rejects no categories", () => {
    expect(RunRequest.safeParse({ ...run, categories: [] }).success).toBe(false);
  });

  test("rejects a repeated category", () => {
    expect(RunRequest.safeParse({ ...run, categories: ["home", "home"] }).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    expect(RunRequest.safeParse({ ...run, categories: ["lingerie"] }).success).toBe(false);
  });

  test("rejects an unknown resolution", () => {
    expect(RunRequest.safeParse({ ...run, resolution: "4k" }).success).toBe(false);
  });
});
