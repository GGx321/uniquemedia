import { afterEach, beforeEach, expect, test } from "bun:test";
import { b64, chatBody, chatParams, fakeFetch, JPEG, JPEG_2, LOCAL_BASE, makeClient, PNG, readLedgerLines, setupMoney, type Money, type Step } from "./testing/fakes";
import type { ChatParams } from "./types";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

const AGE_SCHEMA = {
  name: "age_check",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["adult", "confidence", "reason"],
    properties: { adult: { type: "boolean" }, confidence: { type: "number" }, reason: { type: "string" } },
  },
};
const ANSWER = '{"adult":true,"confidence":85,"reason":"mature features"}';

async function run(steps: Step[], overrides: Partial<ChatParams> = {}) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch);
  const result = await harness.client.chat(chatParams(money, overrides));
  return { result, calls, ...harness };
}

function worst(overrides: { inputTokens?: number; images?: number } = {}): number {
  return money.priceBook.chatWorstCase({ model: "x-ai/grok-4.3", maxTokens: 1_000, inputTokens: overrides.inputTokens ?? 2_000, images: overrides.images ?? 0 });
}

// ---------- request ----------

test("posts messages, max_tokens, reasoning effort, usage accounting and a strict json_schema format", async () => {
  const { calls } = await run([{ status: 200, body: chatBody(ANSWER, { cost: 0.0014 }) }], {
    messages: [
      { role: "system", content: "You check ages." },
      { role: "user", content: "Is the person clearly an adult?" },
    ],
    jsonSchema: AGE_SCHEMA,
  });

  expect(calls[0]?.url).toBe(`${LOCAL_BASE}/chat/completions`);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.json()).toEqual({
    model: "x-ai/grok-4.3",
    messages: [
      { role: "system", content: "You check ages." },
      { role: "user", content: "Is the person clearly an adult?" },
    ],
    max_tokens: 1_000,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: "age_check", strict: true, schema: AGE_SCHEMA.schema } },
  });
});

test("sends no response_format without a schema", async () => {
  const { calls } = await run([{ status: 200, body: chatBody("fine", { cost: 0.001 }) }]);

  expect(calls[0]?.json()).not.toHaveProperty("response_format");
});

test("attaches images to the last user message as JPEG data URLs after its text", async () => {
  const { calls } = await run([{ status: 200, body: chatBody(ANSWER, { cost: 0.0014 }) }], {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Is the person clearly an adult?" },
    ],
    images: [JPEG, JPEG_2],
  });

  expect(calls[0]?.json().messages).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [
        { type: "text", text: "Is the person clearly an adult?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPEG)}` } },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(JPEG_2)}` } },
      ],
    },
  ]);
});

test("releases the reserve when an image is not a JPEG", async () => {
  const { result, calls } = await run([], { images: [PNG] });

  expect(calls).toHaveLength(0);
  expect(result).toMatchObject({ status: "error", kind: "NOT_SENT", ledger: { action: "released" } });
});

// ---------- money ----------

test("reserves the price book's chat worst case before sending", async () => {
  let onDisk: Record<string, unknown>[] = [];
  await run(
    [
      () => {
        onDisk = readLedgerLines(money.ledgerPath);
        return { status: 200, body: chatBody(ANSWER, { cost: 0.0014 }) };
      },
    ],
    { images: [JPEG] }
  );

  expect(onDisk).toEqual([expect.objectContaining({ type: "reserve", attemptId: "age-1#1", model: "x-ai/grok-4.3", worstMicros: worst({ images: 1 }) })]);
});

test("reserves at least one prompt token per byte of message text", async () => {
  const long = "é".repeat(3_000); // 6,000 UTF-8 bytes against a 100-token ceiling

  await run([{ status: 200, body: chatBody("ok", { cost: 0.001 }) }], { messages: [{ role: "user", content: long }], inputTokens: 100 });

  expect(Number(money.lines()[0]?.worstMicros)).toBeGreaterThanOrEqual(worst({ inputTokens: 6_000 }));
});

