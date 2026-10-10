import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, JPEG_2, makeClient, setupMoney, withoutAt, type Money, type Reply } from "../openrouter/testing/fakes";
import { runImportJob, type ImportJob } from "./importJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6c: the vision describe job, run against an injected client. Owner
// decision 2026-10-05 (personal-use app): an import makes no age check, so
// the describe call is the only call this job ever sends.

const JOB_ID = "import-00000001";
const SCOPE: Scope = { avatarJobId: JOB_ID };
const DESCRIBE_JPEG = JPEG_2;
const JOB: ImportJob = { jobId: JOB_ID, scope: SCOPE, textModel: "x-ai/grok-4.3", describeJpeg: DESCRIBE_JPEG };
const DESCRIBE_WORST = 18_750;
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

function describeAnswer(overrides: Record<string, unknown> = {}, cost = 0.0021): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ ...GOOD_DESCRIBE_ANSWER, ...overrides }), { cost }) };
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

test("the describe call succeeds: her traits and descriptor, and no age verdict in the result", async () => {
  const { net, result } = run([describeAnswer()]);

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
  });
  expect(net.calls).toHaveLength(1);
});

test("an import sends no age check and reserves no age money: only the describe attempt is on the ledger", async () => {
  const { net, result } = run([describeAnswer()]);
  await result;

  expect(net.calls.filter((c) => JSON.stringify(c.json()).includes('"age_check"'))).toHaveLength(0);
  expect(withoutAt(money.lines()).map((l) => l.attemptId)).toEqual([`${JOB_ID}:describe#1`, `${JOB_ID}:describe#1`]);
  expect(money.lines().filter((l) => String(l.attemptId).endsWith(":age"))).toEqual([]);
});

test("the describe call attaches exactly the staged describeJpeg", async () => {
  const { net, result } = run([describeAnswer()]);
  await result;

  expect(JSON.stringify(net.calls[0]?.json())).toContain(Buffer.from(DESCRIBE_JPEG).toString("base64"));
});

test("a rejected first describe answer is asked once more", async () => {
  const { net, result } = run([describeAnswer({ ethnicity: "martian" }), describeAnswer()]);

  expect(await result).toMatchObject({ ok: true });
  expect(net.calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(2);
});

describe("the describe job's own failures propagate", () => {
  test("AUTH_INVALID from the describe call: authInvalid is true, so the caller can mark the key rejected", async () => {
    const { net, result } = run([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);

    expect(await result).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" }, authInvalid: true });
    expect(net.calls).toHaveLength(1);
  });

  test("a moderation refusal of the describe call is MODERATION_REFUSED, authInvalid false, with no second attempt", async () => {
    const { net, result } = run([MODERATION]);

    expect(await result).toMatchObject({ ok: false, error: { code: "MODERATION_REFUSED" }, authInvalid: false });
    expect(net.calls).toHaveLength(1);
  });

  test("rejected twice fails with INTERNAL, authInvalid false; both attempts reserved their worst case", async () => {
    const { result } = run([describeAnswer({ ethnicity: "martian" }), describeAnswer({ descriptor: "not anchored at all" })]);

    expect(await result).toMatchObject({ ok: false, error: { code: "INTERNAL" }, authInvalid: false });
    const describeLines = money.lines().filter((l) => l.attemptId === `${JOB_ID}:describe#1` || l.attemptId === `${JOB_ID}:describe#2`);
    expect(describeLines.filter((l) => l.type === "reserve")).toMatchObject([{ worstMicros: DESCRIBE_WORST }, { worstMicros: DESCRIBE_WORST }]);
    expect(money.budget.status().heldMicros).toBe(0);
  });
});

const BODY_UNKNOWN = { height: "unknown", bust: "unknown", figure: "unknown", legLength: "unknown", legShape: "unknown", bottomSize: "unknown", bottomShape: "unknown", bodyMarks: [] };

test("the body the describe call read is passed on (S5.2b)", async () => {
  const outcome = await run([describeAnswer({ ...BODY_UNKNOWN, figure: "hourglass" })]).result;
  expect(outcome.ok && outcome.body?.values).toEqual({ figure: "hourglass" });
});

test("a photo that showed no body leaves the body out of the result (S5.2b)", async () => {
  const outcome = await run([describeAnswer(BODY_UNKNOWN)]).result;
  expect(outcome.ok && "body" in outcome).toBe(false);
});
