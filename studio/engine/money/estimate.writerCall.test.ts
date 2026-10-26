import { describe, expect, test } from "bun:test";
import {
  estimateRun,
  WRITER_BOLD_CALL,
  WRITER_CALL,
  writerAttemptWorstMicros,
  writerCallOf,
  writerChunksMicros,
  writerExpectedMicros,
  writerWorstMicros,
  type ImageChoice,
  type RunPlanInput,
  type WriterCall,
} from "./estimate";
import { PriceBook } from "./prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 r2.4 §5.3.4, I5.77, r2.1 N1, r2.2 P4): the scene writer is priced by mode. The ordinary call is today's WRITER_CALL, byte for
// byte; the bold call («Смелая» on a custom category) is WRITER_BOLD_CALL: 17 000 prompt tokens, `max_tokens` 8 000 and a reasoning allowance of 3 000
// tokens priced as completion on top of it (grok-4.3 bills its reasoning as completion, S5.WCX). ONE `writerAttemptWorstMicros` prices an attempt at
// `maxTokens + (reasoningTokens ?? 0)`, so no writer ceiling can drop the reasoning again.

const BOOK = PriceBook.fallback();
const GROK_LOW_1K: ImageChoice = { model: "x-ai/grok-imagine-image-2.0", quality: "low", refs: 1 };

/** A run with no age check and one attempt a slot, so the writer's term is the only chat money in it. */
function run(writer: WriterCall | null, photos = 20): RunPlanInput {
  return { photos, attemptsPerSlot: 1, route: [GROK_LOW_1K], writer, ageChecks: null };
}

describe("writerCallOf", () => {
  test("«ordinary» is WRITER_CALL itself", () => {
    expect(writerCallOf("ordinary")).toBe(WRITER_CALL);
  });

  test("«bold» is WRITER_BOLD_CALL itself", () => {
    expect(writerCallOf("bold")).toBe(WRITER_BOLD_CALL);
  });

  test("a mode outside the two throws instead of falling back to a shape", () => {
    // @ts-expect-error a mode outside the two does not compile; at run time (untyped data) it must not price as the ordinary call.
    expect(() => writerCallOf("flirty")).toThrow(RangeError);
  });
});

describe("WRITER_CALL stays today's shape (I5.77: the ordinary writer is byte-identical)", () => {
  test("its fields are today's, and it has no reasoning allowance", () => {
    expect(WRITER_CALL).toStrictEqual({
      model: "x-ai/grok-4.3",
      maxTokens: 8_000,
      inputTokens: 14_000,
      images: 0,
      typicalPerScene: { inputTokens: 106, outputTokens: 130 },
      slotsPerCall: 25,
      maxAttempts: 2,
    });
    expect("reasoningTokens" in WRITER_CALL).toBe(false);
  });
});

describe("WRITER_BOLD_CALL", () => {
  test("is 17 000 prompt tokens, 8 000 + 3 000 reasoning completion tokens and no image, on the writer's model", () => {
    expect(WRITER_BOLD_CALL).toMatchObject({ model: "x-ai/grok-4.3", maxTokens: 8_000, reasoningTokens: 3_000, inputTokens: 17_000, images: 0 });
  });

  test("keeps the ordinary chunk size and attempts, so no chunking moves", () => {
    expect({ slotsPerCall: WRITER_BOLD_CALL.slotsPerCall, maxAttempts: WRITER_BOLD_CALL.maxAttempts }).toEqual({ slotsPerCall: WRITER_CALL.slotsPerCall, maxAttempts: WRITER_CALL.maxAttempts });
  });
});

// S5.BA5a round 2 (M1): the bold writer's typical tokens, from the five bold calls measured on grok-4.3 with the real 3 764-byte system prompt
// (2026-10-26; .omc/stage5/harness/out/p-ba/rerun/result.json `writers` and .omc/stage5/harness/out/p-ba/chunk25/result.json). The first P-BA W1/W2
// carried a 24-byte placeholder instead of the prompt and are not used. The reasoning does not grow with the slots (1 935 and 1 460 tokens on 2 slots,
// 0 to 1 018 on 25), so a per-slot figure alone would either miss the 2-slot bills or price 25 slots past the call's 11 000 completion tokens: the
// expected figure is a per-call term (the system prompt, the schema and the reasoning) plus a per-scene term (a slot's JSON in, its sentence out).
const MEASURED = [
  { call: "W1 rerun, effort low", slots: 2, prompt: 1_258, completion: 2_060, reasoning: 1_935, billMicros: 6_589 },
  { call: "W2 rerun, effort low", slots: 2, prompt: 1_274, completion: 1_577, reasoning: 1_460, billMicros: 5_401 },
  { call: "chunk25, no reasoning field", slots: 25, prompt: 2_963, completion: 1_887, reasoning: 435, billMicros: 8_287 },
  { call: "chunk25, effort low", slots: 25, prompt: 2_963, completion: 2_463, reasoning: 1_018, billMicros: 6_771 },
  { call: "chunk25, effort none", slots: 25, prompt: 2_955, completion: 1_123, reasoning: 0, billMicros: 6_367 },
] as const;

