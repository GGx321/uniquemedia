import { describe, expect, test } from "bun:test";
import { fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { KEY, NOW, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.5e: the engine can read the OpenRouter balance for the launch preview (the orchestrator wires it in S4.6). It is a warning only:
// no key, no request; a failed read is null, never an error.

const dir = useEngineDir("studio-engine-balance-");

const CREDITS: Reply = { status: 200, body: { data: { total_credits: 20, total_usage: 1.2345 } } };

function creditsNetwork(reply: Reply) {
  const net = fakeFetch(Array.from({ length: 64 }, () => (call: FetchCall): Reply => (call.url.endsWith("/credits") ? reply : { reject: new TypeError("fetch failed") })));
  return { fetch: net.fetch, gets: () => net.calls.filter((c) => c.url.endsWith("/credits")), all: () => net.calls };
}

describe("Engine.readBalance", () => {
  test("answers total_credits minus total_usage, stamped with the engine clock", async () => {
    const net = creditsNetwork(CREDITS);
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    expect(await engine.readBalance()).toEqual({ micros: 18_765_500, asOf: new Date(NOW).toISOString() });
  });

  test("sends the stored key as a bearer token on a GET", async () => {
    const net = creditsNetwork(CREDITS);
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    await engine.readBalance();
    expect(net.gets().map((c) => [c.method, c.headers.Authorization === `Bearer ${KEY}`])).toEqual([["GET", true]]);
  });

  test("sends nothing and answers null without a key", async () => {
    const net = creditsNetwork(CREDITS);
    const { engine } = await startEngine(dir(), { key: null, deps: { fetch: net.fetch } });
    expect(await engine.readBalance()).toBeNull();
    expect(net.gets()).toEqual([]);
  });

  test("sends one GET for two reads inside a minute", async () => {
    const net = creditsNetwork(CREDITS);
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    await engine.readBalance();
    await engine.readBalance();
    expect(net.gets().length).toBe(1);
  });

  test("answers null, and does not throw, when the network fails", async () => {
    const net = creditsNetwork({ reject: new TypeError("fetch failed") });
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    expect(await engine.readBalance()).toBeNull();
  });

  test("answers null when /credits carries no total_credits", async () => {
    const net = creditsNetwork({ status: 200, body: { data: { total_usage: 1 } } });
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    expect(await engine.readBalance()).toBeNull();
  });

  test("a 401 marks the key rejected and later reads send nothing", async () => {
    const net = creditsNetwork({ status: 401, body: { error: { message: "No auth credentials found" } } });
    const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
    expect(await engine.readBalance()).toBeNull();
    expect(await engine.readBalance()).toBeNull();
    expect(net.gets().length).toBe(1);
  });
});
