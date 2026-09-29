import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ImageAgeCheck } from "../../shared/engine";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import { PriceBook } from "../money/prices";
import { setupMoney, type Money } from "../openrouter/testing/fakes";
import { plan } from "../scenes";
import { foldRun, type RunEvent } from "./journal";
import { buildRunPlan, FALLBACK_IMAGE_MODEL, runEstimate, type RunPlan } from "./plan";
import { remainingEstimate, remainingPlan, scopeCommitted } from "./remaining";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6 review M3: what a resume could still spend. The owner accepts it before
// a resume, as before a start: every open slot's remaining attempts and every
// unwritten writer chunk's remaining answers at today's prices, never more
// than the run's cap leaves after what the run already committed.

const RUN_ID = "run-00000001";
const AT = "2026-09-24T12:00:00.000Z";
const PRIMARY = "x-ai/grok-imagine-image-2.0";
const PRICED = { book: PriceBook.fallback(), asOf: "2026-09-24" };
/** Fallback prices: the primary (low 1K + ref) is the dearest attempt; Seedream 1K + ref; the writer at its ceiling; an age check at its ceiling. */
const IMAGE_WORST = 50_000;
const SEEDREAM_WORST = 48_000;
const WRITER_WORST = 37_500;
const AGE_WORST = 5_250;

function runPlan(count: number, imageAgeCheck: ImageAgeCheck = "off"): RunPlan {
  const request = { avatarId: "avatar-0001", count, categories: ["home" as const], poses: { profile: false, back: false } };
  const worst = runEstimate(PRICED, { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" }, request, imageAgeCheck).worstMicros;
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request,
    imageAgeCheck,
    models: { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" },
    capMicros: worst,
    plannedWorstMicros: worst,
    scenes: plan({ seed: 3, count, categories: ["home"] }),
  });
}

function reserve(attemptId: string, model = PRIMARY, worstMicros = IMAGE_WORST): ReserveLine {
  return { type: "reserve", attemptId, jobId: "job-00000001", scope: { runId: RUN_ID }, model, worstMicros, at: AT };
}

interface Record_ {
  events?: RunEvent[];
  reserves?: ReserveLine[];
  closes?: (SettleLine | ReleaseLine)[];
}

function estimateFor(run: RunPlan, record: Record_ = {}, committed = 0) {
  const reserves = new Map((record.reserves ?? []).map((r) => [r.attemptId, r]));
  const closes = new Map((record.closes ?? []).map((c) => [c.attemptId, c]));
  const ledger = { reserveOf: (id: string) => reserves.get(id), closeOf: (id: string) => closes.get(id) };
  const state = foldRun(run, { events: record.events ?? [], photos: [], ...ledger });
  return remainingEstimate(PRICED, run, state, committed, ledger);
}

function planFor(run: RunPlan, record: Record_ = {}, committed = 0) {
  const reserves = new Map((record.reserves ?? []).map((r) => [r.attemptId, r]));
  const closes = new Map((record.closes ?? []).map((c) => [c.attemptId, c]));
  const ledger = { reserveOf: (id: string) => reserves.get(id), closeOf: (id: string) => closes.get(id) };
  const state = foldRun(run, { events: record.events ?? [], photos: [], ...ledger });
  return remainingPlan(PRICED, run, state, committed, ledger);
}

const writerDone = (run: RunPlan): RunEvent[] =>
  run.writerChunks.map((c) => ({ type: "writer", chunk: c.chunk, sentences: c.slotIndexes.map((slotIndex) => ({ slotIndex, sentence: "She reads by the window." })), at: AT }));

const slotDone = (slotIndex: number): RunEvent => ({ type: "slot", slotIndex, status: "done", photoId: `photo-000${slotIndex}0`, at: AT });

// What a resume must still be able to reserve to send anything: the writer's
// ceiling for an unwritten chunk plus the cheapest next attempt of an open
// slot. A run whose cap room is below it can only be refused: it has ended.
describe("remainingPlan's minToProgressMicros", () => {
  test("a fresh run needs the writer's ceiling and one image attempt", () => {
    expect(planFor(runPlan(4)).minToProgressMicros).toBe(WRITER_WORST + IMAGE_WORST);
  });

  test("once the writer is done, one image attempt", () => {
    const run = runPlan(4);
    expect(planFor(run, { events: writerDone(run) }).minToProgressMicros).toBe(IMAGE_WORST);
  });

  test("with the image age check on, the attempt carries its age check", () => {
    const run = runPlan(4, "on");
    expect(planFor(run, { events: writerDone(run) }).minToProgressMicros).toBe(IMAGE_WORST + AGE_WORST);
  });

  test("a slot whose next attempt is the cheaper Seedream fallback lowers it to that", () => {
    const run = runPlan(1);
    const [a1] = run.slotAttempts[0]?.attemptIds ?? [];
    const plan = planFor(run, {
      events: [...writerDone(run), { type: "attempt", slotIndex: 1, attemptId: a1 ?? "", model: PRIMARY, outcome: "refused", at: AT }],
    });
    expect(plan.minToProgressMicros).toBe(SEEDREAM_WORST);
  });

  test("a run with nothing to send (its only open slot closes at once on a used fallback) needs nothing: null", () => {
    const run = runPlan(1);
    const [a1, a2] = run.slotAttempts[0]?.attemptIds ?? [];
    const plan = planFor(run, {
      events: [
        ...writerDone(run),
        { type: "attempt", slotIndex: 1, attemptId: a1 ?? "", model: PRIMARY, outcome: "refused", at: AT },
        { type: "attempt", slotIndex: 1, attemptId: a2 ?? "", model: FALLBACK_IMAGE_MODEL, outcome: "qa-retry", at: AT },
      ],
    });
    expect(plan.minToProgressMicros).toBeNull();
  });

  // After a crash a chunk can be out of writer attempts with its slots still open: the writer can never answer for
  // them, so the cap is not what stops them, and the run must not be called cap-exhausted. A resume closes them.
  test("a chunk with no writer attempts left and open slots needs nothing from the cap: null, not «cap exhausted»", () => {
    const run = runPlan(2);
    const ids = run.writerChunks[0]?.attemptIds ?? [];
    const settles = ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT }));
    const plan = planFor(run, { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: settles });
    expect(plan.minToProgressMicros).toBeNull();
  });

  // The resume only closes those slots: it costs nothing, so it must not ask the owner to accept the open slots' worst case.
  test("a blocked writer chunk makes the resume free: its estimate is 0 worst and 0 expected, whatever the cap leaves", () => {
    const run = runPlan(4);
    const ids = run.writerChunks[0]?.attemptIds ?? [];
    const settles = ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT }));
    const plan = planFor(run, { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: settles });
    expect(plan.estimate).toMatchObject({ worstMicros: 0, expectedMicros: 0 });
  });

  // The writer phase asks chunks in order and the first one that cannot be written ends it: a writable chunk BEFORE the
  // blocked one is still paid for, so the resume is not free, and no image is ever asked for after that end.
  describe("with two writer chunks (26 slots: 25 + 1)", () => {
    const settledChunk = (run: RunPlan, chunkIndex: number) => {
      const ids = run.writerChunks[chunkIndex]?.attemptIds ?? [];
      return { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT })) };
    };

    test("a writable first chunk before a blocked second one is priced at the first chunk's writer attempts, not at 0", () => {
      const run = runPlan(26);
      expect(run.writerChunks.length).toBe(2);
      const plan = planFor(run, settledChunk(run, 1));
      expect(plan.estimate.worstMicros).toBe(2 * WRITER_WORST);
      expect(plan.estimate.expectedMicros).toBeGreaterThan(0);
    });

    test("that resume needs the writer's ceiling to progress, and no image attempt (the phase ends at the blocked chunk)", () => {
      const run = runPlan(26);
      expect(planFor(run, settledChunk(run, 1)).minToProgressMicros).toBe(WRITER_WORST);
    });

    test("a blocked first chunk keeps the resume free even though a later chunk is writable (it is never asked)", () => {
      const run = runPlan(26);
      const plan = planFor(run, settledChunk(run, 0));
      expect(plan.estimate).toMatchObject({ worstMicros: 0, expectedMicros: 0 });
      expect(plan.minToProgressMicros).toBeNull();
    });
  });

  test("the estimate is the one remainingEstimate answers", () => {
    const run = runPlan(4);
    expect(planFor(run, {}, 60_000).estimate).toEqual(estimateFor(run, {}, 60_000));
  });
});

