import { describe, expect, test } from "bun:test";
import type { EngineError } from "../../shared/engine";
import { AGE_CHECK_CALL } from "../money/estimate";
import { MoneyError } from "../money/errors";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import { FALLBACK_IMAGE, PriceBook, type ImagePrice, type PriceEntry } from "../money/prices";
import { plan, type PlanSlot } from "../scenes";
import { foldRun, type RunEvent } from "./journal";
import { BOLD_IMAGE_MODEL, buildRunPlan, runEstimate, type RunPlan } from "./plan";
import { remainingPlan, remainingPlanOrNull } from "./remaining";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §8.2, §10.2): what a resume of a run with Seedream slots could still spend. A Seedream slot is priced `left × (bold + age)` at 2K, never as a
// fallback; a slot that ended (refused, empty) costs nothing; every other slot is priced as before.

const RUN_ID = "run-00000001";
const AT = "2026-10-12T12:00:00.000Z";
const GROK_QUALITY = "x-ai/grok-imagine-image-quality";
const PRICED = { book: PriceBook.fallback(), asOf: "2026-10-12" };
const GROK_ATTEMPT = 60_000;
const BOLD_ATTEMPT = 93_000;
const AGE_WORST = PRICED.book.chatWorstCase(AGE_CHECK_CALL);
const AGE_TYPICAL = PRICED.book.chatCost({ model: AGE_CHECK_CALL.model, images: AGE_CHECK_CALL.images, ...AGE_CHECK_CALL.typical });
const MODELS = { imageModel: GROK_QUALITY, imageQuality: null, textModel: "x-ai/grok-4.3" } as const;

/** `count` slots of «Ночнушки и бельё»; those at `routed` indexes are on the Seedream route. */
function runPlan(count: number, routed: readonly number[], age: "on" | "off" = "off", capMicros?: number): RunPlan {
  const slots: PlanSlot[] = plan({ seed: 5, count, categories: ["nightwear"] }).slots.map((slot, i) => (routed.includes(i) ? { ...slot, route: "seedream" as const } : slot));
  const request = { avatarId: "avatar-0001", count, categories: ["nightwear" as const] };
  const worst = runEstimate(PRICED, MODELS, request, age, () => true).worstMicros;
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request,
    imageAgeCheck: age,
    models: MODELS,
    capMicros: capMicros ?? worst,
    plannedWorstMicros: capMicros ?? worst,
    scenes: { version: 1, seed: 5, slots },
  });
}

const idsOf = (run: RunPlan, slotIndex: number): string[] => run.slotAttempts.find((s) => s.slotIndex === slotIndex)?.attemptIds ?? [];
const writerDone = (run: RunPlan): RunEvent[] =>
  run.writerChunks.map((c) => ({ type: "writer", chunk: c.chunk, sentences: c.slotIndexes.map((slotIndex) => ({ slotIndex, sentence: "She reads by the window." })), at: AT }));
function attempt(slotIndex: number, attemptId: string, outcome: Extract<RunEvent, { type: "attempt" }>["outcome"], model = BOLD_IMAGE_MODEL, error?: EngineError): RunEvent {
  return { type: "attempt", slotIndex, attemptId, model, outcome, ...(error === undefined ? {} : { error }), at: AT };
}
const reserve = (attemptId: string, model = BOLD_IMAGE_MODEL, worstMicros = BOLD_ATTEMPT): ReserveLine => ({ type: "reserve", attemptId, jobId: "job-00000001", scope: { runId: RUN_ID }, model, worstMicros, at: AT });
const settle = (attemptId: string, costMicros: number): SettleLine => ({ type: "settle", attemptId, costMicros, estimated: false, at: AT });

interface Record_ {
  events?: RunEvent[];
  reserves?: ReserveLine[];
  closes?: (SettleLine | ReleaseLine)[];
}
function remaining(run: RunPlan, record: Record_ = {}, priced = PRICED) {
  const reserves = new Map((record.reserves ?? []).map((r) => [r.attemptId, r]));
  const closes = new Map((record.closes ?? []).map((c) => [c.attemptId, c]));
  const ledger = { reserveOf: (id: string) => reserves.get(id), closeOf: (id: string) => closes.get(id) };
  const state = foldRun(run, { events: [...writerDone(run), ...(record.events ?? [])], photos: [], ...ledger });
  return remainingPlan(priced, run, state, 0, ledger);
}

