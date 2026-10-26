import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writerAttemptWorstMicros, writerCallOf } from "../money/estimate";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import type { ChatParams } from "../openrouter/types";
import { plainSentence } from "../scenes";
import { categoryLabelOf } from "../scenes/categories";
import type { PlanSlot } from "../scenes/schema";
import { writerBoldMessages, writerMessages, writerModeOf } from "../scenes/writer";
import { NetworkPool } from "./pools";
import { plannedWriterConfig, runWriterPhase, writerCallShape, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA4, plan s5a4 §5.3.4 «The mode», r2.1 L3; the BA5a review's R2-L2): a writer chunk is asked in bold mode when a slot it sends the model is a «Смелая»
// frame, and then every attempt of that chunk sends the bold prompt and reserves the bold call's worst case: exactly what `writerAttemptWorstMicros` prices the
// mode's call at. A chunk of ordinary slots is asked exactly as before.

const RUN_ID = "run-00000001";
const CUSTOM = "cat-fixture-paris-cafes";
const LABEL = "Paris cafes";
const LACE_KEPT = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";

/** A custom category's «Смелая» slot (S5.BA3): on the route, with its world, from the shared «rooms» bank. */
const routed = (slotIndex: number, over: Partial<PlanSlot> = {}): PlanSlot => ({
  slotIndex,
  category: CUSTOM,
  location: "her room",
  timeOfDay: "evening",
  activity: "lies back across the bed",
  outfit: "a white lace bra and panties",
  shot: "selfie",
  pose: "front",
  attemptIdBase: `slot-${slotIndex}`,
  repeatedPair: false,
  capture: "above",
  level: "flirty",
  route: "seedream",
  world: "a cafe terrace in Paris",
  ...over,
});

/** The same category's slot stored before 5a.4: no route, no world. */
const unrouted = (slotIndex: number, over: Partial<PlanSlot> = {}): PlanSlot => ({
  slotIndex,
  category: CUSTOM,
  location: "a corner cafe",
  timeOfDay: "morning",
  activity: "sips a coffee",
  outfit: "a beige trench coat and jeans",
  shot: "friend",
  pose: "front",
  attemptIdBase: `slot-${slotIndex}`,
  repeatedPair: false,
  ...over,
});

/** A sentence each kind of slot passes its reader with. */
const SENTENCE: Record<"routed" | "unrouted", string> = {
  routed: "In her small hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons from the corner bakery on the nightstand.",
  unrouted: "At a corner cafe she sips a coffee in a beige trench coat and jeans, smiling at the viewer over the rim of her cup.",
};

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

/** The slots a request asked about (read from its own prompt). */
function askedIn(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

/** An answer that gives each slot asked about the sentence `sentenceOf` says. */
const answering =
  (sentenceOf: (slotIndex: number) => string): Step =>
  (call: FetchCall): Reply => ({ status: 200, body: chatBody(JSON.stringify({ scenes: askedIn(call).map((slotIndex) => ({ slotIndex, sentence: sentenceOf(slotIndex) })) }), { cost: 0.002 }) });

const systemOf = (call: FetchCall | undefined): string => {
  const messages = call?.json().messages;
  const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
  return typeof first === "object" && first !== null && "content" in first && typeof first.content === "string" ? first.content : "";
};

const ids = (chunk: number): string[] => Array.from({ length: 4 }, (_, i) => `${RUN_ID}:writer-${chunk}#${i + 1}`);

function phaseOf(slots: PlanSlot[], chunks: number[][], over: Partial<WriterPhase> = {}): WriterPhase {
  return {
    jobId: "job-00000001",
    scope: { runId: RUN_ID },
    textModel: "x-ai/grok-4.3",
    signal: new AbortController().signal,
    slots,
    chunks: chunks.map((slotIndexes, i) => ({ chunk: i + 1, slotIndexes, attemptIds: ids(i + 1) })),
    sentences: new Map(),
    writerDone: new Set(),
    ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
    ...plannedWriterConfig(categoryLabelOf([{ ref: CUSTOM, name: "Кофейни Парижа", label: LABEL, style: "phone" }])),
    ...over,
  };
}

async function runPhase(steps: Step[], phase: WriterPhase) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const params: ChatParams[] = [];
  const pool = new NetworkPool({ max: 6 });
  const result = await runWriterPhase(
    {
      chat: (p) => {
        params.push(p);
        return client.chat(p);
      },
      budget: money.budget,
      priceBook: money.priceBook,
      acquire: (signal) => pool.acquire(signal),
      onChunk: async () => undefined,
    },
    phase,
  );
  const reserves = money.lines().flatMap((l) => (l.type === "reserve" && typeof l.worstMicros === "number" ? [l.worstMicros] : []));
  return { result, net, params, reserves };
}

describe("writerModeOf: the mode of the slots a chunk sends the model (r2.1 L3)", () => {
  test("no «Смелая» frame: ordinary", () => {
    expect(writerModeOf([])).toBe("ordinary");
    expect(writerModeOf([unrouted(1), unrouted(2, { category: "home", level: "flirty" })])).toBe("ordinary");
  });

  test("a routed slot of any category, or a nightwear or beach slot with or without the route: bold", () => {
    expect(writerModeOf([routed(1)])).toBe("bold");
    expect(writerModeOf([unrouted(1, { category: "home", route: "seedream" })])).toBe("bold");
    expect(writerModeOf([unrouted(1, { category: "nightwear" })])).toBe("bold");
    expect(writerModeOf([unrouted(1, { category: "beach" })])).toBe("bold");
  });

  test("any one of them makes the chunk bold", () => {
    expect(writerModeOf([unrouted(1), unrouted(2), routed(3)])).toBe("bold");
  });
});

describe("plannedWriterConfig: the planned slots' writer in its two modes, through writerCallShape(mode)", () => {
  test("its own call and messages are the ordinary ones, byte for byte", () => {
    const config = plannedWriterConfig(categoryLabelOf([{ ref: CUSTOM, name: "x", label: LABEL, style: "phone" }]));
    expect<unknown>(config.call).toStrictEqual(writerCallShape("ordinary"));
    expect(config.messages([unrouted(1)], undefined)).toEqual(writerMessages([unrouted(1)], undefined, () => LABEL));
  });

  test("its bold mode is the bold call and the bold messages", () => {
    const config = plannedWriterConfig(categoryLabelOf([]));
    expect<unknown>(config.bold?.call).toStrictEqual(writerCallShape("bold"));
    expect(config.bold?.messages([routed(1)], undefined)).toEqual(writerBoldMessages([routed(1)]));
  });
});

describe("the writer phase asks each chunk in its own mode and reserves what the estimate prices it at", () => {
  test("a bold chunk sends the bold prompt and reserves writerAttemptWorstMicros of the bold call (48 750 µ$); an ordinary chunk, today's 37 500", async () => {
    const slots = [routed(1), routed(2), unrouted(3), unrouted(4)];
    const { result, net, params, reserves } = await runPhase([answering(() => SENTENCE.routed), answering(() => SENTENCE.unrouted)], phaseOf(slots, [[1, 2], [3, 4]]));
    expect(result.ok).toBe(true);
    expect(systemOf(net.calls[0])).toBe(writerBoldMessages([routed(1)])[0]?.content ?? "");
    expect(systemOf(net.calls[1])).toBe(writerMessages([unrouted(3)], undefined, () => LABEL)[0]?.content ?? "");
    expect(reserves).toEqual([writerAttemptWorstMicros(money.priceBook, writerCallOf("bold")), writerAttemptWorstMicros(money.priceBook, writerCallOf("ordinary"))]);
    expect(reserves).toEqual([48_750, 37_500]);
    expect(params.map((p) => p.reasoningTokens)).toEqual([3_000, undefined]);
    expect(params.map((p) => "reasoningTokens" in p)).toEqual([true, false]);
  });

  test("a chunk of only ordinary slots is asked exactly as a phase without a bold mode asks it", async () => {
    const slots = [unrouted(1), unrouted(2)];
    const withModes = await runPhase([answering(() => SENTENCE.unrouted)], phaseOf(slots, [[1, 2]]));
    const bodiesWith = withModes.net.calls.map((c) => c.json());
    await money.cleanup();
    money = await setupMoney();
    const { bold: _bold, ...ordinaryOnly } = phaseOf(slots, [[1, 2]]);
    const without = await runPhase([answering(() => SENTENCE.unrouted)], ordinaryOnly);
    expect(bodiesWith).toEqual(without.net.calls.map((c) => c.json()));
    expect(withModes.reserves).toEqual(without.reserves);
  });

  test("the mode is the chunk's, decided once: the repair that asks only an ordinary slot of a bold chunk is still bold", async () => {
    const slots = [routed(1), unrouted(2)];
    const firstAnswer = answering((slotIndex) => (slotIndex === 1 ? SENTENCE.routed : "At a corner cafe she sips a coffee in a lace bra and jeans, smiling at the viewer."));
    const { result, net, reserves } = await runPhase([firstAnswer, answering(() => SENTENCE.unrouted)], phaseOf(slots, [[1, 2]]));
    expect(result.ok).toBe(true);
    expect(net.calls.map(askedIn)).toEqual([[1, 2], [2]]);
    expect(net.calls.map(systemOf)).toEqual([writerBoldMessages(slots)[0]?.content, writerBoldMessages(slots)[0]?.content]);
    expect(reserves).toEqual([48_750, 48_750]);
  });

  test("a bold chunk's sentences carry the coverage once, the model's and the plain fallback's alike", async () => {
    const slots = [routed(1), routed(2)];
    // Slot 2 is refused twice (its moment split), so it takes the plain sentence; slot 1 is written by the model.
    const split = "She lies back in her small hotel room in Paris across the bed in a white lace bra and panties, a box of macarons on the nightstand.";
    const answer = answering((slotIndex) => (slotIndex === 1 ? SENTENCE.routed : split));
    const { result } = await runPhase([answer, answering(() => split)], phaseOf(slots, [[1, 2]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sentences.get(1)).toBe(`${SENTENCE.routed} ${LACE_KEPT}`);
    expect(result.sentences.get(2)).toBe(plainSentence(routed(2)));
    expect(result.sentences.get(2)).toStartWith("In her room, she lies back across the bed, wearing a white lace bra and panties");
    for (const sentence of result.sentences.values()) expect(sentence.split(LACE_KEPT)).toHaveLength(2);
  });

  test("a Studio-created avatar's bold chunk carries the open coverage (none for lace)", async () => {
    const { result } = await runPhase([answering(() => SENTENCE.routed)], phaseOf([routed(1)], [[1]], plannedWriterConfig(categoryLabelOf([]), true)));
    expect(result.ok && result.sentences.get(1)).toBe(SENTENCE.routed);
  });

  test("the slots the template writes do not decide the mode: a template-written nightwear slot beside an ordinary one leaves the chunk ordinary", async () => {
    const nightwear = unrouted(1, { category: "nightwear", location: "her bedroom" });
    const local = (slot: PlanSlot): string | null => (slot.slotIndex === 1 ? "She lies back against the pillows in a tee and cotton panties." : null);
    const { net, reserves } = await runPhase([answering(() => SENTENCE.unrouted)], phaseOf([nightwear, unrouted(2)], [[1, 2]], { local }));
    expect(net.calls.map(askedIn)).toEqual([[2]]);
    expect(systemOf(net.calls[0])).toBe(writerMessages([unrouted(2)], undefined, () => LABEL)[0]?.content ?? "");
    expect(reserves).toEqual([37_500]);
  });

  test("an old «Дом» set's flirty slots (no route) stay ordinary when the template cannot write them", async () => {
    const old = [unrouted(1, { category: "home", level: "flirty", location: "a place the bank no longer has" }), unrouted(2, { category: "home", level: "flirty", location: "another old place" })];
    const { net, reserves } = await runPhase([answering(() => "A friend catches her mid-laugh at the kitchen counter, smiling at the viewer.")], phaseOf(old, [[1, 2]]));
    expect(systemOf(net.calls[0])).not.toBe(writerBoldMessages(old)[0]?.content);
    expect(reserves).toEqual([37_500]);
  });
});
