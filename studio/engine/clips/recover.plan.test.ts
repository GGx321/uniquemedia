import { describe, expect, test } from "bun:test";
import { summarizeJournal } from "./journal";
import { planRecovery, type PlanInput, type RecoveryPlan } from "./recover";
import type { ClipJournalLine } from "./schemas";
import { REAL_CLIP_TIMINGS, SHORT_CLIP_TIMINGS } from "./timings";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, the recovery table; I5.48, I5.49): what a restart does with each clip it finds on disk. The plan is pure over the journal, the ledger's reserve
// lines of the clip and the clock, so each row of the table is one test here, and the rows that touch the 60 min mark are pinned one millisecond either side.

const MIN = 60_000;
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const CLIP = "clip-00000001";
const KLING = `${CLIP}:video#1`;
const GROK = `${CLIP}:video#2`;
const iso = (ms: number): string => new Date(ms).toISOString();

const requested: ClipJournalLine = {
  type: "requested",
  clipId: CLIP,
  photoId: "photo-00000001",
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
  acceptedWorstMicros: 850_000,
  at: iso(T0),
};
const submitted = (attemptId: string, atMs: number, model: "kling" | "grok" = "kling"): ClipJournalLine => ({ type: "submitted", attemptId, model, providerJobId: `job-${attemptId.slice(-1)}`, at: iso(atMs) });
const ended = (attemptId: string, atMs: number, status: Extract<ClipJournalLine, { type: "ended" }>["status"], costSource: Extract<ClipJournalLine, { type: "ended" }>["costSource"] = "proof"): ClipJournalLine => ({
  type: "ended",
  attemptId,
  status,
  costSource,
  at: iso(atMs),
});

function plan(lines: ClipJournalLine[], overrides: Partial<Omit<PlanInput, "summary">> = {}): RecoveryPlan {
  return planRecovery({ summary: summarizeJournal(lines), recordExists: false, reservedAttempts: new Set(), nowMs: T0 + 5 * MIN, timings: REAL_CLIP_TIMINGS, ...overrides });
}

describe("a journal with only `requested`", () => {
  test("is a clip that was lost, when the ledger holds no reserve of it", () => {
    expect(plan([requested])).toEqual({ kind: "fail", reason: "lost", model: "kling" });
  });

  test("is a clip that was lost, when the ledger holds a reserve of it with no `submitted` line (the POST may have left)", () => {
    expect(plan([requested], { reservedAttempts: new Set([KLING]) })).toEqual({ kind: "fail", reason: "lost", model: "kling" });
  });

  test("names Grok as the model that tried last when the reserve is Grok's", () => {
    const grokFirst: ClipJournalLine = { ...requested, request: { model: "grok", quality: "std", seconds: 5, fallback: "none" } } as ClipJournalLine;
    expect(plan([grokFirst], { reservedAttempts: new Set([`${CLIP}:video#1`]) })).toEqual({ kind: "fail", reason: "lost", model: "grok" });
  });
});

describe("a submitted attempt with no `ended` line", () => {
  test("is polled while it is less than 60 min old", () => {
    expect(plan([requested, submitted(KLING, T0 + 1_000)], { nowMs: T0 + 30 * MIN })).toEqual({ kind: "poll", attemptId: KLING, model: "kling", providerJobId: "job-1", submittedAtMs: T0 + 1_000 });
  });

  test("is still polled one millisecond before the 60 min mark", () => {
    const submittedAt = T0 + 1_000;
    expect(plan([requested, submitted(KLING, submittedAt)], { nowMs: submittedAt + 60 * MIN - 1 }).kind).toBe("poll");
  });

  test("is given up on, as `late`, at the 60 min mark, with no poll", () => {
    const submittedAt = T0 + 1_000;
    expect(plan([requested, submitted(KLING, submittedAt)], { nowMs: submittedAt + 60 * MIN })).toEqual({ kind: "fail", reason: "late", model: "kling" });
  });

  test("takes its 60 min from the timings, so the short set shortens it", () => {
    const submittedAt = T0 + 1_000;
    expect(plan([requested, submitted(KLING, submittedAt)], { nowMs: submittedAt + SHORT_CLIP_TIMINGS.lateGiveUpMs, timings: SHORT_CLIP_TIMINGS }).kind).toBe("fail");
    expect(plan([requested, submitted(KLING, submittedAt)], { nowMs: submittedAt + SHORT_CLIP_TIMINGS.lateGiveUpMs - 1, timings: SHORT_CLIP_TIMINGS }).kind).toBe("poll");
  });
});