describe("remainingEstimate", () => {
  test("a run nothing happened to yet: its whole estimate, which is its cap", () => {
    const run = runPlan(4);
    const whole = runEstimate(PRICED, { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" }, run.request, "off");
    expect(estimateFor(run)).toEqual({ expectedMicros: whole.expectedMicros, worstMicros: run.capMicros, prices: "fallback", pricesAsOf: "2026-09-24" });
  });

  test("done slots and a written chunk cost nothing more; each open slot its remaining ids at the dearest model", () => {
    const run = runPlan(4);
    const [s3first] = run.slotAttempts[2]?.attemptIds ?? [];
    const estimate = estimateFor(run, {
      events: [...writerDone(run), slotDone(1), slotDone(2), { type: "attempt", slotIndex: 3, attemptId: s3first ?? "", model: PRIMARY, outcome: "qa-retry", at: AT }],
      reserves: [reserve(s3first ?? "")],
    });
    // Slot 3: two ids left; slot 4: three.
    expect(estimate.worstMicros).toBe(5 * IMAGE_WORST);
    expect(estimate.expectedMicros).toBe(2 * IMAGE_WORST);
  });

  test("a slot whose fallback is used up will close at once: nothing more; one bound for the fallback: one Seedream attempt", () => {
    const run = runPlan(2);
    const [a1, a2] = run.slotAttempts[0]?.attemptIds ?? [];
    const [b1] = run.slotAttempts[1]?.attemptIds ?? [];
    const estimate = estimateFor(run, {
      events: [
        ...writerDone(run),
        { type: "attempt", slotIndex: 1, attemptId: a1 ?? "", model: PRIMARY, outcome: "refused", at: AT },
        { type: "attempt", slotIndex: 1, attemptId: a2 ?? "", model: FALLBACK_IMAGE_MODEL, outcome: "qa-retry", at: AT },
        { type: "attempt", slotIndex: 2, attemptId: b1 ?? "", model: PRIMARY, outcome: "refused", at: AT },
      ],
    });
    expect(estimate.worstMicros).toBe(SEEDREAM_WORST);
    expect(estimate.expectedMicros).toBe(45_000 + 3_000);
  });

  test("an unwritten chunk costs its remaining answered attempts at the writer's ceiling, counting a paid one from the ledger", () => {
    const run = runPlan(1);
    const [w1] = run.writerChunks[0]?.attemptIds ?? [];
    const estimate = estimateFor(run, { reserves: [reserve(w1 ?? "", "x-ai/grok-4.3", WRITER_WORST)], closes: [{ type: "settle", attemptId: w1 ?? "", costMicros: 2_000, estimated: false, at: AT }] });
    expect(estimate.worstMicros).toBe(3 * IMAGE_WORST + WRITER_WORST);
  });

  test("an open slot may still pay for three attempts less the ones it paid: free failures (a zero settle, a release) cost it none", () => {
    const run = runPlan(1);
    const [a, b] = run.slotAttempts[0]?.attemptIds ?? [];
    // A final 429 (settled at zero) and an attempt released unsent: both journaled, neither a refusal.
    const free = estimateFor(run, {
      events: [
        ...writerDone(run),
        { type: "attempt", slotIndex: 1, attemptId: a ?? "", model: PRIMARY, outcome: "failed", error: { code: "RATE_LIMITED" }, at: AT },
        { type: "attempt", slotIndex: 1, attemptId: b ?? "", model: PRIMARY, outcome: "aborted", at: AT },
      ],
      reserves: [reserve(a ?? ""), reserve(b ?? "")],
      closes: [{ type: "settle", attemptId: a ?? "", costMicros: 0, estimated: false, at: AT }, { type: "release", attemptId: b ?? "", reason: "not sent", at: AT }],
    });
    expect(free.worstMicros).toBe(3 * IMAGE_WORST);

    const paidOnce = estimateFor(run, { events: writerDone(run), reserves: [reserve(a ?? "")], closes: [{ type: "settle", attemptId: a ?? "", costMicros: 40_000, estimated: false, at: AT }] });
    expect(paidOnce.worstMicros).toBe(2 * IMAGE_WORST);
  });

  test("...and never more attempts than it has unused ids", () => {
    const run = runPlan(1);
    const ids = run.slotAttempts[0]?.attemptIds ?? [];
    const four = ids.slice(0, 4);
    const estimate = estimateFor(run, {
      events: [...writerDone(run), ...four.map((id): RunEvent => ({ type: "attempt", slotIndex: 1, attemptId: id, model: PRIMARY, outcome: "failed", error: { code: "RATE_LIMITED" }, at: AT }))],
      reserves: four.map((id) => reserve(id)),
      closes: four.map((id) => ({ type: "settle" as const, attemptId: id, costMicros: 0, estimated: false, at: AT })),
    });
    expect(estimate.worstMicros).toBe(IMAGE_WORST);
  });

  test("with the image age check on, every remaining attempt carries its age check", () => {
    const run = runPlan(1, "on");
    expect(estimateFor(run, { events: writerDone(run) }).worstMicros).toBe(3 * (IMAGE_WORST + AGE_WORST));
  });

  test("never more than the cap leaves after what the run committed; the expected case never above the worst", () => {
    const run = runPlan(4);
    const estimate = estimateFor(run, {}, run.capMicros - 60_000);
    expect(estimate.worstMicros).toBe(60_000);
    expect(estimate.expectedMicros).toBeLessThanOrEqual(60_000);
  });

  test("a run that committed its whole cap, or more (a bill above its worst case), has nothing left to spend", () => {
    const run = runPlan(2);
    expect(estimateFor(run, {}, run.capMicros + 1)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });
});

describe("scopeCommitted", () => {
  let money: Money;
  beforeEach(async () => {
    money = await setupMoney();
  });
  afterEach(async () => {
    await money.cleanup();
  });

  test("is the scope's settled costs plus its open reserves at their worst case, and nothing of another scope", async () => {
    const lines = [
      reserve(`${RUN_ID}:slot-1#1`),
      { type: "settle", attemptId: `${RUN_ID}:slot-1#1`, costMicros: 40_000, estimated: false, at: AT },
      reserve(`${RUN_ID}:slot-2#1`),
      { ...reserve("other-run:slot-1#1"), scope: { runId: "run-00000002" } },
      { type: "settle", attemptId: "other-run:slot-1#1", costMicros: 40_000, estimated: false, at: AT },
    ] as const;
    for (const line of lines) await money.ledger.append(line);
    expect(scopeCommitted(money.ledger, { runId: RUN_ID })).toBe(40_000 + IMAGE_WORST);
  });
});
