import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { plan, planWithPools, POOLS, type PlanSlot } from "../scenes";
import { CUSTOM_POOL, CUSTOM_REF, customSnapshot } from "../scenes/testing/customPool";
import { buildRunPlan, plannedSlots, runWriterConfig } from "./plan";
import { NetworkPool } from "./pools";
import { runWriterPhase, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6: the run's writer phase. One scene-writer call per chunk of the plan
// (the writer's own prompt and answer rules, scenes/writer.ts), under the
// chunk's ids pre-allocated in the plan. Each chunk's accepted sentences go
// to the journal before the next chunk is asked, so a resume never pays for
// a chunk twice, and an id the ledger already holds is never sent again.

const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
/** grok-4.3 at the fallback prices, WRITER_CALL's ceilings: 14K in, 8K out (T5c). */
const ATTEMPT_WORST = 37_500;
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

function runPlan(count: number) {
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: "2026-09-24T12:00:00.000Z",
    request: { avatarId: "avatar-0001", count, categories: ["home"], poses: { profile: false, back: false } },
    imageAgeCheck: "off",
    models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
    capMicros: 10_000_000,
    plannedWorstMicros: 10_000_000,
    // Friend and candid shots only would be simpler, but the plan's own draw is what a run writes for.
    scenes: plan({ seed: 11, count, categories: ["home"] }),
  });
}

/** A good answer for the slots the request asked about (read from its own prompt). */
function answerFor(call: FetchCall, override?: (slot: number) => string): Reply {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  const slots: { slotIndex: number }[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  const scenes = slots.map((s) => ({ slotIndex: s.slotIndex, sentence: override?.(s.slotIndex) ?? SENTENCE }));
  return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
}

const good: Step = (call) => answerFor(call);
const refusedAnswer: Step = { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) };

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

function phaseOf(count: number, overrides: Partial<WriterPhase> = {}): WriterPhase {
  const run = runPlan(count);
  return {
    jobId: "job-00000001",
    scope: SCOPE,
    textModel: "x-ai/grok-4.3",
    signal: new AbortController().signal,
    slots: plannedSlots(run),
    chunks: run.writerChunks,
    sentences: new Map(),
    writerDone: new Set(),
    ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
    ...runWriterConfig(run.categories),
    ...overrides,
  };
}

function start(steps: Step[], phase: WriterPhase, opts: { pool?: NetworkPool } = {}) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const chunks: { chunk: number; sentences: ReadonlyMap<number, string>; callsSoFar: number }[] = [];
  const pool = opts.pool ?? new NetworkPool({ max: 6 });
  const result = runWriterPhase(
    {
      chat: client.chat,
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      onChunk: async (chunk, sentences) => {
        chunks.push({ chunk, sentences, callsSoFar: net.calls.length });
      },
    },
    phase,
  );
  return { net, chunks, result };
}

function reserveIds(): string[] {
  return money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
}

