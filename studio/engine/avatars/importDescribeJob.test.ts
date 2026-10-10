import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { IMPORT_DESCRIBE_MAX_ATTEMPTS } from "./plan";
import { runImportDescribeJob, type ImportDescribeJob } from "./importDescribeJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6c: the vision call for an imported avatar, run exactly like the plain
// descriptor job (descriptorJob.test.ts) but with an image attached and no
// traits input at all — everything about her comes from the photo.

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xaa);
const SCOPE: Scope = { avatarJobId: "import-00000001" };
const JOB: ImportDescribeJob = { jobId: "import-00000001", scope: SCOPE, textModel: "x-ai/grok-4.3", image: JPEG };
/** One describe attempt at its ceilings on grok-4.3 (fallback prices): 3K out × $2.50/M + 8K in × $1.25/M. */
const ATTEMPT_WORST = 17_500;

const GOOD_ANSWER = {
  people: 1,
  woman: true,
  age: 27,
  ethnicity: "latina",
  skinTone: "tan",
  hairColor: "black",
  hairLength: "long",
  hairTexture: "wavy",
  eyeColor: "brown",
  build: "athletic",
  marks: [],
  descriptor: "27-year-old Latina woman, tan skin, brown eyes, long wavy black hair, athletic build.",
};

function reply(answer: Record<string, unknown>, cost = 0.005): Step {
  return { status: 200, body: chatBody(JSON.stringify(answer), { cost }) };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Step[], job: ImportDescribeJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runImportDescribeJob({ chat: client.chat, budget: money.budget, priceBook: money.priceBook }, job);
  return { net, result };
}

test("a valid first answer is the traits and the descriptor: one reserve at the attempt's worst case, settled at usage.cost", async () => {
  const { net, result } = run([reply(GOOD_ANSWER, 0.0021)]);

  const outcome = await result;
  expect(outcome).toEqual({
    ok: true,
    traits: {
      age: 27,
      ethnicity: "latina",
      skinTone: "tan",
      hairColor: "black",
      hairLength: "long",
      hairTexture: "wavy",
      eyeColor: "brown",
      build: "athletic",
      marks: [],
      vibe: "",
    },
    descriptor: { age: 27, text: GOOD_ANSWER.descriptor },
  });
  expect(withoutAt(money.lines())).toEqual([
    { type: "reserve", attemptId: "import-00000001:describe#1", jobId: "import-00000001", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST },
    { type: "settle", attemptId: "import-00000001:describe#1", costMicros: 2_100, estimated: false },
  ]);
  const body = net.calls[0]?.json();
  expect(body).toMatchObject({
    model: "x-ai/grok-4.3",
    reasoning: { effort: "low" },
    response_format: { type: "json_schema", json_schema: { name: "import_describe", strict: true } },
  });
});

test("the attached photo reaches the request as a data URL", async () => {
  const { net, result } = run([reply(GOOD_ANSWER)]);
  await result;

  const jpeg = /"url":"data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/.exec(JSON.stringify(net.calls[0]?.json()))?.[1] ?? "";
  expect(Buffer.from(jpeg, "base64")).toEqual(Buffer.from(JPEG));
});

test("a rejected answer is asked once more under a new attempt id, with the reasons; both attempts are paid and settled", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, ethnicity: "martian" }, 0.002), reply(GOOD_ANSWER, 0.0022)]);

  expect(await result).toMatchObject({ ok: true });
  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain("rejected");
  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId, l.costMicros ?? l.worstMicros])).toEqual([
    ["reserve", "import-00000001:describe#1", ATTEMPT_WORST],
    ["settle", "import-00000001:describe#1", 2_000],
    ["reserve", "import-00000001:describe#2", ATTEMPT_WORST],
    ["settle", "import-00000001:describe#2", 2_200],
  ]);
});

test("the second attempt is told which of our words to avoid, never the first answer's own text", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, descriptor: "27-year-old Latina TEEENAGE girl, tan skin." }), reply(GOOD_ANSWER)]);
  await result;

  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain('\\"teen\\"');
  expect(second).not.toContain("TEEENAGE");
});

test("an answer rejected twice fails the job with the reasons; the money of both attempts is settled", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, descriptor: "A Latina woman, tan skin." }), reply({ ...GOOD_ANSWER, descriptor: "27-year-old woman who looks 19." })]);

  const outcome = await result;

  expect(net.calls).toHaveLength(2);
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("other-age");
  expect(money.lines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([5_000, 5_000]);
  expect(money.ledger.openReserves()).toEqual([]);
});

test("a paid answer without content gets the second attempt", async () => {
  const { result, net } = run([{ status: 200, body: chatBody(null, { cost: 0.001, finishReason: "length" }) }, reply(GOOD_ANSWER)]);

  expect(await result).toMatchObject({ ok: true });
  expect(JSON.stringify(net.calls[1]?.json())).toContain("empty");
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

test("at most 2 describe attempts, matching plan.ts's IMPORT_DESCRIBE_MAX_ATTEMPTS", () => {
  expect(IMPORT_DESCRIBE_MAX_ATTEMPTS).toBe(2);
});

// T6c review round 2, M5: "women only, exactly one person" — the photo does
// not change between attempts, so retrying cannot fix a group photo or the
// wrong gender; the job must fail at once, on the first answer, unlike every
// other rejection above which gets a second try.
test("a group photo (people: 2) fails at once with IMPORT_SUBJECT_INVALID: no second attempt, one settled reserve", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, people: 2 })]);

  expect(await result).toMatchObject({ ok: false, error: { code: "IMPORT_SUBJECT_INVALID" } });
  expect(net.calls).toHaveLength(1);
  expect(withoutAt(money.lines()).map((l) => l.type)).toEqual(["reserve", "settle"]);
});

test("one person who is not a woman (woman: false) fails at once with IMPORT_SUBJECT_INVALID too", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, woman: false })]);

  expect(await result).toMatchObject({ ok: false, error: { code: "IMPORT_SUBJECT_INVALID" } });
  expect(net.calls).toHaveLength(1);
});