const QA_MISS: EngineError = { code: "QA_REJECTED", detail: "the QA gate \"face\" asked for another attempt" };

describe("a fresh run with Seedream slots", () => {
  test("prices each open Seedream slot three 2K attempts and the others three Grok attempts", () => {
    const { estimate } = remaining(runPlan(4, [0, 1]));
    expect(estimate.worstMicros).toBe(2 * 3 * BOLD_ATTEMPT + 2 * 3 * GROK_ATTEMPT);
  });

  test("expects one attempt per slot at its own price", () => {
    const { estimate } = remaining(runPlan(4, [0, 1]));
    expect(estimate.expectedMicros).toBe(2 * BOLD_ATTEMPT + 2 * GROK_ATTEMPT);
  });

  test("never spends more than the estimate the run was planned on (the plan's need is below its estimate)", () => {
    const run = runPlan(6, [0, 2, 4]);
    expect(remaining(run).estimate.worstMicros).toBeLessThanOrEqual(run.plannedWorstMicros);
  });

  test("needs one 2K attempt to make progress when every slot is on the route", () => {
    expect(remaining(runPlan(3, [0, 1, 2])).minToProgressMicros).toBe(BOLD_ATTEMPT);
  });

  test("with the age check on, a bold attempt carries its age check", () => {
    const run = runPlan(2, [0, 1], "on");
    const { estimate, minToProgressMicros } = remaining(run);
    expect([estimate.worstMicros, estimate.expectedMicros, minToProgressMicros]).toEqual([2 * 3 * (BOLD_ATTEMPT + AGE_WORST), 2 * (BOLD_ATTEMPT + AGE_TYPICAL), BOLD_ATTEMPT + AGE_WORST]);
  });

  test("a plan with no Seedream slot is priced exactly as before", () => {
    expect(remaining(runPlan(3, [])).estimate.worstMicros).toBe(3 * 3 * GROK_ATTEMPT);
  });
});

describe("resume after a paid mismatch", () => {
  test("prices the slot at the two attempts it has left, 2 × (93 000 + age)", () => {
    const run = runPlan(1, [0], "on");
    const [a1] = idsOf(run, 1);
    const { estimate } = remaining(run, { events: [attempt(1, a1!, "qa-retry", BOLD_IMAGE_MODEL, QA_MISS)], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] });
    expect(estimate.worstMicros).toBe(2 * (BOLD_ATTEMPT + AGE_WORST));
  });

  test("does not price the slot as a used fallback (the slot is not closed on resume)", () => {
    const run = runPlan(1, [0]);
    const [a1] = idsOf(run, 1);
    const { minToProgressMicros } = remaining(run, { events: [attempt(1, a1!, "qa-retry", BOLD_IMAGE_MODEL, QA_MISS)], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] });
    expect(minToProgressMicros).toBe(BOLD_ATTEMPT);
  });
});

describe("resume after a free refusal", () => {
  const run = runPlan(2, [0]);
  const [a1] = idsOf(run, 1);
  const refused: Record_ = {
    events: [attempt(1, a1!, "refused", BOLD_IMAGE_MODEL, { code: "MODERATION_REFUSED", sceneReason: "model-refused" })],
    reserves: [reserve(a1!)],
    closes: [settle(a1!, 0)],
  };

  test("prices the refused slot at zero: only the other slot is left", () => {
    expect(remaining(run, refused).estimate.worstMicros).toBe(3 * GROK_ATTEMPT);
  });

  test("a run whose only open slot is refused has nothing to send", () => {
    const only = runPlan(1, [0]);
    const [b1] = idsOf(only, 1);
    const plan_ = remaining(only, { events: [attempt(1, b1!, "refused", BOLD_IMAGE_MODEL, { code: "MODERATION_REFUSED", sceneReason: "model-refused" })], reserves: [reserve(b1!)], closes: [settle(b1!, 0)] });
    expect([plan_.estimate.worstMicros, plan_.minToProgressMicros]).toEqual([0, null]);
  });
});