describe("runWriterPhase", () => {
  test("asks once per chunk under `${runId}:writer-${chunk}#1` and records each chunk before asking the next", async () => {
    const { chunks, result } = start([good, good], phaseOf(30));
    const answer = await result;

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.sentences.size).toBe(30);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-2#1`]);
    expect(chunks.map((c) => [c.chunk, c.sentences.size, c.callsSoFar])).toEqual([
      [1, 25, 1],
      [2, 5, 2],
    ]);
  });

  test("a rejected answer is asked again under the chunk's next id, told why", async () => {
    const { net, result } = start([refusedAnswer, good], phaseOf(3));
    const answer = await result;

    expect(answer.ok).toBe(true);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-1#2`]);
    expect(JSON.stringify(net.calls[1]?.json())).toContain("An earlier answer was rejected");
  });

  test("a chunk rejected on every attempt fails the phase; no later chunk is asked and every attempt stays settled", async () => {
    const { net, result } = start([refusedAnswer, refusedAnswer], phaseOf(30));
    const answer = await result;

    expect(answer).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
    // Two answers are all a chunk gets, whatever spare ids remain: the spares are for attempts that got no answer.
    expect(net.calls).toHaveLength(2);
    expect(withoutAt(money.lines()).filter((l) => l.type !== "reserve")).toEqual([
      { type: "settle", attemptId: `${RUN_ID}:writer-1#1`, costMicros: 2_000, estimated: false },
      { type: "settle", attemptId: `${RUN_ID}:writer-1#2`, costMicros: 2_000, estimated: false },
    ]);
    expect(money.budget.status().openAttempts).toBe(0);
  });

  test("resume: a chunk already in the journal is never asked again, and an id the ledger holds is never re-sent", async () => {
    // Chunk 1 is done (its sentences are in the journal); chunk 2's first attempt was reserved before a crash.
    const reserved = await money.budget.tryReserve({ attemptId: `${RUN_ID}:writer-2#1`, jobId: "job-00000000", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST });
    if (!reserved.ok) throw new Error("reserve refused");
    await money.budget.abandon(reserved.handle);
    const base = phaseOf(30);
    const done = new Map(base.slots.slice(0, 25).map((s: PlanSlot) => [s.slotIndex, "Earlier."]));

    const { net, chunks, result } = start([good], { ...base, sentences: done, writerDone: new Set([1]) });
    const answer = await result;

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-2#1`, `${RUN_ID}:writer-2#2`]);
    expect(chunks.map((c) => c.chunk)).toEqual([2]);
    expect(answer.sentences.size).toBe(30);
    expect(answer.sentences.get(1)).toBe("Earlier.");
  });

  test("a chunk whose every id is already used fails without sending anything", async () => {
    const used = { type: "reserve" as const, attemptId: "x", jobId: "job-00000000", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST, at: "2026-09-24T12:00:00.000Z" };
    const { net, result } = start([], phaseOf(3, { ledger: { reserveOf: () => used, closeOf: () => undefined } }));
    const answer = await result;

    expect(answer).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
    expect(net.calls).toHaveLength(0);
    expect(money.lines()).toEqual([]);
  });

  test("a cancel before the first call sends nothing and says it was aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { net, result } = start([], phaseOf(3, { signal: controller.signal }));

    expect(await result).toMatchObject({ ok: false, stop: "cancelled" });
    expect(net.calls).toHaveLength(0);
  });

  test("a cancel mid-call leaves that attempt's reserve open at its worst case and asks nothing more", async () => {
    const controller = new AbortController();
    const hang: Step = () => ({ hang: true });
    const { net, result } = start([hang], phaseOf(30, { signal: controller.signal }));
    for (let i = 0; i < 100 && net.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    controller.abort(new Error("cancelled"));

    expect(await result).toMatchObject({ ok: false, stop: "cancelled" });
    expect(net.calls).toHaveLength(1);
    expect(money.budget.status()).toMatchObject({ openAttempts: 1, openReserveMicros: ATTEMPT_WORST });
  });

  test("a 401 ends the phase at once as fatal, without the chunk's second attempt", async () => {
    const { net, result } = start([{ status: 401, body: { error: { message: "No auth credentials found" } } }], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "AUTH_INVALID" } });
    expect(net.calls).toHaveLength(1);
  });

  test("a moderation refusal of the writer's prompt is final: exhausted, MODERATION_REFUSED, no spare id is ever used on it (review round 3, L-b)", async () => {
    const refusal: Step = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
    const { net, result } = start([refusal], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "exhausted", error: { code: "MODERATION_REFUSED" } });
    expect(net.calls).toHaveLength(1);
  });

  test("a 400 that is not a moderation refusal is our bug: the phase stops, without the chunk's next attempt", async () => {
    const { net, result } = start([{ status: 400, body: { error: { message: "response_format is invalid" } } }], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "INTERNAL" } });
    expect(net.calls).toHaveLength(1);
  });

  test("every call takes a network slot and gives it back", async () => {
    const pool = new NetworkPool({ max: 1 });
    const { result } = start([good, good], phaseOf(30), { pool });
    await result;
    expect(pool.active).toBe(0);
  });
});