describe("an attempt that ended `completed` in an earlier process, with no record", () => {
  test("is downloaded again within 60 min of the submit", () => {
    const lines = [requested, submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage")];
    expect(plan(lines, { nowMs: T0 + 10 * MIN })).toEqual({ kind: "download", attemptId: KLING, model: "kling", providerJobId: "job-1", submittedAtMs: T0 + 1_000 });
  });

  test("is `download-expired` once 60 min have passed since the submit", () => {
    const lines = [requested, submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage")];
    expect(plan(lines, { nowMs: T0 + 1_000 + 60 * MIN })).toEqual({ kind: "fail", reason: "download-expired", model: "kling" });
  });
});

describe("an attempt that ended `completed` and whose file the journal says was downloaded", () => {
  const downloaded: ClipJournalLine = { type: "downloaded", sha256: "a".repeat(64), bytes: 1234, at: iso(T0 + 100_000) };
  const lines = [requested, submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage"), downloaded];

  test("carries the hash and size to check the kept file against, within 60 min", () => {
    expect(plan(lines, { nowMs: T0 + 10 * MIN })).toEqual({ kind: "download", attemptId: KLING, model: "kling", providerJobId: "job-1", submittedAtMs: T0 + 1_000, local: { sha256: "a".repeat(64), bytes: 1234 } });
  });

  test("still asks for the kept file after 60 min, since it needs no network", () => {
    expect(plan(lines, { nowMs: T0 + 1_000 + 90 * MIN })).toMatchObject({ kind: "download", local: { sha256: "a".repeat(64), bytes: 1234 } });
  });
});

describe("an attempt that ended in a failure", () => {
  const lines = (status: Extract<ClipJournalLine, { type: "ended" }>["status"], costSource: Extract<ClipJournalLine, { type: "ended" }>["costSource"]): ClipJournalLine[] => [
    requested,
    submitted(KLING, T0 + 1_000),
    ended(KLING, T0 + 90_000, status, costSource),
  ];

  test.each([
    ["refused", "proof", "refused-free"],
    ["refused", "generation", "refused-paid"],
    ["refused", "worst", "refused-unknown"],
    ["failed", "proof", "provider-error"],
    ["failed", "worst", "provider-error"],
    ["cancelled", "none", "provider-error"],
    ["expired", "none", "provider-error"],
    ["late", "none", "late"],
    ["uncertain", "none", "submit-uncertain"],
  ] as const)("`%s` settled by `%s` is recorded as %s", (status, costSource, reason) => {
    expect(plan(lines(status, costSource))).toEqual({ kind: "fail", reason, model: "kling" });
  });
});

describe("a fallback clip", () => {
  const klingFree = [requested, submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "refused", "proof")];

  test("with Grok submitted and not ended is polled for Grok's file, by Grok's job", () => {
    expect(plan([...klingFree, submitted(GROK, T0 + 200_000, "grok")], { nowMs: T0 + 10 * MIN })).toEqual({ kind: "poll", attemptId: GROK, model: "grok", providerJobId: "job-2", submittedAtMs: T0 + 200_000 });
  });

  test("with Grok reserved in the ledger and no `submitted` line for it is lost, and Grok is the model that tried last", () => {
    expect(plan(klingFree, { reservedAttempts: new Set([KLING, GROK]) })).toEqual({ kind: "fail", reason: "lost", model: "grok" });
  });

  test("with Kling refused free and no Grok reserve at all is recorded as Kling's free refusal", () => {
    expect(plan(klingFree, { reservedAttempts: new Set([KLING]) })).toEqual({ kind: "fail", reason: "refused-free", model: "kling" });
  });
});

describe("a journal next to a record, and a journal that cannot be read", () => {
  test("is stale when a record stands, whatever the journal says", () => {
    expect(plan([requested, submitted(KLING, T0 + 1_000)], { recordExists: true })).toEqual({ kind: "stale-journal" });
  });

  test("has nothing to rebuild a record from without a `requested` line", () => {
    expect(plan([submitted(KLING, T0 + 1_000)])).toEqual({ kind: "unreadable-journal" });
    expect(plan([])).toEqual({ kind: "unreadable-journal" });
  });
});
