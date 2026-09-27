import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, JPEG, JPEG_2, makeClient, setupMoney, withoutAt, type Money, type Reply } from "../openrouter/testing/fakes";
import { runImportJob, type ImportJob } from "./importJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6c (review H1): the mandatory one-time image age check, then — only on a
// clear pass — the vision describe job. Extracted from engine.ts so every
// guard here is directly testable against an injected client, the same way
// descriptorJob.test.ts and candidateJob.test.ts's own age-check matrix
// (M7) test their own jobs.

const JOB_ID = "import-00000001";
const SCOPE: Scope = { avatarJobId: JOB_ID };
const AGE_JPEG = JPEG;
const DESCRIBE_JPEG = JPEG_2;
const JOB: ImportJob = { jobId: JOB_ID, scope: SCOPE, textModel: "x-ai/grok-4.3", ageJpeg: AGE_JPEG, describeJpeg: DESCRIBE_JPEG };
/** Fallback prices: an age check on grok-4.3 at its ceilings (2.2K in with one image, 1K out). */
const AGE_WORST = 5_250;
const DESCRIBE_WORST = 16_250;
const MODERATION: Reply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

const GOOD_DESCRIBE_ANSWER = {
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
  marks: [] as string[],
  descriptor: "27-year-old Latina woman, tan skin, brown eyes, long wavy black hair, athletic build.",
};

function ageAnswer(adult: boolean, confidence = 0.95, cost = 0.0014): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ adult, confidence, reason: adult ? "Mature features of a woman in her mid-20s." : "Appears younger than 21." }), { cost }) };
}

function describeAnswer(overrides: Record<string, unknown> = {}, cost = 0.0021): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ ...GOOD_DESCRIBE_ANSWER, ...overrides }), { cost }) };
}

/** Whether a chat completion call asked for the "import_describe" schema (never the age check's own "age_check"). */
function isDescribeCall(body: unknown): boolean {
  return typeof body === "object" && body !== null && JSON.stringify((body as { response_format?: unknown }).response_format ?? {}).includes("import_describe");
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Reply[], job: ImportJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runImportJob({ chat: client.chat, budget: money.budget, priceBook: money.priceBook }, job);
  return { net, result };
}

test("the age check passes, the describe call succeeds: her traits, descriptor and the age check's own confidence", async () => {
  const { net, result } = run([ageAnswer(true, 0.93), describeAnswer()]);

  expect(await result).toEqual({
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
    descriptor: { age: 27, text: GOOD_DESCRIBE_ANSWER.descriptor },
    ageConfidence: 0.93,
  });
  expect(net.calls).toHaveLength(2);
  expect(withoutAt(money.lines()).map((l) => l.attemptId)).toEqual([`${JOB_ID}:age`, `${JOB_ID}:age`, `${JOB_ID}:describe#1`, `${JOB_ID}:describe#1`]);
});

test("the age check attaches exactly the staged ageJpeg, the describe call the staged describeJpeg", async () => {
  const { net, result } = run([ageAnswer(true), describeAnswer()]);
  await result;

  const ageBody = JSON.stringify(net.calls[0]?.json());
  const describeBody = JSON.stringify(net.calls[1]?.json());
  const ageB64 = Buffer.from(AGE_JPEG).toString("base64");
  const describeB64 = Buffer.from(DESCRIBE_JPEG).toString("base64");
  expect(ageBody).toContain(ageB64);
  expect(describeBody).toContain(describeB64);
  expect(ageBody).not.toContain(describeB64);
});