// CS.1: the call shape and the messages are the caller's. A run passes exactly
// today's values, so what a built-in run sends must not move by one byte.
describe("runWriterPhase: a built-in run's requests are byte-identical to main 3a9cd498", () => {
  const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const fixture: { bodies: string[]; reserves: { attemptId: string; worstMicros: number; model: string }[] } = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "writer-main-3a9cd498.json"), "utf8"),
  );

  test("every request body, attempt id and reserve of a 30-slot run over all five categories, one chunk asked twice", async () => {
    const run = buildRunPlan({
      runId: RUN_ID,
      avatarId: "avatar-0001",
      createdAt: "2026-09-24T12:00:00.000Z",
      request: { avatarId: "avatar-0001", count: 30, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: true, back: true } },
      imageAgeCheck: "off",
      models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
      capMicros: 10_000_000,
      plannedWorstMicros: 10_000_000,
      scenes: plan({ seed: 3, count: 30, categories: ["home", "travel", "photoshoot", "glamour", "fitness"], poses: { profile: true, back: true } }),
    });
    const phase = { ...phaseOf(30), slots: plannedSlots(run), chunks: run.writerChunks, ...runWriterConfig(run.categories) };
    const { net, result } = start([refusedAnswer, good, good], phase);

    expect((await result).ok).toBe(true);
    expect(net.calls.map((c) => sha(c.json()))).toEqual(fixture.bodies);
    const reserved = money.lines().flatMap((l) => (l.type === "reserve" ? [{ attemptId: l.attemptId, worstMicros: l.worstMicros, model: l.model }] : []));
    expect(reserved).toEqual(fixture.reserves);
  });
});

describe("runWriterPhase: the call shape and the messages are the caller's", () => {
  test("the ceilings go into the request and the reserve, and the attempts a chunk may use end it", async () => {
    const base = phaseOf(3);
    const { net, result } = start([refusedAnswer, good], { ...base, call: { maxTokens: 3_000, inputTokens: 5_000, maxAttempts: 1 } });
    const answer = await result;

    expect(answer).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.json().max_tokens).toBe(3_000);
    const reserve = money.lines().find((l) => l.type === "reserve");
    expect(reserve?.worstMicros).toBeLessThan(ATTEMPT_WORST);
  });

  test("more attempts than today's are used when the caller allows them", async () => {
    const { net, result } = start([refusedAnswer, refusedAnswer, good], { ...phaseOf(3), call: { maxTokens: 8_000, inputTokens: 14_000, maxAttempts: 3 } });
    expect((await result).ok).toBe(true);
    expect(net.calls).toHaveLength(3);
  });

  test("the messages builder is asked for each attempt with the chunk's slots and why the last answer was rejected", async () => {
    const asked: { slots: number[]; feedback: string[] | undefined }[] = [];
    const base = phaseOf(3);
    const messages: WriterPhase["messages"] = (slots, feedback) => {
      asked.push({ slots: slots.map((s) => s.slotIndex), feedback: feedback?.problems });
      return [
        { role: "system", content: "marker-system" },
        { role: "user", content: `Slots:\n${JSON.stringify(slots.map((s) => ({ slotIndex: s.slotIndex })))}` },
      ];
    };
    const { net, result } = start([refusedAnswer, good], { ...base, messages });

    expect((await result).ok).toBe(true);
    expect(asked).toEqual([
      { slots: [1, 2, 3], feedback: undefined },
      { slots: [1, 2, 3], feedback: ["missing-slots"] },
    ]);
    expect(JSON.stringify(net.calls[0]?.json())).toContain("marker-system");
  });

  test("a custom category's label reaches the request, from the plan's own snapshot", async () => {
    const custom = CUSTOM_REF;
    const snapshot = customSnapshot();
    const run = buildRunPlan({
      runId: RUN_ID,
      avatarId: "avatar-0001",
      createdAt: "2026-10-05T12:00:00.000Z",
      request: { avatarId: "avatar-0001", count: 3, categories: [custom], poses: { profile: false, back: false } },
      categories: [snapshot],
      imageAgeCheck: "off",
      models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
      capMicros: 10_000_000,
      plannedWorstMicros: 10_000_000,
      scenes: planWithPools({ seed: 4, count: 3, categories: [custom] }, { ...POOLS, [custom]: CUSTOM_POOL }),
    });
    const { net, result } = start([good], { ...phaseOf(3), slots: plannedSlots(run), chunks: run.writerChunks, ...runWriterConfig(run.categories) });

    expect((await result).ok).toBe(true);
    const text = JSON.stringify(net.calls[0]?.json());
    expect(text).toContain("Paris cafes");
    expect(text).not.toContain(custom);
    expect(text).not.toContain("Кофейни");
  });
});

