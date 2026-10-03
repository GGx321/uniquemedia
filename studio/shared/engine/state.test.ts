import { describe, expect, test } from "bun:test";
import {
  ApiKeyStatus,
  AvatarSummary,
  CandidatesResult,
  Draft,
  EngineNotice,
  Estimate,
  ExportStatus,
  JobCancelled,
  JobFailed,
  JobProgress,
  JobState,
  MoneyStatus,
  MusicKeyStatus,
  PhotoSummary,
  ReconcileResult,
  RunRequest,
  RunSummary,
  Settings,
  UnreadableAvatar,
  UsageUnknownReason,
} from "./state";

const keyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };

const musicKeyStatus = { stored: true, last4: "0000", rejected: false };

const settings = {
  apiKey: keyStatus,
  musicKey: musicKeyStatus,
  monthlyBudgetMicros: 10_000_000,
  libraryPath: "/Users/alex/Studio/library",
  imageModel: "x-ai/grok-imagine-image-2.0",
  textModel: "x-ai/grok-4.3",
  concurrency: { network: 6 },
  imageAgeCheck: "off",
  exportPath: "/Users/alex/Studio/export",
  renderConcurrency: "auto",
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

const draft = { avatarId: "avatar-0001", traits, descriptor, candidates: [candidate], hiddenBelowThreshold: 0, estimate };

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
  failedSlots: [],
};

const runJob = { kind: "run", jobId: "job-00000002", runId: "run-00000001", avatarId: "avatar-0001", status: "running", done: 3, total: 20 };

const runResult = { kind: "run", runId: "run-00000001", avatarId: "avatar-0001", photoIds: ["photo-0002"], failedSlots: 19 };

const run = { avatarId: "avatar-0001", count: 20, categories: ["home", "travel"], poses: { profile: false, back: false } };

const runSummary = {
  runId: "run-00000001",
  avatarId: "avatar-0001",
  createdAt: "2026-09-24T11:00:00.000Z",
  total: 20,
  done: 12,
  failed: 1,
  open: 7,
  capMicros: 3_385_000,
  committedMicros: 1_200_000,
  running: false,
  resumable: true,
  capExhausted: false,
  remainingWorstMicros: 1_650_000,
};

const avatar = {
  avatarId: "avatar-0001",
  name: "Лиза",
  descriptor,
  masterPhotoId: "photo-0001",
  createdAt: "2026-09-24T10:00:00Z",
  status: "active",
  photoCount: 0,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

const photo = {
  photoId: "photo-0002",
  avatarId: "avatar-0001",
  runId: "run-00000001",
  category: "home",
  createdAt: "2026-09-24T11:00:00Z",
  used: false,
  usedIn: [] as string[],
  rejected: false,
  reserved: false,
  eligible: true,
};

const renderJob = {
  kind: "render",
  jobId: "job-00000003",
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  montageId: "montage-00000001",
  status: "running",
  done: 90,
  total: 240,
};

const renderResult = {
  kind: "render",
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  bytes: 3_100_000,
  durationMs: 8_000,
  videoKind: "photo",
  relPath: "Mia/2026-09-29_photo_001.mp4",
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

describe("MusicKeyStatus", () => {
  test("accepts a stored key described only by its last four chars", () => {
    expect(MusicKeyStatus.safeParse(musicKeyStatus).success).toBe(true);
  });

  test("accepts no stored key with a null last4", () => {
    expect(MusicKeyStatus.safeParse({ stored: false, last4: null, rejected: false }).success).toBe(true);
  });

  test("accepts a stored key that flashapi rejected with 401", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, rejected: true }).success).toBe(true);
  });

  test("rejects a rejected flag without a stored key", () => {
    expect(MusicKeyStatus.safeParse({ stored: false, last4: null, rejected: true }).success).toBe(false);
  });

  test("rejects a stored key without last4", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, last4: null }).success).toBe(false);
  });

  test("rejects last4 when no key is stored", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, stored: false }).success).toBe(false);
  });

  test.each(["000", "00000", "00 0"])("rejects last4 %p that is not four visible chars", (last4) => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, last4 }).success).toBe(false);
  });

  test("rejects a status that carries the key itself", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, key: "Zq7-vKt9-Wm2x-Lp4s-0000" }).success).toBe(false);
  });

  test("rejects a status with the quota in it: K24 keeps the quota in MusicStatus", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, sentLast31d: 3 }).success).toBe(false);
  });

  test("has no encryptionAvailable: that one lives on the OpenRouter key's status", () => {
    expect(MusicKeyStatus.safeParse({ ...musicKeyStatus, encryptionAvailable: true }).success).toBe(false);
  });
});

