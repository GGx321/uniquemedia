import { afterEach, expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { chooseEngineClient } from "./select";

const demo = () => mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() }));

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

test("a release build without the engine bridge never falls back to the mock", async () => {
  const client = chooseEngineClient(false, demo);
  expect(client.kind).toBe("unavailable");
  const reply = await client.request("engine.snapshot", {});
  expect(reply.ok).toBe(false);
});

test("the real bridge wins in any build", () => {
  Reflect.set(window, "studio", { request: async () => null, subscribe: () => () => {}, version: async () => "1.0.0" });
  expect(chooseEngineClient(true, demo).kind).toBe("window");
  expect(chooseEngineClient(false, demo).kind).toBe("window");
});

