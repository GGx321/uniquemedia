import { describe, expect, test } from "bun:test";
import {
  estimateRun,
  WRITER_BOLD_CALL,
  WRITER_CALL,
  writerAttemptWorstMicros,
  writerCallOf,
  writerChunksMicros,
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

// P-BA (2026-10-26, .omc/stage5/harness/out/p-ba/result.json `writers`): two bold writer calls of 2 slots each on grok-4.3, effort «low», max_tokens 8 000.
// Their usage, as billed: W1 415 prompt / 791 completion (659 of them reasoning), W2 431 / 600 (479 reasoning). The probe's system message was the
// 24-byte placeholder «<writer-bold.system.txt>», not the 3 764-byte bold draft, so the prompt figures lack the system prompt; it is added at S5.WCX's
// measured 3.85 bytes a grok-4.3 token (money/motionEstimate.ts), shared by the 25 slots of a full chunk as WRITER_CALL's own typical was measured.
describe("WRITER_BOLD_CALL's typical tokens come from P-BA's W1/W2, reasoning included", () => {
  const W1 = { prompt: 415, completion: 791, reasoning: 659 };
  const W2 = { prompt: 431, completion: 600, reasoning: 479 };
  const SLOTS = 2;
  const UNSENT_SYSTEM_PROMPT_TOKENS = Math.ceil(3_764 / 3.85); // 978

  test("input per scene: the larger call's prompt per slot (216) plus the unsent system prompt shared by a full chunk (40): 256", () => {
    const perSlot = Math.ceil(Math.max(W1.prompt, W2.prompt) / SLOTS);
    const systemShare = Math.ceil(UNSENT_SYSTEM_PROMPT_TOKENS / WRITER_BOLD_CALL.slotsPerCall);
    expect([perSlot, systemShare]).toEqual([216, 40]);
    expect(WRITER_BOLD_CALL.typicalPerScene.inputTokens).toBe(perSlot + systemShare);
  });

  test("output per scene: the larger call's completion per slot, its reasoning included: 396", () => {
    expect(W1.completion - W1.reasoning).toBe(132); // the visible answer of two sentences; the rest is reasoning, billed as completion
    expect(WRITER_BOLD_CALL.typicalPerScene.outputTokens).toBe(Math.ceil(Math.max(W1.completion, W2.completion) / SLOTS));
  });

  test("a full bold chunk's typical tokens stay under its ceilings", () => {
    const full = WRITER_BOLD_CALL.slotsPerCall;
    expect(full * WRITER_BOLD_CALL.typicalPerScene.inputTokens).toBeLessThanOrEqual(WRITER_BOLD_CALL.inputTokens);
    expect(full * WRITER_BOLD_CALL.typicalPerScene.outputTokens).toBeLessThanOrEqual(WRITER_BOLD_CALL.maxTokens + (WRITER_BOLD_CALL.reasoningTokens ?? 0));
  });

  test("20 bold scenes expect 26 200 µ$ in a run's estimate: 5 120 in × $1.25/M + 7 920 out × $2.50/M", () => {
    expect(estimateRun(BOOK, run(WRITER_BOLD_CALL)).expectedMicros - estimateRun(BOOK, run(null)).expectedMicros).toBe(26_200);
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