describe("Settings", () => {
  test("accepts the defaults", () => {
    expect(Settings.safeParse(settings).success).toBe(true);
  });

  test("rejects settings without the music key status", () => {
    const { musicKey: _m, ...without } = settings;
    expect(Settings.safeParse(without).success).toBe(false);
  });

  test("rejects a music key status that smuggles the key", () => {
    expect(Settings.safeParse({ ...settings, musicKey: { ...musicKeyStatus, key: "Zq7-vKt9-Wm2x-Lp4s-0000" } }).success).toBe(false);
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

  test.each(["off", "on"])("accepts imageAgeCheck %p", (imageAgeCheck) => {
    expect(Settings.safeParse({ ...settings, imageAgeCheck }).success).toBe(true);
  });

  test("rejects an imageAgeCheck outside off/on", () => {
    expect(Settings.safeParse({ ...settings, imageAgeCheck: "true" }).success).toBe(false);
  });

  test("rejects a relative export path", () => {
    expect(Settings.safeParse({ ...settings, exportPath: "Studio/export" }).success).toBe(false);
  });

  test("rejects an export path with a .. segment", () => {
    expect(Settings.safeParse({ ...settings, exportPath: "/Users/alex/../export" }).success).toBe(false);
  });

  test("rejects a missing export path: the default is settingsStore's, the contract always names a folder", () => {
    const { exportPath: _e, ...rest } = settings;
    expect(Settings.safeParse(rest).success).toBe(false);
  });

  test.each(["auto", 1, 4, 8])("accepts render concurrency %p", (renderConcurrency) => {
    expect(Settings.safeParse({ ...settings, renderConcurrency }).success).toBe(true);
  });

  test.each([0, 9, 2.5, -1, "2", "Auto", null])("rejects render concurrency %p", (renderConcurrency) => {
    expect(Settings.safeParse({ ...settings, renderConcurrency }).success).toBe(false);
  });

  test("rejects a missing render concurrency", () => {
    const { renderConcurrency: _r, ...rest } = settings;
    expect(Settings.safeParse(rest).success).toBe(false);
  });

  test("rejects a missing imageAgeCheck: no default at the contract's own boundary, only in settingsStore's file-loading (backward compatibility lives there, not here)", () => {
    const { imageAgeCheck: _drop, ...rest } = settings;
    expect(Settings.safeParse(rest).success).toBe(false);
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

  test("rejects a draft without hiddenBelowThreshold: how many stored candidates today's threshold hides", () => {
    const { hiddenBelowThreshold: _h, ...withoutField } = draft;
    expect(Draft.safeParse(withoutField).success).toBe(false);
  });

  test("accepts hiddenBelowThreshold as a nonnegative count, even above the current candidates", () => {
    expect(Draft.safeParse({ ...draft, hiddenBelowThreshold: 3 }).success).toBe(true);
  });

  test("rejects a negative hiddenBelowThreshold", () => {
    expect(Draft.safeParse({ ...draft, hiddenBelowThreshold: -1 }).success).toBe(false);
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

  test("carries the number of video records and of eligible unused photos", () => {
    expect(AvatarSummary.safeParse({ ...avatar, photoCount: 12, videoCount: 3, eligibleUnusedCount: 9 }).success).toBe(true);
  });

  test("rejects a summary without videoCount or eligibleUnusedCount", () => {
    const { videoCount: _v, ...noVideos } = avatar;
    const { eligibleUnusedCount: _e, ...noEligible } = avatar;
    expect(AvatarSummary.safeParse(noVideos).success).toBe(false);
    expect(AvatarSummary.safeParse(noEligible).success).toBe(false);
  });

  test.each([-1, 1.5])("rejects a videoCount of %p", (videoCount) => {
    expect(AvatarSummary.safeParse({ ...avatar, videoCount }).success).toBe(false);
  });

  test("accepts every gallery photo being eligible and unused", () => {
    expect(AvatarSummary.safeParse({ ...avatar, photoCount: 5, eligibleUnusedCount: 5 }).success).toBe(true);
  });

  test("a derived count never hides an avatar: an eligible count above the photo count still parses", () => {
    expect(AvatarSummary.safeParse({ ...avatar, photoCount: 5, eligibleUnusedCount: 6 }).success).toBe(true);
  });

  test("videos may outnumber photos: a video lists several", () => {
    expect(AvatarSummary.safeParse({ ...avatar, photoCount: 2, videoCount: 7 }).success).toBe(true);
  });
});

describe("AvatarSummary.usage (3e.2, K16)", () => {
  test("a sound avatar's usage is ok", () => {
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "ok" } }).success).toBe(true);
  });

  test.each(["record-unreadable", "record-inaccessible", "rejects-unreadable", "index-stale", "library-too-new"])("an unknown usage names why: %s", (reason) => {
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: [reason] } }).success).toBe(true);
  });

  test("an unknown usage may name every reason at once, so the window offers both recoveries", () => {
    expect(
      AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: ["library-too-new", "index-stale", "record-unreadable", "record-inaccessible", "rejects-unreadable"] } }).success,
    ).toBe(true);
  });

  test("the reasons are exactly the five the library can close an avatar for", () => {
    const actual: string[] = [...UsageUnknownReason.options].sort();
    expect(actual).toEqual(["index-stale", "library-too-new", "record-inaccessible", "record-unreadable", "rejects-unreadable"]);
  });

  test("a summary always says how its usage stands: it is never left out", () => {
    const { usage: _u, ...rest } = avatar;
    expect(AvatarSummary.safeParse(rest).success).toBe(false);
  });

  test("an unknown usage without a reason is refused: the window would have nothing to offer", () => {
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: [] } }).success).toBe(false);
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown" } }).success).toBe(false);
  });

  test("a reason is named once", () => {
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: ["index-stale", "index-stale"] } }).success).toBe(false);
  });

  test("an unknown reason, or a detail beside the reasons, is refused (no file name ever travels)", () => {
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: ["disk-on-fire"] } }).success).toBe(false);
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "unknown", reasons: ["record-unreadable"], file: "videos/x.json" } }).success).toBe(false);
    expect(AvatarSummary.safeParse({ ...avatar, usage: { state: "ok", reasons: ["index-stale"] } }).success).toBe(false);
  });
});

