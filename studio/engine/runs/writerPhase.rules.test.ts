import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AvatarTraits } from "../../shared/engine";
import type { Scope } from "../money/ledger";
import { WRITER_CALL } from "../money/estimate";
import { chatBody, fakeFetch, makeClient, setupMoney, withoutAt, type Money, type Step } from "../openrouter/testing/fakes";
import { plan, type PlanSlot } from "../scenes";
import { chunkSlots } from "../scenes/writer";
import { runWriterConfig, writerAttemptIds } from "./plan";
import { runWriterPhase, type WriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The scene writer's rules through its one chunk loop, runs/writerPhase.ts's
// runWriterPhase (moved here from scenes/writerJob.test.ts when the thin
// runWriterJob wrapper went away, T6 review round 3, L-f), with a run's own
// chunks and ids and nothing in the journal yet.
//
// T5b: the paid writer job. The plan's slots are split into chunks of at
// most WRITER_CALL.slotsPerCall (review round 2: RunRequest.count allows 1..100
// photos, possibly all in one category, and a single call for that many
// slots would blow both the prompt floor and max_tokens, and is unreliable
// besides); one chat call per chunk, reserving/settling through the
// OpenRouter client exactly like avatars/descriptorJob.ts (money is the
// client's own job, not this module's), at most WRITER_CALL.maxAttempts attempts
// per chunk, the second told why the first was rejected. Chunks run
// sequentially; the first chunk that exhausts its attempts fails the whole
// job, and every chunk settled so far stays settled.

const RUN_ID = "run-00000001";
const SCOPE: Scope = { runId: RUN_ID };

function slots(count = 2): PlanSlot[] {
  return plan({ seed: 20260924, count, categories: ["home", "fitness"] }).slots;
}

/** What the writer is given for a run: its ids, its scope and its slots — never the avatar. */
interface WriterRun {
  runId: string;
  jobId: string;
  scope: Scope;
  slots: readonly PlanSlot[];
  textModel: string;
  signal: AbortSignal;
}

function job(overrides: Partial<WriterRun> = {}): WriterRun {
  return {
    runId: RUN_ID,
    jobId: RUN_ID,
    scope: SCOPE,
    slots: slots(),
    textModel: "x-ai/grok-4.3",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** grok-4.3 fallback prices, WRITER_CALL's own ceiling (maxTokens 8_000, inputTokens 14_000, T5c round 2): 8_000 * $2.50/M + 14_000 * $1.25/M. */
const ATTEMPT_WORST = 37_500;

const GOOD_SELFIE = "She holds her phone in one hand and brushes a loose strand of hair back with the other, smiling softly at her reflection.";
const GOOD_OTHER = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const TWO_HANDED = "She raises her phone for a selfie, holding a cup of coffee with both hands, glancing warmly at the camera.";

function sentenceFor(slot: PlanSlot, twoHanded = false): string {
  if ((slot.shot === "selfie" || slot.shot === "mirror") && twoHanded) return TWO_HANDED;
  return slot.shot === "selfie" || slot.shot === "mirror" ? GOOD_SELFIE : GOOD_OTHER;
}

function goodOutput(theSlots: readonly PlanSlot[], badSlotIndex?: number): string {
  return JSON.stringify({
    scenes: theSlots.map((s) => ({ slotIndex: s.slotIndex, sentence: sentenceFor(s, s.slotIndex === badSlotIndex) })),
  });
}

function reply(content: string, cost = 0.0112): Step {
  return { status: 200, body: chatBody(content, { cost }) };
}

let money: Money;
/** Every phase a test started. A test that fails (or times out) on an assertion leaves its phase running: the ledger's folder must not be removed under it, and its late errors must not surface as "unhandled error between tests". */
let started: Promise<unknown>[] = [];
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  const running = started;
  started = [];
  await Promise.allSettled(running);
  await money.cleanup();
});

/** The phase a run starts with: every chunk of its plan with the plan's own ids, nothing written yet. */
function phaseFor(j: WriterRun): WriterPhase {
  return {
    jobId: j.jobId,
    scope: j.scope,
    textModel: j.textModel,
    signal: j.signal,
    slots: j.slots,
    chunks: chunkSlots(j.slots).map((chunk, i) => ({ chunk: i + 1, slotIndexes: chunk.map((s) => s.slotIndex), attemptIds: writerAttemptIds(j.runId, i + 1) })),
    sentences: new Map(),
    writerDone: new Set(),
    ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
    // What a run passes: today's call shape and messages (runs/plan.ts's runWriterConfig).
    ...runWriterConfig(undefined),
  };
}

function run(steps: Step[], j: WriterRun = job()) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const result = runWriterPhase(
    { chat: client.chat, budget: money.budget, priceBook: money.priceBook, acquire: async () => () => {}, onChunk: async () => {} },
    phaseFor(j),
  );
  started.push(result);
  return { net, result };
}

