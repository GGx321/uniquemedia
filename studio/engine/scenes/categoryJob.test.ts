import { afterEach, beforeEach, expect, test } from "bun:test";
import { CATEGORY_DESCRIPTION_MAX } from "../../shared/engine";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { runCategoryJob, type CategoryJob } from "./categoryJob";
import { poolCall } from "./poolGen";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.2: the pool call, 2 attempts like the descriptor's. Every attempt is reserved at its worst case before it is sent and settled
// after; what the job cost is what the ledger booked for its id, whatever the answer was.

const SCOPE: Scope = { avatarJobId: "job-00000001" };
const JOB: CategoryJob = { jobId: "job-00000001", scope: SCOPE, description: "кофейни и булочные Парижа", textModel: "x-ai/grok-4.3" };
/** One pool attempt at its ceilings on grok-4.3 (fallback prices): 4K out × $2.50/M + 10K in × $1.25/M. */
const ATTEMPT_WORST = 22_500;

type Json = Record<string, unknown>;

function place(name: string, over: Json = {}): Json {
  return {
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: false,
    ...over,
  };
}

function answer(over: Json = {}): Json {
  return {
    label: "Paris cafes",
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => place(name, { mirror: i === 2 })),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

function reply(content: unknown, cost = 0.005): Step {
  return { status: 200, body: chatBody(typeof content === "string" ? content : JSON.stringify(content), { cost }) };
}

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function run(steps: Step[], job: CategoryJob = JOB) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runCategoryJob({ chat: client.chat, budget: money.budget, priceBook: money.priceBook }, job);
  return { net, result };
}

test("a valid first answer is the pool: one reserve at the attempt's worst case, settled at usage.cost, and the job cost is that cost", async () => {
  const { result } = run([reply(answer(), 0.0051)]);

  const outcome = await result;

  expect(outcome).toMatchObject({ ok: true, label: "Paris cafes", style: "phone", dropped: 0, spentMicros: 5_100 });
  expect(withoutAt(money.lines())).toEqual([
    { type: "reserve", attemptId: "job-00000001:pool#1", jobId: "job-00000001", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST },
    { type: "settle", attemptId: "job-00000001:pool#1", costMicros: 5_100, estimated: false },
  ]);
});

test("the request: the settings' text model, reasoning low, the strict scene_pool schema, the pool call's ceiling and the owner's description alone", async () => {
  const { net, result } = run([reply(answer())]);
  await result;

  const body = net.calls[0]?.json();
  expect(body).toMatchObject({
    model: "x-ai/grok-4.3",
    max_tokens: poolCall("x-ai/grok-4.3").maxTokens,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: "scene_pool", strict: true } },
  });
  expect(JSON.stringify(body)).toContain("кофейни и булочные Парижа");
});