describe("WRITER_BOLD_CALL's typical tokens come from the five real-prompt calls", () => {
  const perScene = WRITER_BOLD_CALL.typicalPerScene;
  const perCall = WRITER_BOLD_CALL.typicalPerCall ?? { inputTokens: 0, outputTokens: 0 };

  test("the input a scene adds is the steepest growth from a 2-slot to a 25-slot call, rounded up: 75", () => {
    const small = MEASURED.filter((m) => m.slots === 2);
    const full = MEASURED.filter((m) => m.slots === 25);
    const slopes = small.flatMap((s) => full.map((f) => (f.prompt - s.prompt) / (f.slots - s.slots)));
    expect(perScene.inputTokens).toBe(Math.ceil(Math.max(...slopes)));
    expect(perScene.inputTokens).toBe(75);
  });

  test("the output a scene adds is the largest visible answer a slot, its reasoning left out: 63", () => {
    expect(perScene.outputTokens).toBe(Math.ceil(Math.max(...MEASURED.map((m) => (m.completion - m.reasoning) / m.slots))));
    expect(perScene.outputTokens).toBe(63);
  });

  test("the per-call terms are the largest residual over the five calls: 1 124 in, 1 934 out", () => {
    expect(perCall.inputTokens).toBe(Math.max(...MEASURED.map((m) => m.prompt - m.slots * perScene.inputTokens)));
    expect(perCall.outputTokens).toBe(Math.max(...MEASURED.map((m) => m.completion - m.slots * perScene.outputTokens)));
    expect(perCall).toEqual({ inputTokens: 1_124, outputTokens: 1_934 });
  });

  for (const m of MEASURED) {
    test(`${m.call}: one call of ${m.slots} scenes is expected at or above its tokens, its list price and its bill`, () => {
      expect(perCall.inputTokens + m.slots * perScene.inputTokens).toBeGreaterThanOrEqual(m.prompt);
      expect(perCall.outputTokens + m.slots * perScene.outputTokens).toBeGreaterThanOrEqual(m.completion);
      const expected = writerExpectedMicros(BOOK, WRITER_BOLD_CALL, 1, m.slots);
      expect(expected).toBeGreaterThanOrEqual(BOOK.chatCost({ model: WRITER_BOLD_CALL.model, images: 0, inputTokens: m.prompt, outputTokens: m.completion }));
      expect(expected).toBeGreaterThanOrEqual(m.billMicros);
    });
  }

  test("a full bold chunk's expected tokens stay under its ceilings", () => {
    const full = WRITER_BOLD_CALL.slotsPerCall;
    expect(perCall.inputTokens + full * perScene.inputTokens).toBeLessThanOrEqual(WRITER_BOLD_CALL.inputTokens);
    expect(perCall.outputTokens + full * perScene.outputTokens).toBeLessThanOrEqual(WRITER_BOLD_CALL.maxTokens + (WRITER_BOLD_CALL.reasoningTokens ?? 0));
  });

  test("20 bold scenes, one request, expect 11 265 µ$ in a run's estimate: 2 624 in × $1.25/M + 3 194 out × $2.50/M", () => {
    expect(estimateRun(BOOK, run(WRITER_BOLD_CALL)).expectedMicros - estimateRun(BOOK, run(null)).expectedMicros).toBe(11_265);
  });
});

