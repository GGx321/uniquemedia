import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CategoryRef, ImageAgeCheck } from "../../shared/engine";
import type { CoversOf } from "../../shared/scenes/writerBound";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import { MoneyError } from "../money/errors";
import { PriceBook, type ImageWorstCaseRequest } from "../money/prices";
import { setupMoney, type Money } from "../openrouter/testing/fakes";
import { planWithPools, POOLS } from "../scenes";
import { LLM_ONLY_POOL, LLM_ONLY_REF, llmOnlySnapshot } from "../scenes/testing/llmOnlyFixture";
import { foldRun, type RunEvent } from "./journal";
import { buildRunPlan, FALLBACK_IMAGE_MODEL, runEstimate, sceneCategory, type RunPlan } from "./plan";
import { remainingEstimate, remainingPlan, remainingPlanOrNull, scopeCommitted } from "./remaining";
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

// 5a.2 (S5.6c2, m11): a built-in run is written by the code template and asks the writer for nothing, so the writer-money tests below plan from
// `cat-llm-only-fixture`, whose activities the template cannot write (every slot goes to the model). `HOME` plans are the template's side.
const HOME: readonly CategoryRef[] = ["home"];
const FIXTURE: readonly CategoryRef[] = [LLM_ONLY_REF];
const NOTHING_COVERED: CoversOf = () => false;