describe("UnreadableAvatar", () => {
  const entry = { avatarId: "avatar-0009", name: "Mia", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" };

  test("accepts a string name, the same schema AvatarSummary's name uses", () => {
    expect(UnreadableAvatar.safeParse(entry).success).toBe(true);
  });

  test("accepts a null name: some reasons (a quarantined or corrupt manifest) leave no trustworthy name", () => {
    expect(UnreadableAvatar.safeParse({ ...entry, name: null }).success).toBe(true);
  });

  test("rejects a missing name field: it must say null explicitly when there is none", () => {
    const { name: _name, ...withoutName } = entry;
    expect(UnreadableAvatar.safeParse(withoutName).success).toBe(false);
  });

  test("rejects a name over 60 chars, the same limit AvatarSummary's name enforces", () => {
    expect(UnreadableAvatar.safeParse({ ...entry, name: "N".repeat(61) }).success).toBe(false);
  });

  test("rejects a blank name", () => {
    expect(UnreadableAvatar.safeParse({ ...entry, name: "   " }).success).toBe(false);
  });
});

describe("CandidatesResult", () => {
  const second = { avatarId: "avatar-0001", photoId: "photo-0002" };
  const full = {
    kind: "avatar.candidates",
    avatarId: "avatar-0001",
    candidates: [candidate, second],
    rejectedByAgeCheck: 1,
    failedSlots: [
      { slot: 3, reason: "age-rejected" },
      { slot: 4, reason: "failed", error: { code: "TIMEOUT", detail: "no response within 180000 ms" }, reserveLeftOpen: true },
    ],
  };

  test("carries the slots that gave no candidate and why: rejected by the age check, or failed with its error and whether its reserve is still open", () => {
    expect(CandidatesResult.safeParse(full).success).toBe(true);
  });

  test("a result must say which slots gave nothing, even when none did", () => {
    const { failedSlots: _failedSlots, ...without } = full;
    expect(CandidatesResult.safeParse(without).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, candidates: [candidate, second], rejectedByAgeCheck: 0, failedSlots: [] }).success).toBe(true);
  });

  test("rejectedByAgeCheck is the number of age-rejected slots", () => {
    expect(CandidatesResult.safeParse({ ...full, rejectedByAgeCheck: 2 }).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, rejectedByAgeCheck: 0 }).success).toBe(false);
  });

  test("a slot is 1 to 4 and is listed once", () => {
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [{ slot: 5, reason: "age-rejected" }, full.failedSlots[1]] }).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [{ slot: 0, reason: "age-rejected" }, full.failedSlots[1]] }).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [{ slot: 4, reason: "age-rejected" }, full.failedSlots[1]] }).success).toBe(false);
  });

  test("candidates and slots that gave nothing are at most the four of a batch", () => {
    const four = ["photo-0001", "photo-0002", "photo-0003", "photo-0004"].map((photoId) => ({ avatarId: "avatar-0001", photoId }));
    expect(CandidatesResult.safeParse({ ...full, candidates: four, rejectedByAgeCheck: 0, failedSlots: [full.failedSlots[1]] }).success).toBe(false);
  });

  test("a failed slot needs its error and the reserve flag; an age-rejected one carries neither", () => {
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [full.failedSlots[0], { slot: 4, reason: "failed", reserveLeftOpen: false }] }).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [full.failedSlots[0], { slot: 4, reason: "failed", error: { code: "NETWORK" } }] }).success).toBe(false);
    expect(CandidatesResult.safeParse({ ...full, failedSlots: [{ slot: 3, reason: "age-rejected", error: { code: "NETWORK" } }, full.failedSlots[1]] }).success).toBe(false);
  });
});

