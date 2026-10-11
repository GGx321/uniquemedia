import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { plan, type ReadableSlot } from "../scenes";
import { ideaJsonSchema, ideaMessages, readIdeaAnswer, toIdeaSlot, type IdeaAsk } from "../scenes/ideaWriter";
import { plainSentence } from "../scenes/plainSentence";
import { buildRunPlan, plannedSlots, runWriterConfig } from "./plan";
import { NetworkPool } from "./pools";
import { runWriterPhase, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6d, plan s5a2 §5.5): per-slot repair and the plain fallback in the chunk loop. Attempt 2 asks only the slots attempt 1 marked (with today's reason
// text) and keeps the accepted ones; after a refusal of the whole answer it is the whole chunk; after the last attempt a planned slot takes the plain
// sentence, while an idea write keeps the scenes it accepted and the rest stay unwritten.

const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const GOOD = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const REPAIRED = "She laughs at the kitchen counter while a friend pours the tea.";
const REVEALING = "She lounges by the pool in a bikini, laughing.";
const YOUTH = "A young girl laughs at the kitchen counter.";

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
    scenes: plan({ seed: 11, count, categories: ["home"] }),
  });
}

function userContent(call: FetchCall): string {
  const messages = Array.isArray(call.json().messages) ? (call.json().messages as unknown[]) : [];
  const user = messages.find((m) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  return typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
}

/** The slots a request asks about: the JSON list after the heading, before the rejection note (which has brackets of its own). */
function askedSlots(call: FetchCall): number[] {
  const body = userContent(call).split("\n\nAn earlier answer was rejected")[0] ?? "";
  const slots: { slotIndex: number }[] = JSON.parse(body.slice(body.indexOf("[")));
  return slots.map((s) => s.slotIndex);
}

/** An answer for the slots the request asked about: `sentenceOf` says what each one is told. */
function answering(sentenceOf: (slotIndex: number) => string): Step {
  return (call): Reply => ({ status: 200, body: chatBody(JSON.stringify({ scenes: askedSlots(call).map((slotIndex) => ({ slotIndex, sentence: sentenceOf(slotIndex) })) }), { cost: 0.0112 }) });
}

const notJson: Step = { status: 200, body: chatBody("this is not the object", { cost: 0.002 }) };

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

const plainOf = (slot: Parameters<typeof plainSentence>[0]): string => plainSentence(slot);

function start<S extends ReadableSlot>(steps: Step[], phase: WriterPhase<S>) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const chunks: { chunk: number; sentences: ReadonlyMap<number, string> }[] = [];
  const pool = new NetworkPool({ max: 6 });
  const result = runWriterPhase<S>(
    {
      chat: client.chat,
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      onChunk: async (chunk, sentences) => {
        chunks.push({ chunk, sentences });
      },
    },
    phase,
  );
  return { net, chunks, result };
}

const reserveIds = (): string[] => money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));

