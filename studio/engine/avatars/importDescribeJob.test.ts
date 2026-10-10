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
/** One describe attempt at its ceilings on grok-4.3 (fallback prices): 3K out × $2.50/M + 9K in × $1.25/M. */
const ATTEMPT_WORST = 18_750;

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

const BODY_UNKNOWN = { height: "unknown", bust: "unknown", figure: "unknown", legLength: "unknown", legShape: "unknown", bottomSize: "unknown", bottomShape: "unknown", bodyMarks: [] };

test("a body the photo showed rides along with the traits and the descriptor (S5.2b)", async () => {
  const outcome = await run([reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN, height: "tall" })]).result;
  expect(outcome.ok && outcome.body?.values).toEqual({ height: "tall" });
});

test("a photo that showed no body leaves the body out of the result (S5.2b)", async () => {
  const outcome = await run([reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN })]).result;
  expect(outcome.ok && "body" in outcome).toBe(false);
});

// S5.2b review M1: a model that refuses to estimate a body must not make every import fail. An unusable first answer (prose or an empty one) is followed by an attempt that asks
// without the «Body» section and without the body keys in the schema; a readable answer that broke a rule keeps the body request.
function requestShape(call: { json(): Record<string, unknown> } | undefined): { system: string; keys: string[] } {
  const body = call?.json() ?? {};
  const messages = Array.isArray(body.messages) ? (body.messages as { role: string; content: unknown }[]) : [];
  const format = body.response_format as { json_schema?: { schema?: { properties?: Record<string, unknown> } } } | undefined;
  return { system: String(messages.find((m) => m.role === "system")?.content ?? ""), keys: Object.keys(format?.json_schema?.schema?.properties ?? {}) };
}

test("the first attempt asks for the body: the section is in the prompt and the eight keys are in the schema", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN })]);
  await result;

  const first = requestShape(net.calls[0]);
  expect(first.system).toContain("Body: answer each");
  expect(first.keys).toContain("bodyMarks");
  expect(first.keys).toContain("height");
});

test("a refusal in prose is followed by an attempt without the body request, which then succeeds", async () => {
  const { net, result } = run([{ status: 200, body: chatBody("I'm sorry, I can't assess a person's body from a photo.", { cost: 0.002 }) }, reply(GOOD_ANSWER, 0.0022)]);

  expect(await result).toMatchObject({ ok: true });
  const second = requestShape(net.calls[1]);
  expect(second.system).not.toContain("Body: answer each");
  expect(second.keys).not.toContain("bodyMarks");
  expect(second.keys).not.toContain("height");
  expect(second.keys).toContain("descriptor");
});

test("the second attempt is on the same job and the same ceiling: both attempts are reserved at the worst case and settled", async () => {
  const { result } = run([{ status: 200, body: chatBody("no", { cost: 0.002 }) }, reply(GOOD_ANSWER, 0.0022)]);
  await result;

  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId, l.costMicros ?? l.worstMicros])).toEqual([
    ["reserve", "import-00000001:describe#1", ATTEMPT_WORST],
    ["settle", "import-00000001:describe#1", 2_000],
    ["reserve", "import-00000001:describe#2", ATTEMPT_WORST],
    ["settle", "import-00000001:describe#2", 2_200],
  ]);
});

test("an answer without body that came after the refusal proposes no body", async () => {
  const { result } = run([{ status: 200, body: chatBody("{", { cost: 0.002 }) }, reply(GOOD_ANSWER, 0.0022)]);

  const outcome = await result;
  expect(outcome.ok && "body" in outcome).toBe(false);
});

test("an empty first answer is followed by an attempt without the body request", async () => {
  const { net, result } = run([{ status: 200, body: chatBody("", { cost: 0.002 }) }, reply(GOOD_ANSWER, 0.0022)]);

  expect(await result).toMatchObject({ ok: true });
  expect(requestShape(net.calls[1]).system).not.toContain("Body: answer each");
});

test("a readable answer that broke a rule is asked again WITH the body request", async () => {
  const { net, result } = run([reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN, ethnicity: "martian" }), reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN, height: "tall" })]);

  const outcome = await result;
  expect(requestShape(net.calls[1]).system).toContain("Body: answer each");
  expect(outcome.ok && outcome.body?.values).toEqual({ height: "tall" });
});

test("a moderation refusal (HTTP 400) stays final: no second attempt without the body", async () => {
  const { net, result } = run([{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }, reply(GOOD_ANSWER)]);

  expect(await result).toMatchObject({ ok: false });
  expect(net.calls).toHaveLength(1);
});

test("an apology written inside the JSON is followed by an attempt without the body request, which then succeeds", async () => {
  const apology = "I'm sorry, but I can't help with assessing a person's body from a photo.";
  const { net, result } = run([reply({ ...GOOD_ANSWER, ...BODY_UNKNOWN, descriptor: apology }, 0.002), reply(GOOD_ANSWER, 0.0022)]);

  expect(await result).toMatchObject({ ok: true });
  const second = requestShape(net.calls[1]);
  expect(second.system).not.toContain("Body: answer each");
  expect(second.keys).not.toContain("bodyMarks");
});