describe("resume after a 2xx without an image", () => {
  test("prices the slot at zero", () => {
    const run = runPlan(1, [0]);
    const [a1] = idsOf(run, 1);
    const plan_ = remaining(run, { events: [attempt(1, a1!, "failed", BOLD_IMAGE_MODEL, { code: "INTERNAL", sceneReason: "model-empty" })], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] });
    expect([plan_.estimate.worstMicros, plan_.minToProgressMicros]).toEqual([0, null]);
  });
});

describe("resume after an attempt that got no answer", () => {
  test("a 429 leaves the slot all three paid attempts, on the bold route", () => {
    const run = runPlan(1, [0]);
    const [a1] = idsOf(run, 1);
    const { estimate } = remaining(run, { events: [attempt(1, a1!, "failed", BOLD_IMAGE_MODEL, { code: "RATE_LIMITED" })], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(estimate.worstMicros).toBe(3 * BOLD_ATTEMPT);
  });

  test("an open reserve (a timeout) counts as a paid attempt: two are left", () => {
    const run = runPlan(1, [0]);
    const [a1] = idsOf(run, 1);
    const { estimate } = remaining(run, { events: [attempt(1, a1!, "failed", BOLD_IMAGE_MODEL, { code: "TIMEOUT" })], reserves: [reserve(a1!)] });
    expect(estimate.worstMicros).toBe(2 * BOLD_ATTEMPT);
  });
});

describe("the price of a bold attempt", () => {
  test("is never below the dearest model of the route", () => {
    const dear: ImagePrice = { outputs: [{ variant: "1k", micros: 120_000 }], inputImageMicros: 10_000 };
    const images: [string, PriceEntry<ImagePrice>][] = [...FALLBACK_IMAGE].map(([model, price]) => [model, { price: model === GROK_QUALITY ? dear : price, source: "fallback" as const }]);
    const book = new PriceBook(new Map(images), new Map());
    // The cap leaves room for the dearer figure: the resume's worst case is never more than the cap leaves, so it is raised above the default book's estimate.
    const run = runPlan(1, [0], "off", 10_000_000);
    const { estimate } = remaining(run, {}, { book, asOf: PRICED.asOf });
    expect(estimate.worstMicros).toBe(3 * 130_000);
  });

  test("a price list with no 2K line makes the resume's price unavailable for the bold scope", () => {
    const flat: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };
    const images: [string, PriceEntry<ImagePrice>][] = [...FALLBACK_IMAGE].map(([model, price]) => [model, { price: model === BOLD_IMAGE_MODEL ? flat : price, source: "live" as const }]);
    const book = new PriceBook(new Map(images), new Map());
    const run = runPlan(1, [0]);
    const thrown = (() => {
      try {
        remaining(run, {}, { book, asOf: PRICED.asOf });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(thrown instanceof MoneyError && [thrown.code, thrown.scope]).toEqual(["PRICE_UNAVAILABLE", "bold"]);
  });

  test("remainingPlanOrNull answers null for such a run instead of failing the list", () => {
    const flat: ImagePrice = { outputs: [{ variant: null, micros: 45_000 }], inputImageMicros: 3_000 };
    const images: [string, PriceEntry<ImagePrice>][] = [...FALLBACK_IMAGE].map(([model, price]) => [model, { price: model === BOLD_IMAGE_MODEL ? flat : price, source: "live" as const }]);
    const book = new PriceBook(new Map(images), new Map());
    const run = runPlan(1, [0]);
    const state = foldRun(run, { events: writerDone(run), photos: [], reserveOf: () => undefined, closeOf: () => undefined });
    expect(remainingPlanOrNull({ book, asOf: PRICED.asOf }, run, state, 0, { reserveOf: () => undefined, closeOf: () => undefined })).toBeNull();
  });
});