describe("runWriterPhase: attempt 2 repairs only the marked slots", () => {
  test("asks only the slot attempt 1 got wrong, and keeps the accepted sentences", async () => {
    const { net, result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    const answer = await result;

    expect(net.calls).toHaveLength(2);
    expect(askedSlots(net.calls[0] as FetchCall)).toEqual([1, 2, 3, 4]);
    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([2]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect([...answer.sentences]).toEqual([[1, GOOD], [2, REPAIRED], [3, GOOD], [4, GOOD]]);
  });

  test("tells attempt 2 today's reason text for the slot, and names no other slot", async () => {
    const { net, result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    await result;

    const told = userContent(net.calls[1] as FetchCall);
    expect(told).toContain("An earlier answer was rejected: slot(s) 2 used a revealing word we do not allow: \"bikini\"");
    expect(told).toContain('"slotIndex":2');
    expect(told).not.toContain('"slotIndex":1');
  });

  test("asks several marked slots in slot order", async () => {
    const { net, result } = start([answering((n) => (n === 1 || n === 3 ? REVEALING : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([1, 3]);
  });

  test("a slot the answer lacks is asked again alone", async () => {
    const dropsSlotTwo: Step = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: askedSlots(call).filter((n) => n !== 2).map((slotIndex) => ({ slotIndex, sentence: GOOD })) }), { cost: 0.0112 }) });
    const { net, result } = start([dropsSlotTwo, answering(() => REPAIRED)], phaseOf(4));
    const answer = await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([2]);
    expect(answer.ok && answer.sentences.get(2)).toBe(REPAIRED);
  });

  test("the chunk is journaled once, whole, in slot order", async () => {
    const { chunks, result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    await result;

    expect(chunks.map((c) => [c.chunk, [...c.sentences.keys()]])).toEqual([[1, [1, 2, 3, 4]]]);
  });

  test("an item for a slot attempt 2 did not ask about is dropped, not counted as the answer", async () => {
    const answersEverySlot: Step = { status: 200, body: chatBody(JSON.stringify({ scenes: [1, 2, 3, 4].map((slotIndex) => ({ slotIndex, sentence: REPAIRED })) }), { cost: 0.0112 }) };
    const { result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answersEverySlot], phaseOf(4));
    const answer = await result;

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect([...answer.sentences]).toEqual([[1, GOOD], [2, REPAIRED], [3, GOOD], [4, GOOD]]);
  });

  test("the chunk's two attempts are its ids #1 and #2, each settled", async () => {
    const { result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    await result;

    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-1#2`]);
    expect(money.ledger.openReserves()).toEqual([]);
  });
});

describe("runWriterPhase: after a refusal of the whole answer attempt 2 is the whole chunk", () => {
  test("a youth word in one sentence refuses the answer whole: attempt 2 asks every slot", async () => {
    const { net, result } = start([answering((n) => (n === 2 ? YOUTH : GOOD)), answering(() => REPAIRED)], phaseOf(4));
    const answer = await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([1, 2, 3, 4]);
    expect(answer.ok && [...answer.sentences.values()]).toEqual([REPAIRED, REPAIRED, REPAIRED, REPAIRED]);
  });

  test("an answer that is not the JSON object refuses the answer whole", async () => {
    const { net, result } = start([notJson, answering(() => REPAIRED)], phaseOf(4));
    await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([1, 2, 3, 4]);
  });

  test("a paid answer without content refuses the answer whole", async () => {
    const empty: Step = { status: 200, body: chatBody(null, { cost: 0.001, finishReason: "length" }) };
    const { net, result } = start([empty, answering(() => REPAIRED)], phaseOf(4));
    await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([1, 2, 3, 4]);
  });

  test("a slot-level refusal followed by a whole-answer refusal keeps attempt 1's accepted slots and asks the marked ones again whole", async () => {
    const { net, result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => YOUTH)], phaseOf(4, { plain: plainOf }));
    const answer = await result;

    expect(askedSlots(net.calls[1] as FetchCall)).toEqual([2]);
    expect(answer.ok && answer.sentences.get(1)).toBe(GOOD);
  });
});

describe("runWriterPhase: after the last attempt a planned slot takes the plain sentence", () => {
  test("a slot still refused on attempt 2 takes the plain sentence; the accepted slots keep the model's", async () => {
    const phase = phaseOf(4, { plain: plainOf });
    const { net, result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REVEALING)], phase);
    const answer = await result;

    expect(net.calls).toHaveLength(2);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const slotTwo = phase.slots.find((s) => s.slotIndex === 2);
    if (slotTwo === undefined) throw new Error("no slot 2");
    expect(answer.sentences.get(2)).toBe(plainSentence(slotTwo));
    expect([1, 3, 4].map((n) => answer.sentences.get(n))).toEqual([GOOD, GOOD, GOOD]);
  });

  test("two refusals of the whole answer: every slot takes the plain sentence, after exactly two requests", async () => {
    const phase = phaseOf(4, { plain: plainOf });
    const { net, result } = start([notJson, notJson], phase);
    const answer = await result;

    expect(net.calls).toHaveLength(2);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect([...answer.sentences]).toEqual(phase.slots.map((s) => [s.slotIndex, plainSentence(s)]));
  });

  test("the plain chunk is journaled whole and both attempts are settled with nothing left open", async () => {
    const { chunks, result } = start([notJson, notJson], phaseOf(4, { plain: plainOf }));
    await result;

    expect(chunks.map((c) => [c.chunk, c.sentences.size])).toEqual([[1, 4]]);
    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-1#2`]);
    expect(money.ledger.openReserves()).toEqual([]);
  });

  test("without a plain fallback the chunk is exhausted as before", async () => {
    const { result } = start([answering((n) => (n === 2 ? REVEALING : GOOD)), answering(() => REVEALING)], phaseOf(4));

    expect(await result).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
  });

  test("a mixed chunk: the template's slots keep the template's text, only the slots the model failed take the plain sentence", async () => {
    const phase = phaseOf(4, { plain: plainOf, local: (slot) => (slot.slotIndex <= 2 ? `Template ${slot.slotIndex}.` : null) });
    const { net, result } = start([notJson, notJson], phase);
    const answer = await result;

    expect(askedSlots(net.calls[0] as FetchCall)).toEqual([3, 4]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.sentences.get(1)).toBe("Template 1.");
    expect(answer.sentences.get(2)).toBe("Template 2.");
    const slotThree = phase.slots.find((s) => s.slotIndex === 3);
    if (slotThree === undefined) throw new Error("no slot 3");
    expect(answer.sentences.get(3)).toBe(plainSentence(slotThree));
  });

  test("a chunk with no answered attempt left (both were paid by earlier jobs) sends nothing and takes the plain sentence", async () => {
    const reserve = { type: "reserve" as const, attemptId: "x", jobId: "job-00000000", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: 37_500, at: "2026-09-24T12:00:00.000Z" };
    const settle = { type: "settle" as const, attemptId: "x", costMicros: 11_200, estimated: false, at: "2026-09-24T12:00:00.000Z" };
    const phase = phaseOf(4, { plain: plainOf, ledger: { reserveOf: () => reserve, closeOf: () => settle } });
    const { net, result } = start([], phase);
    const answer = await result;

    expect(net.calls).toHaveLength(0);
    expect(answer.ok && answer.sentences.size).toBe(4);
    expect(reserveIds()).toEqual([]);
  });

  test("a chunk whose every id is already used takes the plain sentence without a request", async () => {
    const used = { type: "reserve" as const, attemptId: "x", jobId: "job-00000000", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: 37_500, at: "2026-09-24T12:00:00.000Z" };
    const release = { type: "release" as const, attemptId: "x", reason: "unsent", at: "2026-09-24T12:00:00.000Z" };
    const { net, result } = start([], phaseOf(4, { plain: plainOf, ledger: { reserveOf: () => used, closeOf: () => release } }));

    expect((await result).ok).toBe(true);
    expect(net.calls).toHaveLength(0);
  });

  test("a moderation refusal of the writer's prompt is still final and exhausted, whatever the fallback", async () => {
    const refusal: Step = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
    const { net, result } = start([refusal], phaseOf(4, { plain: plainOf }));

    expect(await result).toMatchObject({ ok: false, stop: "exhausted", error: { code: "MODERATION_REFUSED" } });
    expect(net.calls).toHaveLength(1);
  });

  test("a failure that is not an answer (a 401) still stops the phase, never the fallback", async () => {
    const { result } = start([{ status: 401, body: { error: { message: "No auth credentials found" } } }], phaseOf(4, { plain: plainOf }));

    expect(await result).toMatchObject({ ok: false, stop: "stopped", error: { code: "AUTH_INVALID" } });
  });

  test("a resumed chunk that already has an answered attempt asks the whole chunk once more, then falls back", async () => {
    const reserved = await money.budget.tryReserve({ attemptId: `${RUN_ID}:writer-1#1`, jobId: "job-00000000", scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: 37_500 });
    if (!reserved.ok) throw new Error("reserve refused");
    await money.budget.abandon(reserved.handle);
    const phase = phaseOf(4, { plain: plainOf });
    const { net, result } = start([notJson], phase);
    const answer = await result;

    expect(net.calls).toHaveLength(1);
    expect(askedSlots(net.calls[0] as FetchCall)).toEqual([1, 2, 3, 4]);
    expect(answer.ok && answer.sentences.get(1)).toBe(plainSentence(phase.slots[0] as (typeof phase.slots)[number]));
  });
});