test("an answer with a few bad items is salvaged: no second attempt, nothing more is paid", async () => {
  const { net, result } = run([reply(answer({ outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a red bikini"] }))]);

  expect(await result).toMatchObject({ ok: true, dropped: 1 });
  expect(net.calls).toHaveLength(1);
  expect(money.lines().filter((l) => l.type === "reserve")).toHaveLength(1);
});

test("a rejected answer is asked once more under a new attempt id, with the reasons; both attempts are paid and settled, and both are the job's cost", async () => {
  const { net, result } = run([reply(answer({ shotDeck: [] }), 0.004), reply(answer(), 0.0062)]);

  expect(await result).toMatchObject({ ok: true, spentMicros: 10_200 });
  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain("rejected");
  expect(second).toContain("shotDeck");
  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId, l.costMicros ?? l.worstMicros])).toEqual([
    ["reserve", "job-00000001:pool#1", ATTEMPT_WORST],
    ["settle", "job-00000001:pool#1", 4_000],
    ["reserve", "job-00000001:pool#2", ATTEMPT_WORST],
    ["settle", "job-00000001:pool#2", 6_200],
  ]);
});

test("the second attempt is told which of our words cost items their place, never the first answer's own text", async () => {
  const hostile = "a corner SECRET-MARKER-123 with a quote \" and a very very very long tail past the bound";
  const first = answer({ outfits: ["a red bikini", hostile, "b"] });
  const { net, result } = run([reply(first), reply(answer())]);
  await result;

  const second = JSON.stringify(net.calls[1]?.json());
  expect(second).toContain('\\"bikini\\"');
  expect(second).not.toContain("SECRET-MARKER");
});

test("a paid answer without content counts as an answer: the second attempt is told it was empty", async () => {
  const { net, result } = run([{ status: 200, body: chatBody(null, { cost: 0.001, finishReason: "length" }) }, reply(answer())]);

  expect(await result).toMatchObject({ ok: true, spentMicros: 6_000 });
  expect(JSON.stringify(net.calls[1]?.json())).toContain("it was empty");
});

test("an answer rejected twice fails with POOL_REJECTED, carries what both attempts cost, and the reasons it names are ours", async () => {
  const { net, result } = run([reply({ pool: "cafes" }, 0.0051), reply(answer({ label: "" }), 0.0062)]);

  const outcome = await result;

  expect(net.calls).toHaveLength(2);
  expect(outcome).toMatchObject({ ok: false, spentMicros: 11_300, error: { code: "POOL_REJECTED", spentMicros: 11_300 } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("bad-label");
  expect(money.lines().filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([5_100, 6_200]);
  expect(money.ledger.openReserves()).toEqual([]);
});

test("a moderation refusal is free and final: MODERATION_REFUSED, no second attempt, nothing spent", async () => {
  const { net, result } = run([{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);

  expect(await result).toMatchObject({ ok: false, spentMicros: 0, error: { code: "MODERATION_REFUSED", spentMicros: 0 } });
  expect(net.calls).toHaveLength(1);
  expect(money.lines().at(-1)).toMatchObject({ type: "settle", costMicros: 0 });
});

test("a refusal after a rejected first answer still costs that first answer", async () => {
  const { net, result } = run([reply(answer({ shotDeck: [] }), 0.006), { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);

  expect(await result).toMatchObject({ ok: false, spentMicros: 6_000, error: { code: "MODERATION_REFUSED", spentMicros: 6_000 } });
  expect(net.calls).toHaveLength(2);
});

test("a 401 is final: AUTH_INVALID, never retried", async () => {
  const { net, result } = run([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
  expect(net.calls).toHaveLength(1);
});

test("a request that got no response leaves the reserve open: NETWORK, and the job is counted at the worst case until the reconcile", async () => {
  const { net, result } = run([{ reject: new TypeError("fetch failed") }]);

  expect(await result).toMatchObject({ ok: false, spentMicros: ATTEMPT_WORST, error: { code: "NETWORK", spentMicros: ATTEMPT_WORST } });
  expect(net.calls).toHaveLength(1);
  expect(money.ledger.openReserves().map((r) => r.worstMicros)).toEqual([ATTEMPT_WORST]);
});

test("a reserve the job's cap refuses sends nothing: RUN_CAP_EXCEEDED, spent 0", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: ATTEMPT_WORST - 1 });
  const { net, result } = run([]);

  expect(await result).toMatchObject({ ok: false, spentMicros: 0, error: { code: "RUN_CAP_EXCEEDED", spentMicros: 0 } });
  expect(net.calls).toHaveLength(0);
  expect(money.lines()).toEqual([]);
});

test("a cap that is exactly the two attempts' worst case holds both: the accepted worst is enough", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: 2 * ATTEMPT_WORST });
  const { result } = run([reply(answer({ shotDeck: [] }), 0.004), reply(answer(), 0.005)]);

  expect(await result).toMatchObject({ ok: true });
});

test("the second attempt that the cap cannot hold is not sent: the first answer's refusal and the cap both show, and the first is paid", async () => {
  await money.cleanup();
  // The first attempt settles at 4,000: 4,000 booked + a second reserve of 22,500 is one micro-dollar over this cap.
  money = await setupMoney({ runCapMicros: ATTEMPT_WORST + 3_999 });
  const { net, result } = run([reply(answer({ shotDeck: [] }), 0.004)]);

  const outcome = await result;

  expect(net.calls).toHaveLength(1);
  expect(outcome).toMatchObject({ ok: false, spentMicros: 4_000, error: { code: "RUN_CAP_EXCEEDED", spentMicros: 4_000 } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("bad-shot-deck");
});

test("the worst description (500 chars of three bytes) with a hostile first answer reserves exactly the priced worst case on both attempts", async () => {
  const everything = answer({ label: "", shotDeck: [], outfits: ["a red bikini", "black lingerie", "a swimsuit", "a thong", "stockings", "a slip dress", "a sports bra"] });
  const { result } = run([reply(everything), reply(answer())], { ...JOB, description: "漢".repeat(CATEGORY_DESCRIPTION_MAX) });

  expect(await result).toMatchObject({ ok: true });
  expect(money.lines().filter((l) => l.type === "reserve").map((l) => l.worstMicros)).toEqual([ATTEMPT_WORST, ATTEMPT_WORST]);
});

test("a call is not resumable: running the job again is a new request under its own job id, reserved and paid on its own", async () => {
  const first = run([reply(answer(), 0.005)]);
  await first.result;
  const again = run([reply(answer(), 0.005)], { ...JOB, jobId: "job-00000002", scope: { avatarJobId: "job-00000002" } });
  await again.result;

  expect(money.lines().filter((l) => l.type === "reserve").map((l) => l.attemptId)).toEqual(["job-00000001:pool#1", "job-00000002:pool#1"]);
});