test("the happy path: one sentence per slot from a single settled attempt", async () => {
  const theSlots = slots(3);
  const { result } = run([reply(goodOutput(theSlots))], job({ slots: theSlots }));

  const outcome = await result;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("expected success");
  expect([...outcome.sentences.entries()]).toEqual(theSlots.map((s) => [s.slotIndex, sentenceFor(s)]));
  expect(withoutAt(money.lines())).toEqual([
    { type: "reserve", attemptId: `${RUN_ID}:writer-1#1`, jobId: RUN_ID, scope: SCOPE, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST },
    { type: "settle", attemptId: `${RUN_ID}:writer-1#1`, costMicros: 11_200, estimated: false },
  ]);
});

test("the request: the settings' text model, reasoning low, the strict JSON schema", async () => {
  const theSlots = slots(1);
  const { net, result } = run([reply(goodOutput(theSlots))], job({ slots: theSlots, textModel: "x-ai/grok-4.3" }));
  await result;

  expect(net.calls[0]?.json()).toMatchObject({
    model: "x-ai/grok-4.3",
    max_tokens: 8_000,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: "scene_sentences", strict: true } },
  });
});

test("a two-handed selfie/mirror sentence is asked again, and the retry names the slot", async () => {
  const theSlots = slots(4).filter((s) => s.shot === "selfie" || s.shot === "mirror").length > 0 ? slots(4) : slots(4);
  const badIndex = theSlots.find((s) => s.shot === "selfie" || s.shot === "mirror")?.slotIndex;
  if (badIndex === undefined) throw new Error("test plan has no selfie/mirror slot; adjust the seed or count");

  const { net, result } = run(
    [reply(goodOutput(theSlots, badIndex)), reply(goodOutput(theSlots))],
    job({ slots: theSlots }),
  );

  const outcome = await result;
  expect(outcome.ok).toBe(true);
  expect(net.calls).toHaveLength(2);
  const secondUser = JSON.stringify(net.calls[1]?.json());
  expect(secondUser).toContain("rejected");
  expect(secondUser).toContain(String(badIndex));
  expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId])).toEqual([
    ["reserve", `${RUN_ID}:writer-1#1`],
    ["settle", `${RUN_ID}:writer-1#1`],
    ["reserve", `${RUN_ID}:writer-1#2`],
    ["settle", `${RUN_ID}:writer-1#2`],
  ]);
});

test("a selfie/mirror sentence still two-handed after the retry fails the job; both attempts are settled and nothing is left open", async () => {
  const theSlots = slots(4);
  const badIndex = theSlots.find((s) => s.shot === "selfie" || s.shot === "mirror")?.slotIndex;
  if (badIndex === undefined) throw new Error("test plan has no selfie/mirror slot; adjust the seed or count");

  const { net, result } = run(
    [reply(goodOutput(theSlots, badIndex)), reply(goodOutput(theSlots, badIndex))],
    job({ slots: theSlots }),
  );

  const outcome = await result;
  expect(net.calls).toHaveLength(2);
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("hand");
  expect(money.lines().filter((l) => l.type === "settle")).toHaveLength(2);
  expect(money.ledger.openReserves()).toEqual([]);
});