describe("JobProgress", () => {
  const progress = { kind: "avatar.candidates", jobId: "job-00000001", avatarId: "avatar-0001", done: 1, total: 4 };
  const runProgress = { kind: "run", jobId: "job-00000002", runId: "run-00000001", avatarId: "avatar-0001", done: 3, total: 20 };

  test("accepts progress with the avatarId of the job it reports on", () => {
    expect(JobProgress.safeParse(progress).success).toBe(true);
  });

  test("accepts a run's progress with its runId and avatarId", () => {
    expect(JobProgress.safeParse(runProgress).success).toBe(true);
  });

  test("rejects progress without an avatarId: the renderer must not have to guess it", () => {
    const { avatarId: _a, ...withoutAvatar } = progress;
    expect(JobProgress.safeParse(withoutAvatar).success).toBe(false);
  });

  test("rejects progress without a kind", () => {
    const { kind: _k, ...withoutKind } = progress;
    expect(JobProgress.safeParse(withoutKind).success).toBe(false);
  });

  test("rejects a run's progress without its runId", () => {
    const { runId: _r, ...withoutRun } = runProgress;
    expect(JobProgress.safeParse(withoutRun).success).toBe(false);
  });

  test("rejects a candidates job's progress that names a run", () => {
    expect(JobProgress.safeParse({ ...progress, runId: "run-00000001" }).success).toBe(false);
  });

  test("rejects done past total", () => {
    expect(JobProgress.safeParse({ ...progress, done: 5, total: 4 }).success).toBe(false);
    expect(JobProgress.safeParse({ ...runProgress, done: 21, total: 20 }).success).toBe(false);
  });
});