test("counts the json_schema toward the prompt-token floor", async () => {
  const schema = { ...AGE_SCHEMA.schema, description: "d".repeat(10_000) };

  await run([{ status: 200, body: chatBody(ANSWER, { cost: 0.001 }) }], { jsonSchema: { name: "age_check", schema }, inputTokens: 100 });

  expect(Number(money.lines()[0]?.worstMicros)).toBeGreaterThanOrEqual(worst({ inputTokens: 10_000 }));
});

test("allows at least 1,000 prompt tokens per image in the floor", async () => {
  await run([{ status: 200, body: chatBody(ANSWER, { cost: 0.001 }) }], { images: [JPEG, JPEG_2], inputTokens: 1 });

  expect(Number(money.lines()[0]?.worstMicros)).toBeGreaterThanOrEqual(worst({ inputTokens: 2_000, images: 2 }));
});

test("sends nothing when the budget refuses the reserve", async () => {
  await money.cleanup();
  money = await setupMoney({ monthlyBudgetMicros: 1 });

  const { result, calls } = await run([]);

  expect(calls).toHaveLength(0);
  expect(result).toMatchObject({ status: "blocked", refusal: { reason: "BUDGET_EXCEEDED" } });
});

// ---------- response ----------

test("returns the content and settles the 2xx at its usage.cost", async () => {
  const { result } = await run([{ status: 200, body: chatBody(ANSWER, { cost: 0.0014 }) }]);

  expect(result).toMatchObject({ status: "ok", content: ANSWER, finishReason: "stop", costMicros: 1_400, estimated: false, httpTries: 1, aboveWorst: false });
  expect(money.lines()[1]).toMatchObject({ type: "settle", costMicros: 1_400, estimated: false });
});

test("settles a 2xx without usage.cost at the worst case, marked estimated", async () => {
  const { result } = await run([{ status: 200, body: chatBody(ANSWER) }]);

  expect(result).toMatchObject({ status: "ok", costMicros: worst(), estimated: true });
});

test("needs only the message content: missing role, finish_reason and unknown fields are fine", async () => {
  const body = { choices: [{ message: { content: ANSWER, refusal: null, reasoning_details: [{ type: "reasoning.encrypted" }] } }], usage: { cost: 0.001, prompt_tokens: null }, provider: "xAI" };

  const { result } = await run([{ status: 200, body }]);

  expect(result).toMatchObject({ status: "ok", content: ANSWER, finishReason: null });
});

test.each([null, ""])("reports a paid answer with %p content as EMPTY_CONTENT, settled at its cost, not fatal", async (content) => {
  const { result, raws } = await run([{ status: 200, body: chatBody(content, { cost: 0.003, finishReason: "length" }) }]);

  expect(result).toMatchObject({ status: "error", kind: "EMPTY_CONTENT", fatal: false, httpStatus: 200, ledger: { action: "settled", costMicros: 3_000, estimated: false } });
  expect(result.status === "error" && result.message).toContain("length");
  expect(raws).toEqual([]);
});

test.each([
  { name: "a body that is not JSON", body: "upstream error" },
  { name: "a body without choices", body: { usage: { cost: 0.002 } } },
  { name: "an empty choices array", body: { choices: [] } },
  { name: "a choice without a message", body: { choices: [{ finish_reason: "stop" }] } },
])("saves the raw body and returns a fatal UNUSABLE_PAID_RESPONSE for $name", async ({ body }) => {
  const { result, raws } = await run([{ status: 200, body }]);

  expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: true });
  expect(raws.map((r) => r.attemptId)).toEqual(["age-1#1"]);
  expect(money.lines()[1]).toMatchObject({ type: "settle" });
});

test("uses the same transport retries as images", async () => {
  const { result, calls } = await run([{ status: 429, headers: { "Retry-After": "1" } }, { status: 200, body: chatBody(ANSWER, { cost: 0.001 }) }]);

  expect(calls).toHaveLength(2);
  expect(result).toMatchObject({ status: "ok", httpTries: 2 });
});