test("a youth word fails the job after the retry", async () => {
  const theSlots = slots(2);
  const badOutput = JSON.stringify({
    scenes: theSlots.map((s, i) => ({ slotIndex: s.slotIndex, sentence: i === 0 ? "A young girl laughs by the window." : sentenceFor(s) })),
  });
  const { result } = run([reply(badOutput), reply(badOutput)], job({ slots: theSlots }));

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("girl");
  expect(money.lines().filter((l) => l.type === "settle")).toHaveLength(2);
});

test("a revealing word fails the job after the retry", async () => {
  const theSlots = slots(2);
  const badOutput = JSON.stringify({
    scenes: theSlots.map((s, i) => ({ slotIndex: s.slotIndex, sentence: i === 0 ? "She poses by the pool in a bikini." : sentenceFor(s) })),
  });
  const { result } = run([reply(badOutput), reply(badOutput)], job({ slots: theSlots }));

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain("bikini");
});

test("a missing slot fails the job after the retry", async () => {
  const theSlots = slots(3);
  const short = JSON.stringify({ scenes: theSlots.slice(1).map((s) => ({ slotIndex: s.slotIndex, sentence: sentenceFor(s) })) });
  const { result } = run([reply(short), reply(short)], job({ slots: theSlots }));

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  if (!outcome.ok) expect(outcome.error.detail).toContain(String(theSlots[0]?.slotIndex));
});

test("an extra, unknown slot index fails the job after the retry", async () => {
  const theSlots = slots(2);
  const extra = JSON.stringify({
    scenes: [...theSlots.map((s) => ({ slotIndex: s.slotIndex, sentence: sentenceFor(s) })), { slotIndex: 999, sentence: GOOD_OTHER }],
  });
  const { result } = run([reply(extra), reply(extra)], job({ slots: theSlots }));

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
});

test("a paid answer without content gets a second attempt", async () => {
  const theSlots = slots(1);
  const { net, result } = run(
    [{ status: 200, body: chatBody(null, { cost: 0.001, finishReason: "length" }) }, reply(goodOutput(theSlots))],
    job({ slots: theSlots }),
  );

  const outcome = await result;
  expect(outcome).toMatchObject({ ok: true });
  expect(net.calls).toHaveLength(2);
});

test("a moderation refusal is free and final: MODERATION_REFUSED, no second attempt", async () => {
  const { net, result } = run([{ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "MODERATION_REFUSED" } });
  expect(net.calls).toHaveLength(1);
  expect(money.lines().at(-1)).toMatchObject({ type: "settle", costMicros: 0 });
});

test("a request that got no response leaves the reserve open at its worst case", async () => {
  const { net, result } = run([{ reject: new TypeError("fetch failed") }]);

  expect(await result).toMatchObject({ ok: false, error: { code: "NETWORK" } });
  expect(net.calls).toHaveLength(1);
  expect(money.ledger.openReserves().map((r) => r.worstMicros)).toEqual([ATTEMPT_WORST]);
});

test("a reserve the run cap refuses sends nothing: RUN_CAP_EXCEEDED", async () => {
  await money.cleanup();
  money = await setupMoney({ runCapMicros: ATTEMPT_WORST - 1 });
  const { net, result } = run([]);

  expect(await result).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  expect(net.calls).toHaveLength(0);
  expect(money.lines()).toEqual([]);
});

