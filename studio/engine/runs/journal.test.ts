import { describe, expect, test } from "bun:test";
import type { PhotoSidecar } from "../library";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import { plan } from "../scenes";
import { attemptPaid, foldRun, nextAttemptId, paidAttempts, RunEventSchema, type RunEvent } from "./journal";
import { buildRunPlan, FALLBACK_IMAGE_MODEL, type RunPlan } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6: a run's state is its plan (plan.json) folded with its journal
// (journal.jsonl), the ledger's reserves and the photos already committed —
// the three records a crash can leave out of step with one another. Resume
// reads this fold and nothing else.

const RUN_ID = "run-00000001";
const AT = "2026-09-24T12:00:00.000Z";
const PRIMARY = "x-ai/grok-imagine-image-2.0";

function runPlan(count = 3): RunPlan {
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request: { avatarId: "avatar-0001", count, categories: ["home"], resolution: "1k", poses: { profile: false, back: false } },
    imageAgeCheck: "off",
    models: { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" },
    capMicros: 1_000_000,
    plannedWorstMicros: 1_000_000,
    scenes: plan({ seed: 1, count, categories: ["home"] }),
  });
}

function idsOf(run: RunPlan, slotIndex: number): string[] {
  const found = run.slotAttempts.find((s) => s.slotIndex === slotIndex);
  if (found === undefined) throw new Error(`no slot ${slotIndex}`);
  return found.attemptIds;
}

function attempt(slotIndex: number, attemptId: string, outcome: Extract<RunEvent, { type: "attempt" }>["outcome"], extra: Partial<Extract<RunEvent, { type: "attempt" }>> = {}): RunEvent {
  return { type: "attempt", slotIndex, attemptId, model: PRIMARY, outcome, at: AT, ...extra };
}

function reserve(attemptId: string, model = PRIMARY): ReserveLine {
  return { type: "reserve", attemptId, jobId: "job-00000001", scope: { runId: RUN_ID }, model, worstMicros: 50_000, at: AT };
}

function photo(id: string, attemptId: string): PhotoSidecar {
  return {
    schemaVersion: 1,
    id,
    avatarId: "avatar-0001",
    file: `${id}.png`,
    mediaType: "image/png",
    width: 60,
    height: 80,
    bytes: 100,
    sha256: "a".repeat(64),
    source: { kind: "generated", model: PRIMARY, provider: "openrouter", jobId: "job-00000001", attemptId, promptSha: "b".repeat(64), prompt: "p", costMicros: 40_000 },
    qa: {},
    createdAt: AT,
  };
}

function settle(attemptId: string, costMicros: number, estimated = false): SettleLine {
  return { type: "settle", attemptId, costMicros, estimated, at: AT };
}

function release(attemptId: string): ReleaseLine {
  return { type: "release", attemptId, reason: "not sent", at: AT };
}

function fold(run: RunPlan, events: RunEvent[] = [], reserves: ReserveLine[] = [], photos: PhotoSidecar[] = [], closes: (SettleLine | ReleaseLine)[] = []) {
  const byId = new Map(reserves.map((r) => [r.attemptId, r]));
  const closed = new Map(closes.map((c) => [c.attemptId, c]));
  return foldRun(run, { events, reserveOf: (id) => byId.get(id), closeOf: (id) => closed.get(id), photos });
}

describe("RunEventSchema", () => {
  test("accepts every event kind the job writes", () => {
    const events: RunEvent[] = [
      { type: "job", jobId: "job-00000001", status: "started", at: AT },
      { type: "writer", chunk: 1, sentences: [{ slotIndex: 1, sentence: "She reads on the sofa." }], at: AT },
      { type: "prompts", prompts: [{ slotIndex: 1, prompt: "The same woman as in the reference photo, ..." }], at: AT },
      attempt(1, `${RUN_ID}:slot-1#1`, "passed", { photoId: "photo-0001" }),
      attempt(2, `${RUN_ID}:slot-2#1`, "dropped"),
      { type: "slot", slotIndex: 1, status: "done", photoId: "photo-0001", at: AT },
      { type: "job", jobId: "job-00000001", status: "failed", error: { code: "NETWORK" }, at: AT },
    ];
    for (const event of events) expect(RunEventSchema.safeParse(event).success).toBe(true);
  });

  test("refuses an unknown outcome, an unknown event, and a passed attempt without its photo", () => {
    expect(RunEventSchema.safeParse(attempt(1, `${RUN_ID}:slot-1#1`, "passed")).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...attempt(1, `${RUN_ID}:slot-1#1`, "failed"), outcome: "maybe" }).success).toBe(false);
    expect(RunEventSchema.safeParse({ type: "paused", at: AT }).success).toBe(false);
  });

  test("refuses a done slot without its photo and a failed slot without its error", () => {
    expect(RunEventSchema.safeParse({ type: "slot", slotIndex: 1, status: "done", at: AT }).success).toBe(false);
    expect(RunEventSchema.safeParse({ type: "slot", slotIndex: 1, status: "failed", at: AT }).success).toBe(false);
  });
});