// Review H1/L10: an attempt that got no answer — a final 429, a 5xx after the
// transport retries, a network error — stops the phase (and the run) for a
// resume instead of taking the chunk's next id at once; the chunk keeps its
// two answered attempts for a later job, so two such failures never close it.
describe("runWriterPhase: failures that are no answer", () => {
  const rateLimited: Step = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };
  const unavailable: Step = { status: 503, body: { error: { message: "upstream unavailable" } } };
  const offline: Step = { reject: new TypeError("fetch failed") };

  test("a final 429 with Retry-After 120 s stops the phase at once, keeping the wait, under one id", async () => {
    const { net, result } = start([rateLimited], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "RATE_LIMITED", retryAfterMs: 120_000 } });
    expect(net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`]);
  });

  test("three 503s in a row are one attempt's transport retries: the phase stops under one id", async () => {
    const { net, result } = start([unavailable, unavailable, unavailable], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "NETWORK" } });
    expect(net.calls).toHaveLength(3);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`]);
  });

  test("a fetch that rejects stops the phase under one id, its reserve left open at its worst case", async () => {
    const { net, result } = start([offline], phaseOf(3));
    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "NETWORK" } });
    expect(net.calls).toHaveLength(1);
    expect(money.budget.status()).toMatchObject({ openAttempts: 1, openReserveMicros: ATTEMPT_WORST });
  });

  test("two such failures in two jobs still leave the chunk its answer: a third job writes it under the next id", async () => {
    const first = start([unavailable, unavailable, unavailable], phaseOf(3));
    expect(await first.result).toMatchObject({ ok: false, stop: "stopped" });
    const second = start([offline], phaseOf(3));
    expect(await second.result).toMatchObject({ ok: false, stop: "stopped" });

    const third = start([good], phaseOf(3));
    expect((await third.result).ok).toBe(true);
    expect(reserveIds()).toEqual([1, 2, 3].map((n) => `${RUN_ID}:writer-1#${n}`));
  });

  test("answered attempts are counted across jobs from the ledger: one rejected answer before the stop leaves one", async () => {
    const first = start([refusedAnswer, unavailable, unavailable, unavailable], phaseOf(3));
    expect(await first.result).toMatchObject({ ok: false, stop: "stopped" });

    const second = start([refusedAnswer], phaseOf(3));
    expect(await second.result).toMatchObject({ ok: false, stop: "exhausted" });
    expect(second.net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([1, 2, 3].map((n) => `${RUN_ID}:writer-1#${n}`));
  });

  test("a network error counts as answered (it may have been billed): after one, and one rejected answer, the chunk is done for", async () => {
    const first = start([offline], phaseOf(3));
    expect(await first.result).toMatchObject({ ok: false, stop: "stopped" });
    const second = start([refusedAnswer], phaseOf(3));
    expect(await second.result).toMatchObject({ ok: false, stop: "exhausted" });
  });
});