describe("writerExpectedMicros", () => {
  test("the ordinary call's expected figure is today's, its scenes at 106 in / 130 out, whatever the requests", () => {
    for (const scenes of [0, 1, 20, 25, 26, 100]) {
      for (const requests of [0, 1, 2, 4]) {
        const today = BOOK.chatCost({ model: WRITER_CALL.model, images: WRITER_CALL.images, inputTokens: 106 * scenes, outputTokens: 130 * scenes });
        expect(writerExpectedMicros(BOOK, WRITER_CALL, requests, scenes)).toBe(today);
      }
    }
  });

  test("the bold call adds its per-call term once a request: 6 240 µ$ (1 124 in, 1 934 out)", () => {
    expect(writerExpectedMicros(BOOK, WRITER_BOLD_CALL, 2, 20) - writerExpectedMicros(BOOK, WRITER_BOLD_CALL, 1, 20)).toBe(6_240);
  });

  test("no request and no scene expect nothing", () => {
    expect([writerExpectedMicros(BOOK, WRITER_CALL, 0, 0), writerExpectedMicros(BOOK, WRITER_BOLD_CALL, 0, 0)]).toEqual([0, 0]);
  });

  test("refuses a request or scene count that is not a non-negative whole number", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => writerExpectedMicros(BOOK, WRITER_BOLD_CALL, bad, 1)).toThrow(TypeError);
      expect(() => writerExpectedMicros(BOOK, WRITER_BOLD_CALL, 1, bad)).toThrow(TypeError);
    }
  });
});

describe("writerAttemptWorstMicros", () => {
  test("prices a bold attempt at 48 750 µ$: 17 000 × $1.25/M + (8 000 + 3 000) × $2.50/M", () => {
    expect(writerAttemptWorstMicros(BOOK, WRITER_BOLD_CALL)).toBe(48_750);
  });

  test("prices an ordinary attempt exactly as today's ceiling: 37 500 µ$", () => {
    expect(writerAttemptWorstMicros(BOOK, WRITER_CALL)).toBe(BOOK.chatWorstCase(WRITER_CALL));
    expect(writerAttemptWorstMicros(BOOK, WRITER_CALL)).toBe(37_500);
  });

  test("adds the reasoning allowance as completion tokens on top of max_tokens: 3 000 × $2.50/M = 7 500 µ$", () => {
    const { reasoningTokens: _r, ...withoutReasoning } = WRITER_BOLD_CALL;
    expect(writerAttemptWorstMicros(BOOK, WRITER_BOLD_CALL) - writerAttemptWorstMicros(BOOK, withoutReasoning)).toBe(7_500);
  });

  test("a reasoning allowance of 0 prices as none", () => {
    expect(writerAttemptWorstMicros(BOOK, { ...WRITER_BOLD_CALL, reasoningTokens: 0 })).toBe(BOOK.chatWorstCase(WRITER_BOLD_CALL));
  });

  test("one token more of reasoning costs one completion token more", () => {
    expect(writerAttemptWorstMicros(BOOK, { ...WRITER_BOLD_CALL, reasoningTokens: 3_001 }) - writerAttemptWorstMicros(BOOK, WRITER_BOLD_CALL)).toBe(3); // 2.5 µ$, rounded up
  });

  test("refuses a reasoning allowance that is not a non-negative whole number", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => writerAttemptWorstMicros(BOOK, { ...WRITER_BOLD_CALL, reasoningTokens: bad })).toThrow(TypeError);
    }
  });
});

describe("every writer ceiling of money/estimate.ts carries the reasoning", () => {
  test("a bold chunk is two attempts at worst: 97 500 µ$ («до $0.098»)", () => {
    expect(writerChunksMicros(BOOK, WRITER_BOLD_CALL, 1)).toBe(97_500);
  });

  test("26 bold scenes are two chunks, each priced with the reasoning: 195 000 µ$", () => {
    expect(writerWorstMicros(BOOK, WRITER_BOLD_CALL, 26)).toBe(4 * 48_750);
  });

  test("a run's worst case carries one bold chunk at 97 500 µ$", () => {
    expect(estimateRun(BOOK, run(WRITER_BOLD_CALL)).worstMicros - estimateRun(BOOK, run(null)).worstMicros).toBe(97_500);
  });

  test("a run's worst case keeps the ordinary chunk at today's 75 000 µ$", () => {
    expect(estimateRun(BOOK, run(WRITER_CALL)).worstMicros - estimateRun(BOOK, run(null)).worstMicros).toBe(75_000);
  });

  test("zero chunks price nothing in either mode", () => {
    expect([writerChunksMicros(BOOK, WRITER_CALL, 0), writerChunksMicros(BOOK, WRITER_BOLD_CALL, 0)]).toEqual([0, 0]);
  });
});