describe("foldRun", () => {
  test("a run with an empty journal has no sentences or prompts yet, and every slot is open with nothing used", () => {
    const run = runPlan();
    const state = fold(run);
    expect(state.prompts).toBeNull();
    expect(state.sentences.size).toBe(0);
    expect(state.writerDone.size).toBe(0);
    expect(state.slots.map((s) => [s.slot.slotIndex, s.end, s.consumed.size, s.fallbackUsed, s.useFallbackNext])).toEqual([
      [1, null, 0, false, false],
      [2, null, 0, false, false],
      [3, null, 0, false, false],
    ]);
    expect(state.slots.map((s) => nextAttemptId(s))).toEqual([1, 2, 3].map((i) => `${RUN_ID}:slot-${i}#1`));
  });

  test("a writer chunk's sentences and the prompts are read back", () => {
    const run = runPlan(2);
    const state = fold(run, [
      { type: "writer", chunk: 1, sentences: [{ slotIndex: 1, sentence: "One." }, { slotIndex: 2, sentence: "Two." }], at: AT },
      { type: "prompts", prompts: [{ slotIndex: 1, prompt: "P1" }, { slotIndex: 2, prompt: "P2" }], at: AT },
    ]);
    expect([...state.writerDone]).toEqual([1]);
    expect(state.sentences).toEqual(new Map([[1, "One."], [2, "Two."]]));
    expect(state.prompts).toEqual(new Map([[1, "P1"], [2, "P2"]]));
  });

  test("an attempt in the journal is used: the slot moves on to its next pre-allocated id", () => {
    const run = runPlan();
    const [first, second] = idsOf(run, 2);
    const state = fold(run, [attempt(2, first ?? "", "qa-retry")]);
    const slot = state.slots[1];
    if (slot === undefined) throw new Error("slot 2");
    expect(slot.consumed).toEqual(new Set([first]));
    expect(nextAttemptId(slot)).toBe(second ?? "");
  });

  test("an id reserved in the ledger but missing from the journal (a crash between the two) is used, never sent again", () => {
    const run = runPlan();
    const [first, second, third] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "failed")], [reserve(first ?? ""), reserve(second ?? "")]);
    const slot = state.slots[0];
    if (slot === undefined) throw new Error("slot 1");
    expect(nextAttemptId(slot)).toBe(third ?? "");
  });

  test("a slot whose every id is used has no next attempt", () => {
    const run = runPlan(1);
    const ids = idsOf(run, 1);
    const state = fold(run, ids.map((id) => attempt(1, id, "qa-retry")));
    const slot = state.slots[0];
    if (slot === undefined) throw new Error("slot 1");
    expect(nextAttemptId(slot)).toBeNull();
  });

  test("a photo committed under one of the slot's ids makes it done even without its journal line (a crash right after the sidecar)", () => {
    const run = runPlan();
    const [, second] = idsOf(run, 3);
    const state = fold(run, [], [reserve(second ?? "")], [photo("photo-0003", second ?? ""), photo("photo-0999", "another-run:slot-3#2")]);
    expect(state.slots.map((s) => s.end)).toEqual([null, null, { status: "done", photoId: "photo-0003" }]);
  });

  test("a done or failed slot event ends the slot", () => {
    const run = runPlan();
    const state = fold(run, [
      { type: "slot", slotIndex: 1, status: "done", photoId: "photo-0001", at: AT },
      { type: "slot", slotIndex: 2, status: "failed", error: { code: "MODERATION_REFUSED" }, at: AT },
    ]);
    expect(state.slots.map((s) => s.end)).toEqual([
      { status: "done", photoId: "photo-0001" },
      { status: "failed", error: { code: "MODERATION_REFUSED" } },
      null,
    ]);
  });

  test("a refusal on the primary as the slot's last attempt sends the next one to the fallback", () => {
    const run = runPlan(1);
    const [first] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused")]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true });
  });

  test("an attempt on the fallback model uses it up, whether the journal or only the ledger saw it", () => {
    const run = runPlan(2);
    const [a1, a2] = idsOf(run, 1);
    const [b1, b2] = idsOf(run, 2);
    const state = fold(
      run,
      [attempt(1, a1 ?? "", "refused"), attempt(1, a2 ?? "", "qa-retry", { model: FALLBACK_IMAGE_MODEL }), attempt(2, b1 ?? "", "refused")],
      [reserve(b2 ?? "", FALLBACK_IMAGE_MODEL)],
    );
    expect(state.slots.map((s) => [s.fallbackUsed, s.useFallbackNext])).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  test("refuses a journal that names a slot or an attempt id the plan never allocated", () => {
    const run = runPlan(1);
    expect(() => fold(run, [attempt(9, `${RUN_ID}:slot-9#1`, "failed")])).toThrow();
    expect(() => fold(run, [attempt(1, `${RUN_ID}:slot-1#6`, "failed")])).toThrow();
  });
});