test("a rejected first describe answer is asked once more; the age check itself is never repeated", async () => {
  const { net, result } = run([ageAnswer(true), describeAnswer({ ethnicity: "martian" }), describeAnswer()]);

  expect(await result).toMatchObject({ ok: true });
  expect(net.calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(3);
  expect(net.calls.filter((c) => JSON.stringify(c.json()).includes('"age_check"'))).toHaveLength(1);
});

describe("the age check's own failure paths: refusal, no describe call, the ledger and authInvalid are right", () => {
  interface AgeFailureCase {
    name: string;
    reply: Reply;
    code: string;
    authInvalid: boolean;
    /** Whether the age attempt's own ledger line was settled (a final response, even a bad one) or left open (no final response; may have been billed). */
    settled: boolean;
    /** Extra identical transport-level retries of the same reply, inside the same attempt id (e.g. a persistent 5xx). */
    retries?: number;
    /**
     * Round 3, L6: a substring the error's own detail must NOT contain.
     * Without the `|| age.aboveWorst` check, this exact case (a valid,
     * passing verdict billed above its worst case) falls through to the
     * describe job, whose own first reserve is refused by the now-halted
     * budget — same final code, same "no describe call sent", but a
     * different detail (naming "reconcile", the halt's own wording,
     * instead of the age attempt's own toEngineError mapping). Catches the
     * removal that every other assertion in this loop does not.
     */
    detailExcludes?: string;
  }

  const cases: AgeFailureCase[] = [
    { name: "adult: false", reply: ageAnswer(false, 0.99), code: "AGE_CHECK_FAILED", authInvalid: false, settled: true },
    { name: "a confidence below 0.75", reply: ageAnswer(true, 0.74), code: "AGE_CHECK_FAILED", authInvalid: false, settled: true },
    { name: "an answer that is not the JSON asked for (unreadable)", reply: { status: 200, body: chatBody("The person is an adult.", { cost: 0.0014 }) }, code: "AGE_CHECK_FAILED", authInvalid: false, settled: true },
    { name: "an empty answer (EMPTY_CONTENT)", reply: { status: 200, body: chatBody(null, { cost: 0.0014 }) }, code: "AGE_CHECK_FAILED", authInvalid: false, settled: true },
    { name: "a moderation refusal (refused)", reply: MODERATION, code: "AGE_CHECK_FAILED", authInvalid: false, settled: true },
    { name: "a network error before any response", reply: { reject: new TypeError("fetch failed") }, code: "NETWORK", authInvalid: false, settled: false },
    { name: "a persistent 5xx (transport retries exhausted)", reply: { status: 503 }, code: "NETWORK", authInvalid: false, settled: true, retries: 2 },
    { name: "a 401", reply: { status: 401, body: { error: { message: "No auth credentials found" } } }, code: "AUTH_INVALID", authInvalid: true, settled: true },
    {
      name: "a charge above the worst case",
      reply: { status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "An adult." }), { cost: 6 }) },
      code: "SETTLE_ABOVE_WORST",
      authInvalid: false,
      settled: true,
      detailExcludes: "reconcile",
    },
  ];

  test.each(cases.map((c): [string, AgeFailureCase] => [c.name, c]))("%s", async (_label, c) => {
    const { net, result } = run(Array.from({ length: 1 + (c.retries ?? 0) }, () => c.reply));

    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, error: { code: c.code }, authInvalid: c.authInvalid });
    // The describe call never runs: the age check alone decided this.
    expect(net.calls.filter((call) => isDescribeCall(call.json()))).toHaveLength(0);
    if (c.detailExcludes !== undefined && !outcome.ok) {
      expect(outcome.error.detail ?? "").not.toContain(c.detailExcludes);
    }

    const attemptLines = money.lines().filter((l) => l.attemptId === `${JOB_ID}:age`);
    if (c.settled) expect(attemptLines).toMatchObject([{ type: "reserve", worstMicros: AGE_WORST }, { type: "settle" }]);
    else expect(attemptLines).toEqual([expect.objectContaining({ type: "reserve", worstMicros: AGE_WORST })]);
    expect(money.budget.status().heldMicros).toBe(0);
  });
});

describe("the describe job's own failures propagate, after the age check settled", () => {
  test("AUTH_INVALID from the describe call: authInvalid is true, so the caller can mark the key rejected", async () => {
    const { net, result } = run([ageAnswer(true), { status: 401, body: { error: { message: "No auth credentials found" } } }]);

    expect(await result).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" }, authInvalid: true });
    expect(net.calls).toHaveLength(2);
    expect(money.lines().filter((l) => l.attemptId === `${JOB_ID}:age`)).toMatchObject([{ type: "reserve", worstMicros: AGE_WORST }, { type: "settle" }]);
  });

  test("rejected twice fails with INTERNAL, authInvalid false; the age check's own line still settled", async () => {
    const { result } = run([ageAnswer(true), describeAnswer({ ethnicity: "martian" }), describeAnswer({ descriptor: "not anchored at all" })]);

    expect(await result).toMatchObject({ ok: false, error: { code: "INTERNAL" }, authInvalid: false });
    const describeLines = money.lines().filter((l) => l.attemptId === `${JOB_ID}:describe#1` || l.attemptId === `${JOB_ID}:describe#2`);
    expect(describeLines.filter((l) => l.type === "reserve")).toMatchObject([{ worstMicros: DESCRIBE_WORST }, { worstMicros: DESCRIBE_WORST }]);
  });
});