// The end of a job says whose it is too: a window that never saw its progress (the run failed before its first slot,
// or another window started it) must not have to guess the kind, the run or the avatar.
describe.each([
  ["JobFailed", JobFailed, { error: { code: "MASTER_FACE_UNUSABLE" } }],
  ["JobCancelled", JobCancelled, {}],
] as const)("%s", (_name, schema, extra) => {
  const candidates = { kind: "avatar.candidates", jobId: "job-00000001", avatarId: "avatar-0001", ...extra };
  const run = { kind: "run", jobId: "job-00000002", runId: "run-00000001", avatarId: "avatar-0001", ...extra };

  test("accepts a candidates job's end and a run's end", () => {
    expect(schema.safeParse(candidates).success).toBe(true);
    expect(schema.safeParse(run).success).toBe(true);
  });

  test("rejects an end without a kind, an avatarId, or (for a run) a runId", () => {
    const { kind: _k, ...noKind } = run;
    const { avatarId: _a, ...noAvatar } = run;
    const { runId: _r, ...noRun } = run;
    expect(schema.safeParse(noKind).success).toBe(false);
    expect(schema.safeParse(noAvatar).success).toBe(false);
    expect(schema.safeParse(noRun).success).toBe(false);
  });

  test("rejects a candidates job's end that names a run", () => {
    expect(schema.safeParse({ ...candidates, runId: "run-00000001" }).success).toBe(false);
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

  test("accepts a done photo run job with its result, both naming the run's avatar", () => {
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result: runResult }).success).toBe(true);
  });

  test("rejects a run result for another run", () => {
    const result = { ...runResult, runId: "run-00000009" };
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result }).success).toBe(false);
  });

  test("rejects a run result for another avatar", () => {
    const result = { ...runResult, avatarId: "avatar-0002" };
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result }).success).toBe(false);
  });

  test("rejects a run result without its avatarId", () => {
    const { avatarId: _a, ...withoutAvatar } = runResult;
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result: withoutAvatar }).success).toBe(false);
  });

  test("rejects a run result on a candidates job", () => {
    expect(JobState.safeParse({ ...candidatesJob, status: "done", done: 4, result: runResult }).success).toBe(false);
  });

  test("rejects a candidates job without its avatarId", () => {
    const { avatarId: _a, ...withoutAvatar } = candidatesJob;
    expect(JobState.safeParse(withoutAvatar).success).toBe(false);
  });

  test("rejects a run job without its runId", () => {
    const { runId: _r, ...withoutRun } = runJob;
    expect(JobState.safeParse(withoutRun).success).toBe(false);
  });

  test("rejects a run job without its avatarId: a snapshot must name the run's avatar, like a live job.progress does", () => {
    const { avatarId: _a, ...withoutAvatar } = runJob;
    expect(JobState.safeParse(withoutAvatar).success).toBe(false);
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

describe("a render job", () => {
  test("its progress names the video, the avatar and the montage, and counts frames", () => {
    const { status: _s, ...progressFields } = renderJob;
    expect(JobProgress.safeParse(progressFields).success).toBe(true);
  });

  test("a headless render has no montage: montageId is null, not missing", () => {
    const { status: _s, ...progressFields } = renderJob;
    expect(JobProgress.safeParse({ ...progressFields, montageId: null }).success).toBe(true);
    const { montageId: _m, ...withoutMontage } = progressFields;
    expect(JobProgress.safeParse(withoutMontage).success).toBe(false);
  });

  test("its progress rejects done past total", () => {
    const { status: _s, ...progressFields } = renderJob;
    expect(JobProgress.safeParse({ ...progressFields, done: 241 }).success).toBe(false);
  });

  test("its progress rejects a missing videoId or avatarId", () => {
    const { status: _s, ...progressFields } = renderJob;
    const { videoId: _v, ...noVideo } = progressFields;
    const { avatarId: _a, ...noAvatar } = progressFields;
    expect(JobProgress.safeParse(noVideo).success).toBe(false);
    expect(JobProgress.safeParse(noAvatar).success).toBe(false);
  });

  test("its progress rejects a runId: a render is not a photo run", () => {
    const { status: _s, ...progressFields } = renderJob;
    expect(JobProgress.safeParse({ ...progressFields, runId: "run-00000001" }).success).toBe(false);
  });

  test("its failure carries the same identity and the error", () => {
    const { status: _s, done: _d, total: _t, ...ref } = renderJob;
    expect(JobFailed.safeParse({ ...ref, error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } }).success).toBe(true);
    expect(JobFailed.safeParse({ ...ref, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } }).success).toBe(true);
  });

  test("its cancellation carries the same identity", () => {
    const { status: _s, done: _d, total: _t, ...ref } = renderJob;
    expect(JobCancelled.safeParse(ref).success).toBe(true);
    const { videoId: _v, ...noVideo } = ref;
    expect(JobCancelled.safeParse(noVideo).success).toBe(false);
  });

  test("JobState accepts it running", () => {
    expect(JobState.safeParse(renderJob).success).toBe(true);
  });

  test("JobState accepts it queued, before its first frame", () => {
    expect(JobState.safeParse({ ...renderJob, status: "queued", done: 0, total: 240 }).success).toBe(true);
  });

  test("JobState accepts it done with its result", () => {
    expect(JobState.safeParse({ ...renderJob, status: "done", done: 240, result: renderResult }).success).toBe(true);
  });

  test("JobState accepts it failed with its error", () => {
    expect(JobState.safeParse({ ...renderJob, status: "failed", error: { code: "RENDER_VERIFY_FAILED" } }).success).toBe(true);
  });

  test("JobState rejects a done render without a result", () => {
    expect(JobState.safeParse({ ...renderJob, status: "done", done: 240 }).success).toBe(false);
  });

  test("JobState rejects a result for another video", () => {
    const other = { ...renderResult, videoId: "video-00000002" };
    expect(JobState.safeParse({ ...renderJob, status: "done", done: 240, result: other }).success).toBe(false);
  });

  test("JobState rejects a result for another avatar", () => {
    const other = { ...renderResult, avatarId: "avatar-0002" };
    expect(JobState.safeParse({ ...renderJob, status: "done", done: 240, result: other }).success).toBe(false);
  });

  test("JobState rejects a render result on a run job", () => {
    expect(JobState.safeParse({ ...runJob, status: "done", done: 20, result: renderResult }).success).toBe(false);
  });

  test("JobState rejects a render job without its videoId", () => {
    const { videoId: _v, ...noVideo } = renderJob;
    expect(JobState.safeParse(noVideo).success).toBe(false);
  });

  test("JobState rejects done above total", () => {
    expect(JobState.safeParse({ ...renderJob, done: 241 }).success).toBe(false);
  });

  test("the render result names the video kind apart from the job kind", () => {
    const { videoKind: _k, ...noKind } = renderResult;
    expect(JobState.safeParse({ ...renderJob, status: "done", done: 240, result: noKind }).success).toBe(false);
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

describe("RunRequest", () => {
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

  // Owner decision 2026-09-29: 2K removed, the only size is 1K, so a request no longer names one.
  test.each(["1k", "2k"])("rejects a request that still names a resolution (%p)", (resolution) => {
    expect(RunRequest.safeParse({ ...run, resolution }).success).toBe(false);
  });

  // T5c/T6 (owner decision): profile and back poses only when the run allows them; front and three-quarter always.
  test.each([
    { profile: false, back: false },
    { profile: true, back: false },
    { profile: false, back: true },
    { profile: true, back: true },
  ])("accepts the poses a run allows: %p", (poses) => {
    expect(RunRequest.safeParse({ ...run, poses }).success).toBe(true);
  });

  test("requires the poses, each a yes or a no, and nothing else in them", () => {
    const { poses: _p, ...withoutPoses } = run;
    expect(RunRequest.safeParse(withoutPoses).success).toBe(false);
    expect(RunRequest.safeParse({ ...run, poses: { profile: true } }).success).toBe(false);
    expect(RunRequest.safeParse({ ...run, poses: { profile: "yes", back: false } }).success).toBe(false);
    expect(RunRequest.safeParse({ ...run, poses: { profile: false, back: false, front: true } }).success).toBe(false);
  });
});

describe("RunSummary (T6: a run as runs.list finds it on disk)", () => {
  test("accepts a stopped run with slots left, resumable, with its remaining worst case", () => {
    expect(RunSummary.safeParse(runSummary).success).toBe(true);
  });

  test("accepts a remaining worst case that could not be priced right now", () => {
    expect(RunSummary.safeParse({ ...runSummary, remainingWorstMicros: null }).success).toBe(true);
  });

  test("rejects slot counts that do not add up to the run's total", () => {
    expect(RunSummary.safeParse({ ...runSummary, open: 6 }).success).toBe(false);
  });

  test("rejects a run that is resumable while it runs, or with no slot left open", () => {
    expect(RunSummary.safeParse({ ...runSummary, running: true }).success).toBe(false);
    expect(RunSummary.safeParse({ ...runSummary, done: 19, open: 0 }).success).toBe(false);
  });

  test("rejects a stopped run with slots open that says neither that it is resumable nor that its cap is used up", () => {
    expect(RunSummary.safeParse({ ...runSummary, resumable: false, capExhausted: false }).success).toBe(false);
  });

  // A run whose cap cannot fund one more attempt has reached a real end: not resumable, and says why.
  test("accepts a stopped run with slots open whose cap is used up: not resumable, capExhausted", () => {
    expect(RunSummary.safeParse({ ...runSummary, resumable: false, capExhausted: true, remainingWorstMicros: 12_000 }).success).toBe(true);
  });

  test("rejects a run that is both resumable and cap-exhausted", () => {
    expect(RunSummary.safeParse({ ...runSummary, capExhausted: true }).success).toBe(false);
  });

  test("rejects a cap-exhausted run that is running or has no slot left open", () => {
    expect(RunSummary.safeParse({ ...runSummary, resumable: false, capExhausted: true, running: true }).success).toBe(false);
    expect(RunSummary.safeParse({ ...runSummary, resumable: false, capExhausted: true, done: 19, open: 0 }).success).toBe(false);
  });

  test("rejects a summary without the capExhausted flag", () => {
    const { capExhausted: _c, ...without } = runSummary;
    expect(RunSummary.safeParse(without).success).toBe(false);
  });

  test("accepts a committed amount above the cap: a bill above its worst case can put it there, and the list must still say so", () => {
    expect(RunSummary.safeParse({ ...runSummary, committedMicros: 3_385_001 }).success).toBe(true);
  });
});

describe("PhotoSummary (T8b: the Photos screen's gallery)", () => {
  test("accepts a photo with no qa at all: additive and optional", () => {
    expect(PhotoSummary.safeParse(photo).success).toBe(true);
  });

  test("accepts qa with just a face-similarity badge", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { faceCos: 0.81 } }).success).toBe(true);
  });

  test("accepts qa with just an age verdict", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { age: { adult: true, confidence: 0.95 } } }).success).toBe(true);
  });

  test("accepts qa with both fields", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { faceCos: 0.81, age: { adult: true, confidence: 0.95 } } }).success).toBe(true);
  });

  test("rejects a faceCos outside -1..1", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { faceCos: 1.5 } }).success).toBe(false);
    expect(PhotoSummary.safeParse({ ...photo, qa: { faceCos: -1.5 } }).success).toBe(false);
  });

  test("rejects an age confidence outside 0..1", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { age: { adult: true, confidence: 1.2 } } }).success).toBe(false);
  });

  test("rejects an unknown qa field", () => {
    expect(PhotoSummary.safeParse({ ...photo, qa: { pdq: "a".repeat(64) } }).success).toBe(false);
  });

  test("accepts a null runId, rejects an empty-string one", () => {
    expect(PhotoSummary.safeParse({ ...photo, runId: null }).success).toBe(true);
    expect(PhotoSummary.safeParse({ ...photo, runId: "" }).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    expect(PhotoSummary.safeParse({ ...photo, category: "lingerie" }).success).toBe(false);
  });

  test("carries no resolution: a summary that names one is rejected (2K removed, 2026-09-29)", () => {
    expect(PhotoSummary.safeParse({ ...photo, resolution: "1k" }).success).toBe(false);
  });
});