// Review L15: a crash between a refusal's settle and its journal line. The
// ledger still tells: a primary attempt closed by a settle of zero that is
// not an estimate got a final non-2xx — possibly the refusal — so the slot's
// next attempt must not send the same prompt to the primary again.
describe("foldRun: what the ledger alone says about a lost last attempt", () => {
  test("a primary attempt settled at zero with no journal line sends the next one to the fallback", () => {
    const run = runPlan(1);
    const [first] = idsOf(run, 1);
    const state = fold(run, [], [reserve(first ?? "")], [], [settle(first ?? "", 0)]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true });
  });

  test("a primary attempt that was paid, or never sent, or is still open, does not", () => {
    const run = runPlan(3);
    const [a] = idsOf(run, 1);
    const [b] = idsOf(run, 2);
    const [c] = idsOf(run, 3);
    const state = fold(run, [], [reserve(a ?? ""), reserve(b ?? ""), reserve(c ?? "")], [], [settle(a ?? "", 40_000), release(b ?? "")]);
    expect(state.slots.map((s) => s.useFallbackNext)).toEqual([false, false, false]);
  });

  test("only the slot's last attempt decides: an earlier lost zero settle followed by a journaled paid attempt does not", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, second ?? "", "qa-retry")], [reserve(first ?? ""), reserve(second ?? "")], [], [settle(first ?? "", 0), settle(second ?? "", 40_000)]);
    expect(state.slots[0]?.useFallbackNext).toBe(false);
  });

  test("an estimated settle (a reconcile closing a lost request at its worst case) is not a refusal", () => {
    const run = runPlan(1);
    const [first] = idsOf(run, 1);
    const state = fold(run, [], [reserve(first ?? "")], [], [settle(first ?? "", 0, true)]);
    expect(state.slots[0]?.useFallbackNext).toBe(false);
  });
});

// Review L2: why the one fallback attempt ended, so a slot closed on resume says so truthfully.
describe("foldRun: how the fallback ended", () => {
  test("the fallback's journaled outcome is kept", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused"), attempt(1, second ?? "", "aborted", { model: FALLBACK_IMAGE_MODEL })]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: true, fallbackEnd: "aborted" });
  });

  test("a fallback only the ledger saw ended in a way nobody recorded", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused")], [reserve(second ?? "", FALLBACK_IMAGE_MODEL)]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: true, fallbackEnd: "unknown" });
  });

  test("a fallback cut off by the network or a rate limit got no answer: it is not used up, and the next attempt goes to it again (review H1)", () => {
    const run = runPlan(2);
    const [a1, a2] = idsOf(run, 1);
    const [b1, b2] = idsOf(run, 2);
    const state = fold(run, [
      attempt(1, a1 ?? "", "refused"),
      attempt(1, a2 ?? "", "failed", { model: FALLBACK_IMAGE_MODEL, error: { code: "NETWORK" } }),
      attempt(2, b1 ?? "", "refused"),
      attempt(2, b2 ?? "", "failed", { model: FALLBACK_IMAGE_MODEL, error: { code: "INTERNAL" } }),
    ], [reserve(a2 ?? "", FALLBACK_IMAGE_MODEL), reserve(b2 ?? "", FALLBACK_IMAGE_MODEL)]);
    expect(state.slots.map((s) => [s.fallbackUsed, s.useFallbackNext, s.fallbackEnd])).toEqual([
      [false, true, null],
      [true, false, "failed"],
    ]);
  });

  test("a slot that never used its fallback has no fallback end", () => {
    const state = fold(runPlan(1));
    expect(state.slots[0]?.fallbackEnd).toBeNull();
  });
});