function runPlan(count: number, imageAgeCheck: ImageAgeCheck = "off", categories: readonly CategoryRef[] = FIXTURE): RunPlan {
  const request = { avatarId: "avatar-0001", count, categories: [...categories], poses: { profile: false, back: false } };
  const worst = runEstimate(PRICED, { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" }, request, imageAgeCheck, NOTHING_COVERED).worstMicros;
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request,
    imageAgeCheck,
    models: { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" },
    capMicros: worst,
    plannedWorstMicros: worst,
    categories: categories.includes(LLM_ONLY_REF) ? [llmOnlySnapshot()] : undefined,
    scenes: planWithPools({ seed: 3, count, categories: categories.map(sceneCategory) }, { ...POOLS, [LLM_ONLY_REF]: LLM_ONLY_POOL }),
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

  // 5a.2 (S5.6c2, plan s5a2 §5.6 and I5.30 «a blocked chunk does not block»): a chunk out of writer attempts no longer ends the resume. The plain code sentence
  // (S5.6d) takes its slots, so their image worst stays counted and the writer is priced for the chunks that can still be asked. These three tests said the
  // opposite (a blocked chunk made the resume free, 0 worst, null minToProgress); the plan changes that rule, so they change with it.
  test("a chunk with no writer attempts left does not hold the cap back: the resume needs one image attempt, and no writer ceiling", () => {
    const run = runPlan(2);
    const ids = run.writerChunks[0]?.attemptIds ?? [];
    const settles = ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT }));
    const plan = planFor(run, { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: settles });
    expect(plan.minToProgressMicros).toBe(IMAGE_WORST);
  });

  test("a chunk with no writer attempts left no longer sets the writer blocked: its slots' image worst stays counted, the writer adds nothing", () => {
    const run = runPlan(4);
    const ids = run.writerChunks[0]?.attemptIds ?? [];
    const settles = ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT }));
    const plan = planFor(run, { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: settles });
    expect(plan.estimate.worstMicros).toBe(4 * 3 * IMAGE_WORST);
    expect(plan.estimate.expectedMicros).toBe(4 * IMAGE_WORST);
  });

  describe("with two writer chunks (26 slots: 25 + 1)", () => {
    const settledChunk = (run: RunPlan, chunkIndex: number) => {
      const ids = run.writerChunks[chunkIndex]?.attemptIds ?? [];
      return { reserves: ids.map((id) => reserve(id, "x-ai/grok-4.3", WRITER_WORST)), closes: ids.map((id): SettleLine => ({ type: "settle", attemptId: id, costMicros: 1_000, estimated: false, at: AT })) };
    };

    test("a writable first chunk before an out-of-attempts second one is priced at the first chunk's writer attempts plus every open slot's images", () => {
      const run = runPlan(26);
      expect(run.writerChunks.length).toBe(2);
      const plan = planFor(run, settledChunk(run, 1));
      expect(plan.estimate.worstMicros).toBe(2 * WRITER_WORST + 26 * 3 * IMAGE_WORST);
      expect(plan.estimate.expectedMicros).toBeGreaterThan(26 * IMAGE_WORST);
    });

    test("that resume needs the writer's ceiling and one image attempt to progress", () => {
      const run = runPlan(26);
      expect(planFor(run, settledChunk(run, 1)).minToProgressMicros).toBe(WRITER_WORST + IMAGE_WORST);
    });

    test("an out-of-attempts first chunk does not stop the later writable chunk from being priced", () => {
      const run = runPlan(26);
      const plan = planFor(run, settledChunk(run, 0));
      expect(plan.estimate.worstMicros).toBe(2 * WRITER_WORST + 26 * 3 * IMAGE_WORST);
      expect(plan.minToProgressMicros).toBe(WRITER_WORST + IMAGE_WORST);
    });
  });

  // The template side: a chunk whose every slot the code template writes is journaled with no request, so it is never priced as a writer call.
  describe("a built-in run, written by the template", () => {
    test("a fresh run needs one image attempt and no writer ceiling", () => {
      expect(planFor(runPlan(4, "off", HOME)).minToProgressMicros).toBe(IMAGE_WORST);
    });

    test("a fresh run's worst case is its images alone, which is its cap", () => {
      const run = runPlan(4, "off", HOME);
      expect(planFor(run).estimate.worstMicros).toBe(4 * 3 * IMAGE_WORST);
      expect(run.capMicros).toBe(4 * 3 * IMAGE_WORST);
    });

    test("its expected cost holds no writer term", () => {
      expect(planFor(runPlan(4, "off", HOME)).estimate.expectedMicros).toBe(4 * IMAGE_WORST);
    });

    test("a mixed run prices the writer only for the chunks that hold a slot the template cannot write", () => {
      // 52 photos over Home + the fixture: Home 26, fixture 26 → chunk 1 is all Home, chunk 2 mixes (1 Home + 24 fixture), chunk 3 is fixture.
      const run = runPlan(52, "off", ["home", LLM_ONLY_REF]);
      const withModel = run.writerChunks.length;
      expect(withModel).toBe(3);
      const plan = planFor(run);
      expect(plan.estimate.worstMicros).toBe(52 * 3 * IMAGE_WORST + 2 * 2 * WRITER_WORST);
      expect(plan.minToProgressMicros).toBe(WRITER_WORST + IMAGE_WORST);
    });

    test("a chunk of the template's slots that is already journaled adds nothing, and a model chunk still does", () => {
      const run = runPlan(52, "off", ["home", LLM_ONLY_REF]);
      const first = run.writerChunks[0];
      expect(first).toBeDefined();
      const events: RunEvent[] = [{ type: "writer", chunk: 1, sentences: (first?.slotIndexes ?? []).map((slotIndex) => ({ slotIndex, sentence: "She reads by the window." })), at: AT }];
      expect(planFor(run, { events }).estimate.worstMicros).toBe(52 * 3 * IMAGE_WORST + 2 * 2 * WRITER_WORST);
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
    const whole = runEstimate(PRICED, { imageModel: PRIMARY, textModel: "x-ai/grok-4.3" }, { count: run.scenes.slots.length, categories: [...FIXTURE] }, "off", NOTHING_COVERED);
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

// ---------- remainingPlanOrNull: only an unpriceable run is unknown; a defect is not swallowed ----------

class EmptyBook extends PriceBook {
  constructor() {
    super(new Map(), new Map());
  }
}

class DefectiveBook extends PriceBook {
  constructor() {
    super(new Map(), new Map());
  }
  override imageWorstCase(_req: ImageWorstCaseRequest): number {
    throw new RangeError("a defect that is not a missing price");
  }
}

function stateOf(run: RunPlan) {
  const ledger = { reserveOf: () => undefined, closeOf: () => undefined };
  return { ledger, state: foldRun(run, { events: [], photos: [], ...ledger }) };
}

describe("remainingPlanOrNull", () => {
  test("is the plan itself when the run can be priced", () => {
    const run = runPlan(2);
    const { ledger, state } = stateOf(run);

    expect(remainingPlanOrNull(PRICED, run, state, 0, ledger)).toEqual(remainingPlan(PRICED, run, state, 0, ledger));
  });

  test("is null when the book has no price for the run's models (PRICE_UNAVAILABLE), so runs.list can still show the other runs", () => {
    const run = runPlan(2);
    const { ledger, state } = stateOf(run);

    expect(remainingPlanOrNull({ book: new EmptyBook(), asOf: "2026-09-24" }, run, state, 0, ledger)).toBeNull();
  });

  test("lets an error that is not PRICE_UNAVAILABLE propagate: a RangeError is a defect, not an unknown price", () => {
    const run = runPlan(2);
    const { ledger, state } = stateOf(run);

    expect(() => remainingPlanOrNull({ book: new DefectiveBook(), asOf: "2026-09-24" }, run, state, 0, ledger)).toThrow(RangeError);
  });

  test("lets a money error with another code propagate too", () => {
    class LedgerBook extends PriceBook {
      constructor() {
        super(new Map(), new Map());
      }
      override imageWorstCase(_req: ImageWorstCaseRequest): number {
        throw new MoneyError("LEDGER_CORRUPT", "not a price problem");
      }
    }
    const run = runPlan(2);
    const { ledger, state } = stateOf(run);

    expect(() => remainingPlanOrNull({ book: new LedgerBook(), asOf: "2026-09-24" }, run, state, 0, ledger)).toThrow(MoneyError);
  });
});
