import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AvatarTraits } from "../../shared/engine";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { descriptorCall } from "./descriptor";
import { runDescriptorJob, type DescriptorJob } from "./descriptorJob";

const TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "coffee, travel, books",
};
const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";
const SCOPE: Scope = { avatarJobId: "job-00000001" };
const JOB: DescriptorJob = { jobId: "job-00000001", scope: SCOPE, traits: TRAITS, textModel: "x-ai/grok-4.3" };
/** One descriptor attempt at its ceilings on grok-4.3 (fallback prices): 3K out × $2.50/M + 5K in × $1.25/M. */
const ATTEMPT_WORST = 13_750;

function reply(descriptor: string, cost = 0.0021): Step {
  return { status: 200, body: chatBody(JSON.stringify({ descriptor }), { cost }) };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Step[], job: DescriptorJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runDescriptorJob({ chat: client.chat, budget: money.budget, priceBook: money.priceBook }, job);
  return { net, result };
}

test("a valid first answer is the descriptor: one reserve at the attempt's worst case, settled at usage.cost", async () => {
  const { result } = run([reply(GOOD)]);

  expect(await result).toEqual({ ok: true, descriptor: { age: 25, text: GOOD } });
  expect(withoutAt(money.lines())).toEqual([
    { type: "reserve", attemptId: "job-00000001:descriptor#1", jobId: "job-00000001", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST },
    { type: "settle", attemptId: "job-00000001:descriptor#1", costMicros: 2_100, estimated: false },
  ]);
});

test("the request: the settings' text model, reasoning low, the strict JSON schema and the descriptor prompt", async () => {
  const { net, result } = run([reply(GOOD)], { ...JOB, textModel: "x-ai/grok-4.3" });
  await result;

  const body = net.calls[0]?.json();
  expect(body).toMatchObject({
    model: "x-ai/grok-4.3",
    max_tokens: descriptorCall("x-ai/grok-4.3").maxTokens,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: "avatar_descriptor", strict: true } },
  });
  expect(JSON.stringify(body)).toContain("25-year-old European woman, ");
});

test("a rejected answer is asked once more under a new attempt id, with the reasons; both attempts are paid and settled", async () => {
  const { net, result } = run([reply("25-year-old European girl, hazel eyes.", 0.002), reply(GOOD, 0.0022)]);

  expect(await result).toEqual({ ok: true, descriptor: { age: 25, text: GOOD } });
  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain("rejected");
  expect(second).toContain("call her a woman");
  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId, l.costMicros ?? l.worstMicros])).toEqual([
    ["reserve", "job-00000001:descriptor#1", ATTEMPT_WORST],
    ["settle", "job-00000001:descriptor#1", 2_000],
    ["reserve", "job-00000001:descriptor#2", ATTEMPT_WORST],
    ["settle", "job-00000001:descriptor#2", 2_200],
  ]);
});

test("an answer rejected twice fails the job with the reasons; the money of both attempts is settled", async () => {
  const { net, result } = run([reply("European woman, hazel eyes."), reply("25-year-old woman who looks 19.")]);

  const outcome = await result;

  expect(net.calls).toHaveLength(2);
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("other-age");
  expect(money.lines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([2_100, 2_100]);
  expect(money.ledger.openReserves()).toEqual([]);
});

test("a paid answer without content gets the second attempt", async () => {
  const { net, result } = run([{ status: 200, body: chatBody(null, { cost: 0.001, finishReason: "length" }) }, reply(GOOD)]);

  expect(await result).toMatchObject({ ok: true });
  expect(JSON.stringify(net.calls[1]?.json())).toContain("it was empty");
});

test("a moderation refusal is free and final: MODERATION_REFUSED, no second attempt", async () => {
  const { net, result } = run([{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "MODERATION_REFUSED" } });
  expect(net.calls).toHaveLength(1);
  expect(money.lines().at(-1)).toMatchObject({ type: "settle", costMicros: 0 });
});

test("a 401 is final: AUTH_INVALID, never retried", async () => {
  const { net, result } = run([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
  expect(net.calls).toHaveLength(1);
});

test("a request that got no response leaves the reserve open at its worst case and fails the job with NETWORK", async () => {
  const { net, result } = run([{ reject: new TypeError("fetch failed") }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "NETWORK" } });
  expect(net.calls).toHaveLength(1);
  expect(money.ledger.openReserves().map((r) => r.worstMicros)).toEqual([ATTEMPT_WORST]);
});

test("a reserve the job's cap refuses sends nothing: RUN_CAP_EXCEEDED", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: ATTEMPT_WORST - 1 });
  const { net, result } = run([]);

  expect(await result).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  expect(net.calls).toHaveLength(0);
  expect(money.lines()).toEqual([]);
});

test("the second attempt that the cap cannot hold is not sent: the first answer's refusal and the cap both show", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: 2 * ATTEMPT_WORST - 1 });
  const { net, result } = run([{ status: 200, body: chatBody(JSON.stringify({ descriptor: "girl" })) }]);

  const outcome = await result;

  expect(net.calls).toHaveLength(1);
  expect(outcome).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("youth-word");
});

test("the prompt never outgrows the ceiling the estimate priced: the longest vibe and a second attempt with many reasons reserve the same worst case", async () => {
  const longest: AvatarTraits = { ...TRAITS, marks: ["freckles", "mole", "dimples", "nose-piercing", "wrist-tattoo"], vibe: "☕".repeat(200) };
  const everything = `24-year-old girl, looks under 21, ١٧, карие ${"x".repeat(600)}`;
  const { result } = run([reply(everything), reply(GOOD)], { ...JOB, traits: longest });

  expect(await result).toMatchObject({ ok: true });
  expect(money.lines().filter((l) => l.type === "reserve").map((l) => l.worstMicros)).toEqual([ATTEMPT_WORST, ATTEMPT_WORST]);
});

// Reviewer probes (floor.probe.ts): vibes that grow the prompt most per character. Lone
// surrogates are refused by the contract (AvatarTraits), so they never reach a prompt.
test.each([
  ["quotes", '"'.repeat(200)],
  ["backslashes", "\\".repeat(200)],
  ["3-byte characters", "☕".repeat(200)],
  ["4-byte emoji", "\u{1F600}".repeat(100)],
])("a vibe of 200 %s, at 35 with every mark, still reserves the priced worst case on a second attempt", async (_label, vibe) => {
  const traits: AvatarTraits = { ...TRAITS, age: 35, ethnicity: "mixed", marks: ["freckles", "mole", "dimples", "nose-piercing", "wrist-tattoo"], vibe };
  const everything = `24-year-old girl, looks under 21, ١٧, карие ${"x".repeat(600)}`;
  const { result } = run([reply(everything), reply(GOOD.replace("25-year-old European", "35-year-old mixed-heritage"))], { ...JOB, traits });

  expect(await result).toMatchObject({ ok: true });
  expect(money.lines().filter((l) => l.type === "reserve").map((l) => l.worstMicros)).toEqual([ATTEMPT_WORST, ATTEMPT_WORST]);
});