test("attempt ids are unique and follow `${runId}:writer-${chunkIndex}#N`", async () => {
  const theSlots = slots(4);
  const badIndex = theSlots.find((s) => s.shot === "selfie" || s.shot === "mirror")?.slotIndex;
  if (badIndex === undefined) throw new Error("test plan has no selfie/mirror slot; adjust the seed or count");

  const { result } = run([reply(goodOutput(theSlots, badIndex)), reply(goodOutput(theSlots))], job({ slots: theSlots }));
  await result;

  const attemptIds = money.lines().filter((l) => l.type === "reserve").map((l) => l.attemptId);
  expect(attemptIds).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-1#2`]);
  expect(new Set(attemptIds).size).toBe(attemptIds.length);
});

// Extends the network canary idea (studio/engine/engine.canary.test.ts): the
// writer only ever sees the plan's slots (the phase has no field for the
// avatar's traits or its free-text mood note at all), so no marker word from
// it can ever reach the writer's request body.
const MARKER_WORDS = ["zebra", "lantern", "marmalade"];

test("the writer's phase has no field an avatar's traits could hide behind, and no request carries a marker word", async () => {
  const theSlots = slots(3);
  const theJob = job({ slots: theSlots });

  const traits: AvatarTraits = {
    age: 25,
    ethnicity: "european",
    skinTone: "light-olive",
    hairColor: "chestnut",
    hairLength: "shoulder",
    hairTexture: "wavy",
    eyeColor: "hazel",
    build: "athletic",
    marks: [],
    vibe: MARKER_WORDS.join(" "),
  };
  expect(Object.keys(traits).some((key) => key in theJob || key in phaseFor(theJob))).toBe(false);

  const { net, result } = run([reply(goodOutput(theSlots))], theJob);
  await result;

  const text = net.calls.map((c) => JSON.stringify(c.json())).join("\n").toLowerCase();
  expect(MARKER_WORDS.some((word) => text.includes(word))).toBe(false);
});

