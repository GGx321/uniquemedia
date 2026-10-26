import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WRITER_BOLD_CALL, writerAttemptWorstMicros, writerCallOf } from "../money/estimate";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import type { ChatParams } from "../openrouter/types";
import { plan } from "../scenes";
import { buildRunPlan, plannedSlots, runWriterConfig } from "./plan";
import { NetworkPool } from "./pools";
import { runWriterPhase, writerCallShape, type WriterCallShape, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 r2.4 §5.3.4 «The reserve», r2.1 N1): a writer phase's call shape carries the call's reasoning allowance, and the phase hands it
// to chat(), whose `chatAttemptWorstMicros` prices it as completion on top of `max_tokens` (never sent). So an attempt reserves exactly what the estimate
// priced it at (`writerAttemptWorstMicros`), in either mode. The ordinary shape has no allowance and stays byte-identical.

const RUN_ID = "run-00000001";
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

/** A good answer for the slots the request asked about (read from its own prompt). */
function good(call: FetchCall): Reply {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  const slots: { slotIndex: number }[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return { status: 200, body: chatBody(JSON.stringify({ scenes: slots.map((s) => ({ slotIndex: s.slotIndex, sentence: SENTENCE })) }), { cost: 0.002 }) };
}

function phaseOf(call: WriterCallShape): WriterPhase {
  const run = buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: "2026-09-24T12:00:00.000Z",
    request: { avatarId: "avatar-0001", count: 3, categories: ["home"] },
    imageAgeCheck: "off",
    models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
    capMicros: 10_000_000,
    plannedWorstMicros: 10_000_000,
    scenes: plan({ seed: 11, count: 3, categories: ["home"] }),
  });
  return {
    jobId: "job-00000001",
    scope: { runId: RUN_ID },
    textModel: "x-ai/grok-4.3",
    signal: new AbortController().signal,
    slots: plannedSlots(run),
    chunks: run.writerChunks,
    sentences: new Map(),
    writerDone: new Set(),
    ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
    ...runWriterConfig(run.categories),
    call,
  };
}

/** Runs one chunk under `call` and returns what chat() was handed, the request bodies sent and the reserves the ledger holds. */
async function oneChunk(call: WriterCallShape): Promise<{ params: ChatParams[]; bodies: Record<string, unknown>[]; reserves: number[] }> {
  const steps: Step[] = [good];
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const params: ChatParams[] = [];
  const pool = new NetworkPool({ max: 6 });
  const result = await runWriterPhase(
    {
      chat: (p) => {
        params.push(p);
        return client.chat(p);
      },
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      onChunk: async () => undefined,
    },
    phaseOf(call),
  );
  expect(result.ok).toBe(true);
  const reserves = money.lines().flatMap((l) => (l.type === "reserve" && typeof l.worstMicros === "number" ? [l.worstMicros] : []));
  return { params, bodies: net.calls.map((c) => c.json()), reserves };
}

describe("writerCallShape", () => {
  test("the ordinary call's shape is today's three fields, with no reasoning key", () => {
    expect<unknown>(writerCallShape("ordinary")).toStrictEqual({ maxTokens: 8_000, inputTokens: 14_000, maxAttempts: 2 });
  });

  test("the bold call's shape carries its 3 000 reasoning tokens", () => {
    expect<unknown>(writerCallShape("bold")).toStrictEqual({ maxTokens: 8_000, inputTokens: 17_000, reasoningTokens: 3_000, maxAttempts: 2 });
  });

  // 5a.4 (S5.BA4, the BA5a review's R2-L2): a shape is made from a MODE, through writerCallOf, so a bold call can never be shaped as the ordinary one by
  // handing over the wrong call object.
  test("a shape is made from a mode, never from a call object", () => {
    // @ts-expect-error writerCallShape takes a WriterMode, not a WriterCall
    expect(() => writerCallShape(WRITER_BOLD_CALL)).toThrow(RangeError);
    // @ts-expect-error nor a mode outside the two
    expect(() => writerCallShape("flirty")).toThrow(RangeError);
  });

  test("each mode's shape carries exactly the ceilings writerCallOf gives that mode", () => {
    for (const mode of ["ordinary", "bold"] as const) {
      const call = writerCallOf(mode);
      const shape = writerCallShape(mode);
      expect([shape.maxTokens, shape.inputTokens, shape.reasoningTokens, shape.maxAttempts]).toEqual([call.maxTokens, call.inputTokens, call.reasoningTokens, call.maxAttempts]);
    }
  });

  test("a run's writer config is the ordinary shape, byte for byte", () => {
    expect<unknown>(runWriterConfig(undefined).call).toStrictEqual({ maxTokens: 8_000, inputTokens: 14_000, maxAttempts: 2 });
  });

  // S5.BA5a round 2 (M2 b): a shape built by hand could leave the reasoning out and reserve 41 250 µ$ under a 48 750 estimate. Only writerCallShape
  // makes one; the brand is a type alone, so the shape it returns is the same plain object as before.
  test("a shape built by hand does not compile, with or without a reasoning allowance", () => {
    // @ts-expect-error a phase call shape is made by writerCallShape only
    const forged: WriterCallShape = { maxTokens: 8_000, inputTokens: 17_000, maxAttempts: 2 };
    // @ts-expect-error not even one that names its reasoning
    const named: WriterCallShape = { maxTokens: 8_000, inputTokens: 17_000, reasoningTokens: 3_000, maxAttempts: 2 };
    expect([forged.maxAttempts, named.maxAttempts]).toEqual([2, 2]);
  });

  test("the brand adds nothing at run time: the bold shape's own keys are its four fields", () => {
    expect(Reflect.ownKeys(writerCallShape("bold"))).toEqual(["maxTokens", "inputTokens", "reasoningTokens", "maxAttempts"]);
    expect(Reflect.ownKeys(writerCallShape("ordinary"))).toEqual(["maxTokens", "inputTokens", "maxAttempts"]);
  });
});

describe("the writer phase reserves what the estimate priced", () => {
  test("a bold-shaped attempt reserves writerAttemptWorstMicros(book, WRITER_BOLD_CALL): 48 750 µ$", async () => {
    const { reserves } = await oneChunk(writerCallShape("bold"));
    expect(reserves).toEqual([writerAttemptWorstMicros(money.priceBook, WRITER_BOLD_CALL)]);
    expect(reserves).toEqual([48_750]);
  });

  test("a bold-shaped phase hands chat() its reasoning allowance", async () => {
    const { params } = await oneChunk(writerCallShape("bold"));
    expect(params.map((p) => p.reasoningTokens)).toEqual([3_000]);
  });

  test("the reasoning allowance is priced, never sent: the request still says max_tokens 8 000", async () => {
    const { bodies } = await oneChunk(writerCallShape("bold"));
    expect(bodies.map((b) => b.max_tokens)).toEqual([8_000]);
    expect(JSON.stringify(bodies)).not.toContain("reasoningTokens");
  });

  test("an ordinary phase hands chat() no reasoning key and reserves today's 37 500 µ$", async () => {
    const { params, reserves } = await oneChunk(runWriterConfig(undefined).call);
    expect(params.map((p) => "reasoningTokens" in p)).toEqual([false]);
    expect(reserves).toEqual([37_500]);
  });
});
