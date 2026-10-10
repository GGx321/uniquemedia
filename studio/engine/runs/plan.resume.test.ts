import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvatarDescriptor } from "../../shared/engine";
import { chatBody, fakeFetch, makeClient, setupMoney, asLibraryReference, JPEG, type FetchCall, type Money, type Reply } from "../openrouter/testing/fakes";
import { assembleRun, POOLS, roomPlaceOf, type PlanSlot } from "../scenes";
import { CAPTURE_LINE } from "../scenes/phoneLook";
import { plannedSlots, runWriterConfig, RunPlanSchema } from "./plan";
import { NetworkPool } from "./pools";
import { runWriterPhase } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1c (M2): `fixtures/plan-main-3a9cd498.json` is a plan.json written by main before Stage 5. It is NEVER re-pinned: a resume of it must keep working on the
// new code. It assembles with the new look; the places it names that the pools renamed get no room phrase; nothing throws; its two pending writer chunks
// are written by today's writer at their reserved ids.

const RAW: unknown = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "plan-main-3a9cd498.json"), "utf8"));
const RUN = RunPlanSchema.parse(RAW);
const SLOTS = plannedSlots(RUN);

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const MASTER = asLibraryReference(JPEG);
const SENTENCES = new Map(SLOTS.map((s) => [s.slotIndex, `She is just there for a moment (${s.slotIndex}).`]));
const assemble = (): ReturnType<typeof assembleRun> => assembleRun(DESCRIPTOR, RUN.scenes, SENTENCES, MASTER, { runId: RUN.runId, roomPlaceOf });
const promptOf = (index: number): string => assemble().find((a) => a.slotIndex === index)?.prompt ?? "";
const stillThere = (slot: PlanSlot): boolean => POOLS[slot.category as keyof typeof POOLS]?.locations.some((l) => l.name === slot.location) === true;

describe("a resume of the plan.json written by main 3a9cd498, on the Stage 5 code", () => {
  test("assembles all 30 slots without throwing", () => {
    expect(assemble()).toHaveLength(30);
  });

  test("assembles with the new look: the capture line first, the new binding, the artefact line, no old staging", () => {
    for (const slot of SLOTS) {
      const prompt = promptOf(slot.slotIndex);
      expect(prompt.startsWith(CAPTURE_LINE[slot.shot])).toBe(true);
      expect(prompt).toContain("the exact hair colour from the reference photo");
      expect(prompt).toContain("Ordinary phone photo");
      expect(prompt).not.toMatch(/Only she is in focus|full-frame|photographer|bokeh|studio lighting|golden hour/i);
    }
  });

  test("assembles the same prompts on a second resume (deterministic per run and slot)", () => {
    expect(assemble()).toEqual(assemble());
  });

  test("the plan has places the pools renamed (the fixture is a real old plan)", () => {
    expect(SLOTS.filter((s) => !stillThere(s)).length).toBeGreaterThanOrEqual(10);
  });

  test("a place renamed since the plan was made gets no room phrase, whatever it was", () => {
    for (const slot of SLOTS.filter((s) => !stillThere(s))) expect(promptOf(slot.slotIndex)).not.toContain("The room");
  });

  test("the old bedroom, kitchen and bathroom names are among the renamed ones", () => {
    const names = new Set(SLOTS.filter((s) => !stillThere(s)).map((s) => s.location));
    for (const old of ["a bright kitchen", "an unmade bed with white linen", "a bathroom with a large vanity mirror", "a studio with a seamless beige backdrop"]) expect(names.has(old)).toBe(true);
  });

  test("a place that kept its name and is a room still gets its room phrase (the home workout corner)", () => {
    const corner = SLOTS.find((s) => s.location === "a home workout corner");
    expect(corner).toBeDefined();
    expect(promptOf(corner?.slotIndex ?? 0)).toMatch(/ The room (is|looks) /);
  });

  test("still parses to the same document, so a resume re-journals prompts and nothing else about the plan moves", () => {
    expect<unknown>(RUN).toEqual(RAW);
  });
});

describe("the fixture's two pending writer chunks, written by today's writer", () => {
  let money: Money;
  beforeEach(async () => {
    money = await setupMoney();
  });
  afterEach(async () => {
    await money.cleanup();
  });

  const answer = (call: FetchCall): Reply => {
    const messages: unknown = call.json().messages;
    const user = Array.isArray(messages) ? messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user") : undefined;
    const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
    const slots: { slotIndex: number }[] = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    return { status: 200, body: chatBody(JSON.stringify({ scenes: slots.map((s) => ({ slotIndex: s.slotIndex, sentence: "She stops for a second by the counter." })) }), { cost: 0.0112 }) };
  };

  test("are asked under their reserved ids, with the old plan's own place names, and all 30 sentences come back", async () => {
    const net = fakeFetch([answer, answer]);
    const { client } = makeClient(net.fetch);
    const pool = new NetworkPool({ max: 6 });
    const result = await runWriterPhase(
      { chat: client.chat, budget: money.budget, priceBook: money.priceBook, acquire: (signal) => pool.acquire(signal), onChunk: async () => {} },
      {
        jobId: "job-00000001",
        scope: { runId: RUN.runId },
        textModel: "x-ai/grok-4.3",
        signal: new AbortController().signal,
        slots: SLOTS,
        chunks: RUN.writerChunks,
        sentences: new Map(),
        writerDone: new Set(),
        ledger: { reserveOf: (id) => money.ledger.reserveOf(id), closeOf: (id) => money.ledger.closeOf(id) },
        ...runWriterConfig(RUN.categories),
      },
    );

    expect(result.ok && result.sentences.size).toBe(30);
    const reserved = money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
    expect(reserved).toEqual(["run-00000001:writer-1#1", "run-00000001:writer-2#1"]);
    expect(JSON.stringify(net.calls[0]?.json())).toContain("a studio with a seamless beige backdrop");
  });
});
