import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { plan } from "../scenes";
import { buildRunPlan, plannedSlots, runWriterConfig } from "./plan";
import { NetworkPool } from "./pools";
import { runWriterPhase, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.6c1 (plan s5a2 r1.5 §5.5, M4): the seam between the code template and the LLM writer. `local(slot)` is a sentence or null; a chunk whose slots
// are all local is journaled with no call and no reserve, and before any chunk that needs the model; a mixed chunk sends only its null slots.

const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };
const LLM_SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

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

function askedSlots(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  const slots: { slotIndex: number }[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  return slots.map((s) => s.slotIndex);
}

function answerFor(call: FetchCall): Reply {
  const scenes = askedSlots(call).map((slotIndex) => ({ slotIndex, sentence: LLM_SENTENCE }));
  return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
}
const good: Step = (call) => answerFor(call);

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

const localText = (slotIndex: number): string => `Template sentence for slot ${slotIndex}.`;

function phaseOf(count: number, local: WriterPhase["local"], overrides: Partial<WriterPhase> = {}): WriterPhase {
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
    ...(local === undefined ? {} : { local }),
    ...overrides,
  };
}

function start(steps: Step[], phase: WriterPhase) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const chunks: { chunk: number; sentences: ReadonlyMap<number, string>; callsSoFar: number }[] = [];
  const pool = new NetworkPool({ max: 6 });
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

const reserveIds = (): string[] => money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));

/** Slots 1..3 and 26..30 are local: chunk 1 (slots 1..25) is mixed, chunk 2 (slots 26..30) is all local. */
const mixedLocal = (slot: { slotIndex: number }): string | null => (slot.slotIndex <= 3 || slot.slotIndex >= 26 ? localText(slot.slotIndex) : null);

describe("runWriterPhase: the local seam", () => {
  test("a phase whose slots are all local sends no request and reserves nothing", async () => {
    const { net, chunks, result } = start([], phaseOf(30, (slot) => localText(slot.slotIndex)));
    const answer = await result;

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.sentences.size).toBe(30);
    expect(answer.sentences.get(7)).toBe(localText(7));
    expect(net.calls).toHaveLength(0);
    expect(reserveIds()).toEqual([]);
    expect(chunks.map((c) => c.chunk)).toEqual([1, 2]);
  });

  test("a mixed chunk sends only the slots the template could not write", async () => {
    const { net, result } = start([good], phaseOf(30, mixedLocal));
    await result;

    expect(net.calls).toHaveLength(1);
    expect(askedSlots(net.calls[0] as FetchCall)).toEqual(Array.from({ length: 22 }, (_, i) => i + 4));
  });

  test("a mixed chunk is journaled whole: its template sentences beside the model's", async () => {
    const { chunks, result } = start([good], phaseOf(30, mixedLocal));
    await result;

    const mixed = chunks.find((c) => c.chunk === 1);
    expect(mixed?.sentences.size).toBe(25);
    expect(mixed?.sentences.get(2)).toBe(localText(2));
    expect(mixed?.sentences.get(10)).toBe(LLM_SENTENCE);
  });

  test("all-local chunks are journaled before a chunk that needs the model, with no call yet", async () => {
    const { chunks, result } = start([good], phaseOf(30, mixedLocal));
    await result;

    expect(chunks.map((c) => [c.chunk, c.callsSoFar])).toEqual([
      [2, 0],
      [1, 1],
    ]);
  });

  test("an all-local chunk takes no reserve: only the mixed chunk's id is on the ledger", async () => {
    const { result } = start([good], phaseOf(30, mixedLocal));
    await result;

    expect(reserveIds()).toEqual([`${RUN_ID}:writer-1#1`]);
  });

  test("a stop during the model's chunk leaves the template chunk journaled", async () => {
    const { chunks, result } = start([{ status: 400, body: { error: { message: "response_format is invalid" } } }], phaseOf(30, mixedLocal));
    const answer = await result;

    expect(answer).toMatchObject({ ok: false, stop: "stopped" });
    expect(chunks.map((c) => c.chunk)).toEqual([2]);
  });

  test("a resume skips a journaled chunk without asking the seam about it", async () => {
    const asked: number[] = [];
    const local: WriterPhase["local"] = (slot) => {
      asked.push(slot.slotIndex);
      return localText(slot.slotIndex);
    };
    const { chunks, result } = start([], phaseOf(30, local, { writerDone: new Set([2]), sentences: new Map([[26, "kept"]]) }));
    const answer = await result;

    expect(chunks.map((c) => c.chunk)).toEqual([1]);
    expect(asked.some((slotIndex) => slotIndex >= 26)).toBe(false);
    expect(answer.ok && answer.sentences.get(26)).toBe("kept");
  });

  test("a cancel journals no template chunk and says it was cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { chunks, result } = start([], phaseOf(30, (slot) => localText(slot.slotIndex), { signal: controller.signal }));

    expect(await result).toMatchObject({ ok: false, stop: "cancelled" });
    expect(chunks).toEqual([]);
  });

  test("a seam that is absent leaves every chunk to the model, as before", async () => {
    const { net, chunks, result } = start([good, good], phaseOf(30, undefined));
    await result;

    expect(net.calls).toHaveLength(2);
    expect(chunks.map((c) => c.chunk)).toEqual([1, 2]);
  });
});