describe("PhotoSummary: usage and reject marks (Stage 3)", () => {
  test("a photo in one video is used and names it", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ["video-00000001"] }).success).toBe(true);
  });

  test("a photo in several videos names each", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ["video-00000001", "video-00000002"] }).success).toBe(true);
  });

  test("a rejected photo is unused or used: the mark is the owner's own", () => {
    expect(PhotoSummary.safeParse({ ...photo, rejected: true, eligible: false }).success).toBe(true);
    expect(PhotoSummary.safeParse({ ...photo, rejected: true, eligible: false, used: true, usedIn: ["video-00000001"] }).success).toBe(true);
  });

  test("rejects used without a video that used it", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: [] }).success).toBe(false);
  });

  test("rejects a video that used a photo marked unused", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: false, usedIn: ["video-00000001"] }).success).toBe(false);
  });

  test("rejects the same video listed twice", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ["video-00000001", "video-00000001"] }).success).toBe(false);
  });

  test("rejects a usedIn entry that breaks the id pattern", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ["../video"] }).success).toBe(false);
  });

  test("rejects a summary without used, usedIn or rejected", () => {
    const { used: _u, ...noUsed } = photo;
    const { usedIn: _i, ...noUsedIn } = photo;
    const { rejected: _r, ...noRejected } = photo;
    expect(PhotoSummary.safeParse(noUsed).success).toBe(false);
    expect(PhotoSummary.safeParse(noUsedIn).success).toBe(false);
    expect(PhotoSummary.safeParse(noRejected).success).toBe(false);
  });

  test("rejects a rejected flag that is not a boolean", () => {
    expect(PhotoSummary.safeParse({ ...photo, rejected: "yes" }).success).toBe(false);
  });
});