describe("runWriterPhase: an idea write keeps the scenes it accepted", () => {
  const ideaSlot = (slotIndex: number): IdeaAsk => ({ slotIndex, idea: "a walk", shot: "friend", pose: "front", askShot: false, askPose: false });
  const ideaPhase = (overrides: Partial<WriterPhase<IdeaAsk>> = {}): WriterPhase<IdeaAsk> => {
    const run = runPlan(3);
    const slots = [10, 11, 12].map(ideaSlot);
    return {
      jobId: "job-00000001",
      scope: SCOPE,
      textModel: "x-ai/grok-4.3",
      signal: new AbortController().signal,
      slots,
      chunks: [{ chunk: 1, slotIndexes: [10, 11, 12], attemptIds: run.writerChunks[0]?.attemptIds ?? [] }],
      sentences: new Map(),
      writerDone: new Set(),
      ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
      call: runWriterConfig(undefined).call,
      jsonSchema: ideaJsonSchema(false, { shot: false, pose: false }),
      read: (content, asked) => readIdeaAnswer(content, asked.map(toIdeaSlot), false),
      messages: (asked, feedback) => ideaMessages(asked.map(toIdeaSlot), feedback, false),
      ...overrides,
    };
  };
  const ideaAnswer = (bad: readonly number[]): Step => (call) => ({
    status: 200,
    body: chatBody(JSON.stringify({ scenes: askedSlots(call).map((slotIndex) => ({ slotIndex, sentence: bad.includes(slotIndex) ? REVEALING : GOOD })) }), { cost: 0.0112 }),
  });

  test("attempt 2 asks only the scene attempt 1 got wrong", async () => {
    const { net, result } = start([ideaAnswer([11]), ideaAnswer([])], ideaPhase());
    const answer = await result;

    expect(net.calls).toHaveLength(2);
    const second = userContent(net.calls[1] as FetchCall);
    expect(second).toContain('"slotIndex": 11');
    expect(second).not.toContain('"slotIndex": 10');
    expect(answer.ok && answer.sentences.size).toBe(3);
  });

  test("with keepAccepted, a scene still refused after the last attempt stays unwritten and the accepted scenes are kept with their angles", async () => {
    const { net, result } = start([ideaAnswer([11]), ideaAnswer([11])], ideaPhase({ keepAccepted: true }));
    const answer = await result;

    expect(net.calls).toHaveLength(2);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect([...answer.sentences]).toEqual([[10, GOOD], [12, GOOD]]);
    expect(answer.unwritten).toEqual([11]);
    expect([...(answer.angles ?? new Map()).keys()]).toEqual([10, 12]);
  });

  test("without keepAccepted, the same answers end the write as before: exhausted", async () => {
    const { result } = start([ideaAnswer([11]), ideaAnswer([11])], ideaPhase());

    expect(await result).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
  });

  test("with keepAccepted but nothing accepted (two refusals of the whole answer) the write ends as today: exhausted", async () => {
    const { result } = start([notJson, notJson], ideaPhase({ keepAccepted: true }));

    expect(await result).toMatchObject({ ok: false, stop: "exhausted", error: { code: "INTERNAL" } });
  });
});