// Review H1/L10: which attempts count against a limit of paid (answered) attempts.
describe("attemptPaid", () => {
  const ID = `${RUN_ID}:writer-1#1`;
  const view = (reserves: ReserveLine[], closes: (SettleLine | ReleaseLine)[]) => {
    const r = new Map(reserves.map((l) => [l.attemptId, l]));
    const c = new Map(closes.map((l) => [l.attemptId, l]));
    return { reserveOf: (id: string) => r.get(id), closeOf: (id: string) => c.get(id) };
  };

  test("an attempt never reserved, or released unsent, is not paid", () => {
    expect(attemptPaid(view([], []), ID)).toBe(false);
    expect(attemptPaid(view([reserve(ID)], [release(ID)]), ID)).toBe(false);
  });

  test("a final non-2xx settled at zero (a 429, a 5xx, a refusal) is free, so not paid", () => {
    expect(attemptPaid(view([reserve(ID)], [settle(ID, 0)]), ID)).toBe(false);
  });

  test("an answer that was billed, an open reserve (it may have been billed), and an estimated settle all count as paid", () => {
    expect(attemptPaid(view([reserve(ID)], [settle(ID, 11_200)]), ID)).toBe(true);
    expect(attemptPaid(view([reserve(ID)], []), ID)).toBe(true);
    expect(attemptPaid(view([reserve(ID)], [settle(ID, 0, true)]), ID)).toBe(true);
  });
});

// Review round 3, N1: a fallback id that never reached Seedream — released
// unsent (beforeSend said no, or a cancel before it left), or stopped between
// transport retries (journaled aborted, settled at zero) — got no answer, so
// the one fallback attempt is still unused and the slot's next attempt goes
// to it. Only a SENT attempt can use it up or decide the route.
describe("foldRun: a fallback that never reached Seedream", () => {
  test("released unsent: not used up, the next attempt goes to the fallback", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(
      run,
      [attempt(1, first ?? "", "refused"), attempt(1, second ?? "", "aborted", { model: FALLBACK_IMAGE_MODEL })],
      [reserve(first ?? ""), reserve(second ?? "", FALLBACK_IMAGE_MODEL)],
      [],
      [settle(first ?? "", 0), release(second ?? "")],
    );
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true, fallbackEnd: null });
  });

  test("released unsent with no journal line: not used up either", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused")], [reserve(first ?? ""), reserve(second ?? "", FALLBACK_IMAGE_MODEL)], [], [settle(first ?? "", 0), release(second ?? "")]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true });
  });

  test("stopped between transport retries (journaled aborted, settled at zero): no answer, not used up", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(
      run,
      [attempt(1, first ?? "", "refused"), attempt(1, second ?? "", "aborted", { model: FALLBACK_IMAGE_MODEL })],
      [reserve(first ?? ""), reserve(second ?? "", FALLBACK_IMAGE_MODEL)],
      [],
      [settle(first ?? "", 0), settle(second ?? "", 0)],
    );
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true });
  });

  test("with no journal line and a zero settle it stays used: that may have been Seedream's own refusal", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused")], [reserve(first ?? ""), reserve(second ?? "", FALLBACK_IMAGE_MODEL)], [], [settle(first ?? "", 0), settle(second ?? "", 0)]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: true, useFallbackNext: false, fallbackEnd: "unknown" });
  });

  test("a cancel mid-flight (journaled aborted, reserve still open) used it up: it may have been billed", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused"), attempt(1, second ?? "", "aborted", { model: FALLBACK_IMAGE_MODEL })], [reserve(first ?? ""), reserve(second ?? "", FALLBACK_IMAGE_MODEL)], [], [settle(first ?? "", 0)]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: true, fallbackEnd: "aborted" });
  });

  test("a primary attempt released unsent after a refusal does not hide the refusal: the route follows the last sent attempt", () => {
    const run = runPlan(1);
    const [first, second] = idsOf(run, 1);
    const state = fold(run, [attempt(1, first ?? "", "refused"), attempt(1, second ?? "", "aborted")], [reserve(first ?? ""), reserve(second ?? "")], [], [settle(first ?? "", 0), release(second ?? "")]);
    expect(state.slots[0]).toMatchObject({ fallbackUsed: false, useFallbackNext: true });
  });
});

// Review round 3 (a): a slot has spare ids, like the writer's chunks. What it
// may never exceed is three PAID attempts: free ones (a final non-2xx settled
// at zero, a release) do not count; an open reserve or an estimated settle do.
describe("paidAttempts", () => {
  test("counts only the slot's attempts that were, or may have been, billed", () => {
    const run = runPlan(1);
    const ids = idsOf(run, 1);
    const [a, b, c, d] = ids;
    const reserves = [reserve(a ?? ""), reserve(b ?? ""), reserve(c ?? ""), reserve(d ?? "")];
    const closes = [settle(a ?? "", 0), release(b ?? ""), settle(c ?? "", 40_000)];
    const state = fold(run, [], reserves, [], closes);
    const byId = new Map(reserves.map((r) => [r.attemptId, r]));
    const closed = new Map(closes.map((l) => [l.attemptId, l]));
    const slot = state.slots[0];
    if (slot === undefined) throw new Error("slot 1");
    expect(paidAttempts(slot, { reserveOf: (id) => byId.get(id), closeOf: (id) => closed.get(id) })).toBe(2);
    expect(nextAttemptId(slot)).toBe(ids[4] ?? "");
  });
});
