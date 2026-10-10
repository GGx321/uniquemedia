import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { runDescriptorCheckJob, type DescriptorCheckJob } from "./descriptorCheckJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.0c: the descriptor-vs-master check as a paid job, run like the import's describe job (importDescribeJob.test.ts): one image attached, a second attempt for an
// answer that cannot be used, every attempt reserved at its worst case and settled. It never writes anything: its only dependency is the chat.

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xaa);
const SCOPE: Scope = { avatarJobId: "job-00000001" };
const STORED_TEXT = "25-year-old European woman, hazel eyes, shoulder-length wavy chestnut hair, a curvy figure.";
const STORED: AvatarDescriptor = { age: 25, text: STORED_TEXT };
const JOB: DescriptorCheckJob = { jobId: "job-00000001", scope: SCOPE, textModel: "x-ai/grok-4.3", image: JPEG, stored: STORED };
/** One check attempt at its ceilings on grok-4.3 (fallback prices): 1.5K out × $2.50/M + 7K in × $1.25/M. */
const ATTEMPT_WORST = 12_500;

const OK = { state: "ok", descriptor: "", photo: "" };
const GOOD = { aspects: { hair: OK, eyes: OK, marks: OK, body: { state: "not-visible", descriptor: "", photo: "" } }, descriptor: STORED_TEXT };
const HAIR_FIXED = "25-year-old European woman, hazel eyes, long straight platinum hair, a curvy figure.";
const HAIR_WRONG = {
  aspects: { ...GOOD.aspects, hair: { state: "mismatch", descriptor: "волнистые каштановые", photo: "прямые платиновые" } },
  descriptor: HAIR_FIXED,
};

function reply(answer: unknown, cost = 0.0021): Step {
  return { status: 200, body: chatBody(typeof answer === "string" ? answer : JSON.stringify(answer), { cost }) };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Step[], job: DescriptorCheckJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runDescriptorCheckJob({ chat: client.chat, budget: money.budget, priceBook: money.priceBook }, job);
  return { net, result };
}

test("a good answer is the check: one reserve at the attempt's worst case under <job>:check#1, settled at usage.cost", async () => {
  const { result } = run([reply(GOOD)]);

  expect(await result).toEqual({
    ok: true,
    check: { matches: true, aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } }, proposal: null, checkedText: STORED_TEXT },
  });
  expect(withoutAt(money.lines())).toEqual([
    { type: "reserve", attemptId: "job-00000001:check#1", jobId: "job-00000001", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST },
    { type: "settle", attemptId: "job-00000001:check#1", costMicros: 2_100, estimated: false },
  ]);
});

test("a hair mismatch comes back with its proposal", async () => {
  const { result } = run([reply(HAIR_WRONG)]);

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: true, check: { matches: false, proposal: HAIR_FIXED, checkedText: STORED_TEXT } });
});

test("the request: the settings' text model, the call's token limits, reasoning low, the strict check schema, and the image attached", async () => {
  const { net, result } = run([reply(GOOD)]);
  await result;

  const body = net.calls[0]?.json();
  expect(body).toMatchObject({
    model: "x-ai/grok-4.3",
    max_tokens: 1_500,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: "descriptor_check", strict: true } },
  });
  const text = JSON.stringify(body);
  expect(text).toContain(JSON.stringify(STORED_TEXT).slice(1, -1));
  expect(text).toContain("data:image/jpeg;base64,");
});

test("her body phrase, when there is one, is in the request", async () => {
  const { net, result } = run([reply(GOOD)], { ...JOB, bodyPhrase: "She is tall and slim." });
  await result;

  expect(JSON.stringify(net.calls[0]?.json())).toContain("Body phrase");
});

test("an answer that cannot be used is asked once more under check#2, with the reason; both attempts are paid and settled", async () => {
  const { net, result } = run([reply("the hair looks fine", 0.002), reply(HAIR_WRONG, 0.0022)]);

  expect(await result).toMatchObject({ ok: true, check: { matches: false } });
  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain("An earlier answer could not be used");
  expect(second).toContain("was not the JSON object");
  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId, l.costMicros ?? l.worstMicros])).toEqual([
    ["reserve", "job-00000001:check#1", ATTEMPT_WORST],
    ["settle", "job-00000001:check#1", 2_000],
    ["reserve", "job-00000001:check#2", ATTEMPT_WORST],
    ["settle", "job-00000001:check#2", 2_200],
  ]);
});

test("an answer with no usable aspect is asked once more", async () => {
  const { net, result } = run([reply({ aspects: { hair: { state: "maybe" } }, descriptor: STORED_TEXT }), reply(GOOD)]);

  expect(await result).toMatchObject({ ok: true });
  expect(JSON.stringify(net.calls[1]?.json())).toContain("none of the four aspects");
});

test("an answer unreadable twice fails the job with INTERNAL and the reasons; the money of both attempts is settled", async () => {
  const { net, result } = run([reply("nope"), reply({ aspects: {} })]);

  const outcome = await result;

  expect(net.calls).toHaveLength(2);
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("no-aspects");
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

test("a reserve the scope's cap refuses sends nothing: RUN_CAP_EXCEEDED", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: ATTEMPT_WORST - 1 });
  const { net, result } = run([]);

  expect(await result).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  expect(net.calls).toHaveLength(0);
  expect(money.lines()).toEqual([]);
});

test("the cap of exactly two attempts holds both", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: 2 * ATTEMPT_WORST });
  const { net, result } = run([reply("nope"), reply(GOOD)]);

  expect(await result).toMatchObject({ ok: true });
  expect(net.calls).toHaveLength(2);
});

test("the longest text the contract allows, with her body phrase, never outgrows the ceiling the estimate priced: both attempts reserve the same worst case", async () => {
  // Quotes are the worst bytes per character (a JSON string escapes each into two); the text and the phrase together stay within the descriptor's 600.
  const stored: AvatarDescriptor = { age: 25, text: `25-year-old ${'"'.repeat(500)}` };
  const phrase = '"'.repeat(80);
  const { result } = run([reply("nope"), reply({ ...GOOD, descriptor: stored.text })], { ...JOB, stored, bodyPhrase: phrase });

  expect(await result).toMatchObject({ ok: true });
  expect(money.lines().filter((l) => l.type === "reserve").map((l) => l.worstMicros)).toEqual([ATTEMPT_WORST, ATTEMPT_WORST]);
});