// Review round 2: RunRequest.count (studio/shared/engine/state.ts) allows
// 1..100 photos, possibly all in one category, so a run's plan can hold far
// more than WRITER_CALL.slotsPerCall slots. The job splits it into chunks and
// runs them one call at a time.
describe("chunking (a run can hold more slots than one call can take)", () => {
  function chunksOf(theSlots: readonly PlanSlot[]): PlanSlot[][] {
    const chunks: PlanSlot[][] = [];
    for (let i = 0; i < theSlots.length; i += WRITER_CALL.slotsPerCall) chunks.push(theSlots.slice(i, i + WRITER_CALL.slotsPerCall));
    return chunks;
  }

  function twoChunks(): { theSlots: PlanSlot[]; chunk1: PlanSlot[]; chunk2: PlanSlot[] } {
    const theSlots = slots(WRITER_CALL.slotsPerCall + 5);
    const [chunk1, chunk2] = chunksOf(theSlots);
    if (!chunk1 || !chunk2 || chunk1.length !== WRITER_CALL.slotsPerCall || chunk2.length !== 5) {
      throw new Error("expected exactly two chunks of WRITER_CALL.slotsPerCall and 5 slots");
    }
    return { theSlots, chunk1, chunk2 };
  }

  function phoneInHandIndex(chunk: readonly PlanSlot[]): number {
    const found = chunk.find((s) => s.shot === "selfie" || s.shot === "mirror")?.slotIndex;
    if (found === undefined) throw new Error("chunk has no selfie/mirror slot; adjust the seed or count");
    return found;
  }

  test("a run over one chunk's worth of slots makes one call per chunk, in order, and merges every chunk's sentences", async () => {
    const { theSlots, chunk1, chunk2 } = twoChunks();

    const { net, result } = run([reply(goodOutput(chunk1)), reply(goodOutput(chunk2))], job({ slots: theSlots }));

    const outcome = await result;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(net.calls).toHaveLength(2);
    expect([...outcome.sentences.entries()]).toEqual(theSlots.map((s) => [s.slotIndex, sentenceFor(s)]));

    expect(withoutAt(money.lines()).map((l) => [l.type, l.attemptId])).toEqual([
      ["reserve", `${RUN_ID}:writer-1#1`],
      ["settle", `${RUN_ID}:writer-1#1`],
      ["reserve", `${RUN_ID}:writer-2#1`],
      ["settle", `${RUN_ID}:writer-2#1`],
    ]);
    expect(money.ledger.openReserves()).toEqual([]);
  });

  test("a chunk's own two-handed sentence is retried without touching another chunk's attempts", async () => {
    const { theSlots, chunk1, chunk2 } = twoChunks();
    const badIndex = phoneInHandIndex(chunk2);

    const { net, result } = run(
      [reply(goodOutput(chunk1)), reply(goodOutput(chunk2, badIndex)), reply(goodOutput(chunk2))],
      job({ slots: theSlots }),
    );

    const outcome = await result;
    expect(outcome.ok).toBe(true);
    expect(net.calls).toHaveLength(3);
    const secondChunkRetry = JSON.stringify(net.calls[2]?.json());
    expect(secondChunkRetry).toContain("rejected");
    expect(secondChunkRetry).toContain(String(badIndex));

    const attemptIds = money.lines().filter((l) => l.type === "reserve").map((l) => l.attemptId);
    expect(attemptIds).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-2#1`, `${RUN_ID}:writer-2#2`]);
  });

  test("the first chunk that exhausts its attempts fails the whole job; a later chunk is never attempted", async () => {
    const { theSlots, chunk1 } = twoChunks();
    const badIndex = phoneInHandIndex(chunk1);

    const { net, result } = run([reply(goodOutput(chunk1, badIndex)), reply(goodOutput(chunk1, badIndex))], job({ slots: theSlots }));

    const outcome = await result;
    expect(net.calls).toHaveLength(2); // the second chunk is never attempted
    expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    if (!outcome.ok) expect(outcome.error.detail).toContain("hand");
    expect(money.lines().filter((l) => l.type === "settle")).toHaveLength(2);
    expect(money.ledger.openReserves()).toEqual([]);
  });

  test("a later chunk's exhausted failure still fails the job, but the earlier chunk's money stays settled", async () => {
    const { theSlots, chunk1, chunk2 } = twoChunks();
    const badIndex = phoneInHandIndex(chunk2);

    const { net, result } = run(
      [reply(goodOutput(chunk1)), reply(goodOutput(chunk2, badIndex)), reply(goodOutput(chunk2, badIndex))],
      job({ slots: theSlots }),
    );

    const outcome = await result;
    expect(net.calls).toHaveLength(3);
    expect(outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(money.lines().filter((l) => l.type === "settle")).toHaveLength(3);
    expect(money.ledger.openReserves()).toEqual([]);

    const firstChunkLines = money.lines().filter((l) => l.attemptId === `${RUN_ID}:writer-1#1`);
    expect(firstChunkLines.map((l) => l.type)).toEqual(["reserve", "settle"]);
  });

  test("the vibe marker never appears in any chunk's request, across a multi-chunk run", async () => {
    const { theSlots, chunk1, chunk2 } = twoChunks();

    const { net, result } = run([reply(goodOutput(chunk1)), reply(goodOutput(chunk2))], job({ slots: theSlots }));
    await result;

    const text = net.calls.map((c) => JSON.stringify(c.json())).join("\n").toLowerCase();
    expect(MARKER_WORDS.some((word) => text.includes(word))).toBe(false);
  });

  test("attempt ids stay unique and stable across chunks", async () => {
    const { theSlots, chunk1, chunk2 } = twoChunks();

    const { result } = run([reply(goodOutput(chunk1)), reply(goodOutput(chunk2))], job({ slots: theSlots }));
    await result;

    const attemptIds = money.lines().filter((l) => l.type === "reserve").map((l) => l.attemptId);
    expect(attemptIds).toEqual([`${RUN_ID}:writer-1#1`, `${RUN_ID}:writer-2#1`]);
    expect(new Set(attemptIds).size).toBe(attemptIds.length);
  });
});
