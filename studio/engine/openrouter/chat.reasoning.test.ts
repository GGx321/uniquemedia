import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chatAttemptWorstMicros, type ChatPriceShape } from "./chat";
import { chatParams, fakeFetch, makeClient, setupMoney, type Money } from "./testing/fakes";
import type { ChatParams } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WCX (the reasoning overrun, .omc/stage5/harness/out/reasoning-overrun.md): on grok-4.3's route `max_tokens` bounds the VISIBLE answer only; the reasoning tokens come on top
// and are billed as completion tokens, so an attempt priced at `max_tokens` × completion could bill above its reserve and stop the ledger. A caller now declares a reasoning allowance
// (`reasoningTokens`, default 0): it is PRICED as completion tokens on top of `max_tokens` and never sent. The halt on a bill above the reserve stays exactly as it was.

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

const MODEL = "x-ai/grok-4.3";
const SHAPE: ChatPriceShape = { model: MODEL, messages: [{ role: "user", content: "{}" }], maxTokens: 500, inputTokens: 1_000, images: 0 };

/** A 2xx chat body with the usage of a reasoning model: `completion` counts the reasoning, `cost` is the provider's bill in dollars. */
function reasoningBody(cost: number, usage: { prompt: number; completion: number; reasoning: number }): object {
  return {
    id: "gen-1",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"text_en":"she slowly turns her head"}' } }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, completion_tokens_details: { reasoning_tokens: usage.reasoning }, cost },
  };
}

async function send(overrides: Partial<ChatParams>, body: object) {
  const net = fakeFetch([{ status: 200, body }]);
  const { client } = makeClient(net.fetch);
  const result = await client.chat(chatParams(money, overrides));
  return { result, net };
}

describe("chatAttemptWorstMicros: the reasoning allowance", () => {
  test("prices the allowance as completion tokens on top of max_tokens", () => {
    expect(chatAttemptWorstMicros(money.priceBook, { ...SHAPE, reasoningTokens: 3_000 })).toBe(money.priceBook.chatWorstCase({ model: MODEL, maxTokens: 3_500, inputTokens: 1_000, images: 0 }));
  });

  test("an allowance of 3 000 adds exactly 3 000 completion tokens: 7 500 µ$ at grok-4.3's $2.50/M", () => {
    expect(chatAttemptWorstMicros(money.priceBook, { ...SHAPE, reasoningTokens: 3_000 }) - chatAttemptWorstMicros(money.priceBook, SHAPE)).toBe(7_500);
  });

  test("no allowance, or an allowance of 0, is today's figure exactly", () => {
    const today = money.priceBook.chatWorstCase({ model: MODEL, maxTokens: 500, inputTokens: 1_000, images: 0 });
    expect(chatAttemptWorstMicros(money.priceBook, SHAPE)).toBe(today);
    expect(chatAttemptWorstMicros(money.priceBook, { ...SHAPE, reasoningTokens: 0 })).toBe(today);
  });

  test("a negative, fractional or non-finite allowance is refused (TypeError), never priced", () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chatAttemptWorstMicros(money.priceBook, { ...SHAPE, reasoningTokens: bad })).toThrow(TypeError);
    }
  });
});

describe("chat: the allowance is reserved, never sent", () => {
  test("the reserve on disk carries the allowance", async () => {
    await send({ reasoningTokens: 3_000 }, reasoningBody(0.001, { prompt: 100, completion: 20, reasoning: 0 }));
    const params = chatParams(money, { reasoningTokens: 3_000 });
    expect(money.lines()[0]).toMatchObject({ type: "reserve", worstMicros: chatAttemptWorstMicros(money.priceBook, { ...params, images: 0 }) });
    expect(Number(money.lines()[0]?.worstMicros)).toBe(money.priceBook.chatWorstCase({ model: MODEL, maxTokens: 4_000, inputTokens: 2_000, images: 0 }));
  });

  test("the request still says max_tokens = maxTokens and reasoning holds the effort alone (never reasoning.max_tokens, which raised reasoning in P-R)", async () => {
    const { net } = await send({ reasoningTokens: 3_000 }, reasoningBody(0.001, { prompt: 100, completion: 20, reasoning: 0 }));
    const body = net.calls[0]?.json() as Record<string, unknown>;
    expect(body.max_tokens).toBe(1_000);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(JSON.stringify(body)).not.toContain("reasoningTokens");
  });
});

describe("chat: the reasoning effort", () => {
  test("«none» is sent as it is (grok-4.3 then reasons 0 tokens, P-R), with the effort as the only reasoning field", async () => {
    const { net } = await send({ reasoningEffort: "none" }, reasoningBody(0.0006, { prompt: 534, completion: 16, reasoning: 0 }));
    expect((net.calls[0]?.json() as Record<string, unknown>).reasoning).toEqual({ effort: "none" });
  });
});

describe("chat: a bill against a reserve with the allowance (the halt stays)", () => {
  const PARAMS = { maxTokens: 500, inputTokens: 1_000, reasoningTokens: 3_000 } as const;
  /** (500 + 3 000) × 2.5 µ$ + 1 000 × 1.25 µ$ (the short message stays under the prompt ceiling): the reserve a translate-shaped attempt holds. */
  const reserveOf = (): number => {
    expect(chatAttemptWorstMicros(money.priceBook, { ...chatParams(money, PARAMS), images: 0 })).toBe(10_000);
    return 10_000;
  };

  test("a bill exactly at the reserve settles without aboveWorst; nothing halts", async () => {
    const reserve = reserveOf();
    const { result } = await send(PARAMS, reasoningBody(reserve / 1e6, { prompt: 534, completion: 3_400, reasoning: 3_385 }));
    expect(result).toMatchObject({ status: "ok", costMicros: reserve, aboveWorst: false });
    expect(money.budget.aboveWorstAttempts()).toEqual([]);
  });

  test("a bill 1 µ$ above the reserve still halts the ledger (SETTLE_ABOVE_WORST), with the answer handed back", async () => {
    const reserve = reserveOf();
    const { result } = await send(PARAMS, reasoningBody((reserve + 1) / 1e6, { prompt: 534, completion: 3_401, reasoning: 3_386 }));
    expect(result).toMatchObject({ status: "ok", costMicros: reserve + 1, aboveWorst: true });
    expect(money.budget.aboveWorstAttempts()).toEqual(["age-1#1"]);
  });
});
