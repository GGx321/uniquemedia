import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { SUGGEST_ATTEMPT, TRANSLATE_ATTEMPT } from "../money/motionEstimate";
import { chatAttemptWorstMicros } from "../openrouter/chat";
import { chatParams, fakeFetch, JPEG, makeClient, setupMoney, type Money } from "../openrouter/testing/fakes";
import type { ChatParams } from "../openrouter/types";
import { PROBE_USAGES as RECORDED, PX_USAGES, type ProbeUsage } from "./testing/probeUsages";
useNativeGlobals();

// Stage 5, 5b.2, S5.WCX (the reasoning overrun): every part C attempt the paid probes P-M and P-R recorded, replayed through the real chat client and budget at the part C ceilings. On grok-4.3
// the reasoning is billed as completion beyond `max_tokens`, so each attempt reserves a reasoning allowance of 3 000 tokens on top (`reasoningTokens`). The replay sends the SMALLEST message an
// attempt of its kind can send (its prompt ceiling then sets the reserve): a real message only reserves more, so a bill that fits here fits every real attempt.

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

/** Every recorded attempt: P-M's and P-R's, and (round 2) P-X's under the WCX texts. */
const PROBE_USAGES: readonly ProbeUsage[] = [...RECORDED, ...PX_USAGES];

const ceilingsOf = (usage: ProbeUsage) => (usage.call === "suggest" ? SUGGEST_ATTEMPT : TRANSLATE_ATTEMPT);

function paramsOf(usage: ProbeUsage, n: number, reasoningTokens: number): Partial<ChatParams> {
  const call = ceilingsOf(usage);
  return {
    attemptId: `replay-${n}#1`,
    jobId: `replay-${n}`,
    messages: [{ role: "user", content: "{}" }],
    maxTokens: call.maxTokens,
    inputTokens: call.inputTokens,
    reasoningTokens,
    images: usage.call === "suggest" ? [JPEG] : [],
  };
}

function bodyOf(usage: ProbeUsage): object {
  return {
    id: "gen-1",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, completion_tokens_details: { reasoning_tokens: usage.reasoningTokens }, cost: usage.costMicros / 1e6 },
  };
}

describe("the part C attempts carry the reasoning allowance", () => {
  test("3 000 reasoning tokens on the vision writer's and the translator's attempt", () => {
    expect(SUGGEST_ATTEMPT.reasoningTokens).toBe(3_000);
    expect(TRANSLATE_ATTEMPT.reasoningTokens).toBe(3_000);
  });
});

describe("replaying P-M and P-R", () => {
  test("the record holds every attempt: 9 vision and 10 translations of P-M, 29 translations of P-R, 10 translations and 3 vision of P-X", () => {
    expect(PROBE_USAGES.filter((u) => u.probe === "P-M" && u.call === "suggest")).toHaveLength(9);
    expect(PROBE_USAGES.filter((u) => u.probe === "P-M" && u.call === "translate")).toHaveLength(10);
    expect(PROBE_USAGES.filter((u) => u.probe === "P-R")).toHaveLength(29);
    expect(PROBE_USAGES.filter((u) => u.probe === "P-X" && u.call === "translate")).toHaveLength(10);
    expect(PROBE_USAGES.filter((u) => u.probe === "P-X" && u.call === "suggest")).toHaveLength(3);
  });

  test("all 61 bills settle under the reserve of their attempt: zero overruns, and the ledger never halts", async () => {
    const above: number[] = [];
    for (const [n, usage] of PROBE_USAGES.entries()) {
      const net = fakeFetch([{ status: 200, body: bodyOf(usage) }]);
      const { client } = makeClient(net.fetch);
      const result = await client.chat(chatParams(money, paramsOf(usage, n, ceilingsOf(usage).reasoningTokens)));
      expect(result.status).toBe("ok");
      if (result.status === "ok" && result.aboveWorst) above.push(n);
    }
    expect(above).toEqual([]);
    expect(money.budget.aboveWorstAttempts()).toEqual([]);
    expect(money.lines().filter((line) => line.type === "settle")).toHaveLength(PROBE_USAGES.length);
  });

  test("the control: without the allowance the same smallest reserves sit below 15 of these bills, the two of P-M's ledger among them", () => {
    const below = PROBE_USAGES.filter((usage, n) => {
      const params = chatParams(money, paramsOf(usage, n, 0));
      return usage.costMicros > chatAttemptWorstMicros(money.priceBook, { ...params, images: params.images?.length ?? 0 });
    });
    expect(below).toHaveLength(15);
    expect(below.map((u) => u.costMicros)).toEqual(expect.arrayContaining([3_449, 4_111]));
    expect(below.every((u) => u.call === "translate")).toBe(true);
  });

  test("the margin: every bill on an effort the engine sends («low», «none») uses less than half of its attempt's smallest reserve", () => {
    const sent = PROBE_USAGES.filter((usage) => usage.reasoning === "low" || usage.reasoning === "none");
    expect(sent).toHaveLength(9 + 10 + 13 + 6 + 13);
    for (const usage of sent) {
      const params = chatParams(money, paramsOf(usage, 0, ceilingsOf(usage).reasoningTokens));
      const reserve = chatAttemptWorstMicros(money.priceBook, { ...params, images: params.images?.length ?? 0 });
      expect(usage.costMicros * 2).toBeLessThan(reserve);
    }
  });
});