describe("PhotoSummary: reserved and eligible (Stage 3)", () => {
  test("carries the eligibility verdict and whether a queued render holds the photo", () => {
    expect(PhotoSummary.safeParse({ ...photo, eligible: true, reserved: true }).success).toBe(true);
    expect(PhotoSummary.safeParse({ ...photo, eligible: false, reserved: false }).success).toBe(true);
  });

  test("rejects a summary without reserved or eligible: the renderer never re-derives them", () => {
    const { reserved: _r, ...noReserved } = photo;
    const { eligible: _e, ...noEligible } = photo;
    expect(PhotoSummary.safeParse(noReserved).success).toBe(false);
    expect(PhotoSummary.safeParse(noEligible).success).toBe(false);
  });

  test("rejects a rejected photo that is eligible: a reject mark is part of the one rule", () => {
    expect(PhotoSummary.safeParse({ ...photo, rejected: true, eligible: true }).success).toBe(false);
    expect(PhotoSummary.safeParse({ ...photo, rejected: true, eligible: false }).success).toBe(true);
  });

  test("a used photo may be eligible: used is not part of the eligibility rule", () => {
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ["video-00000001"], eligible: true }).success).toBe(true);
  });

  test("usedIn is bounded high enough to never fail a parse for a real library", () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `video-${String(i).padStart(8, "0")}`);
    expect(PhotoSummary.safeParse({ ...photo, used: true, usedIn: ids }).success).toBe(true);
  });
});

describe("ExportStatus (the snapshot's view of the export folder)", () => {
  test("ok carries nothing else", () => {
    expect(ExportStatus.safeParse({ status: "ok" }).success).toBe(true);
    expect(ExportStatus.safeParse({ status: "ok", reason: "missing" }).success).toBe(false);
  });

  test.each(["missing", "not-a-directory", "not-writable", "not-enough-space"])("unavailable says why: %s", (reason) => {
    expect(ExportStatus.safeParse({ status: "unavailable", reason }).success).toBe(true);
  });

  test("unavailable without a reason, or with an unknown one, is refused", () => {
    expect(ExportStatus.safeParse({ status: "unavailable" }).success).toBe(false);
    expect(ExportStatus.safeParse({ status: "unavailable", reason: "on-fire" }).success).toBe(false);
  });

  test("an unknown status is refused", () => {
    expect(ExportStatus.safeParse({ status: "unknown" }).success).toBe(false);
  });
});

describe("Settings: the export folder is not a status", () => {
  test("the settings carry the path, and no availability field", () => {
    expect(Settings.safeParse({ ...settings, exportStatus: { status: "ok" } }).success).toBe(false);
  });
});
