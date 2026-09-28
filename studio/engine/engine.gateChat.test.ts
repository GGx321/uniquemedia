import { describe, expect, test } from "bun:test";
import type { Budget } from "./money/budget";
import { PriceBook } from "./money/prices";
import type { ChatParams } from "./openrouter/types";
import { engineSettings, KEY, generate, jobIdOf, network, seedDraft, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T7a: `Engine.gateChat` is the one way a QA gate that needs its own paid
// OpenRouter call (the age gate) can reach the engine's client — built once,
// per call, from whichever key is current: a gate is wired in through
// `EngineDeps.qaGates` before `Engine.start` even returns, so before this
// engine has any key at all (it arrives later, over a control message, and
// can rotate over the engine's life). See runs/ageGate.ts's own header for
// the full story.
//
// A bare scope has no registered cap (Budget.tryReserve refuses it at 0), so
// this test borrows a real, live scope: a candidate job whose own image call
// hangs forever, keeping its avatarJobId's cap registered in the engine for
// the length of the test.

const dir = useEngineDir("studio-engine-gate-chat-");

function usableBudget(budget: Budget | null): Budget {
  if (budget === null) throw new Error("expected the engine to have an open ledger");
  return budget;
}

function chatParams(budget: Budget, scope: ChatParams["scope"], overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    attemptId: "gate-attempt#1:age",
    jobId: "gate-job-1",
    scope,
    model: "x-ai/grok-4.3",
    messages: [{ role: "user", content: "is this an adult?" }],
    jsonSchema: { name: "age_check", schema: {} }, // routes through network()'s own age handler
    maxTokens: 1_000,
    inputTokens: 2_000,
    reasoningEffort: "low",
    budget,
    priceBook: PriceBook.fallback(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("Engine.gateChat", () => {
  test("sends the request with the current key and returns the answer", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: () => ({ hang: true }) });
    // Network concurrency 1: only the first of the batch's 4 slots reserves
    // (its image and its held age check), leaving the scope's cap with room
    // for this test's own extra age-shaped request.
    const { engine } = await startEngine(dir(), { net, init: { settings: engineSettings(dir(), { concurrency: { network: 1 } }) } });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    for (let i = 0; i < 1000 && net.imageCalls().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    if (net.imageCalls().length === 0) throw new Error("timed out waiting for the candidate batch's first image request");

    const result = await engine.gateChat(chatParams(usableBudget(engine.budget), { avatarJobId: jobId }));

    expect(result.status).toBe("ok");
    expect(net.ageCalls()).toHaveLength(1);
    expect(net.ageCalls()[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test("throws when there is no usable key: the gate cannot run at all", async () => {
    // #usableKey is checked before the scope's own cap, so a bare (unregistered) scope is fine here.
    const { engine } = await startEngine(dir(), { key: null });

    await expect(engine.gateChat(chatParams(usableBudget(engine.budget), { runId: "run-1" }))).rejects.toThrow();
  });
});
