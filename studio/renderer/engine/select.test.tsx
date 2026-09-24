import { afterEach, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "../App";
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

test("the dev build uses the mock while the preload has no request", () => {
  expect(chooseEngineClient(true, demo).kind).toBe("mock");
});

test("the real bridge wins in any build", () => {
  Reflect.set(window, "studio", { request: async () => null, subscribe: () => () => {}, version: async () => "1.0.0" });
  expect(chooseEngineClient(true, demo).kind).toBe("window");
  expect(chooseEngineClient(false, demo).kind).toBe("window");
});

test("without an engine the app says so plainly and offers no retry that cannot help", async () => {
  render(<App client={chooseEngineClient(false, demo)} />);
  expect(await screen.findByText("Движок недоступен")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
});

test("each mock client numbers its own messages", async () => {
  const a = new MockEngine({ scheduler: new ManualScheduler() });
  const b = new MockEngine({ scheduler: new ManualScheduler() });
  await mockEngineClient(a).request("money.status", {});
  await mockEngineClient(b).request("money.status", {});
  expect(a.calls[0]?.id).toBe(b.calls[0]?.id ?? "");
});
